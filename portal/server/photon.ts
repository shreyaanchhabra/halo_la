import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { Photon } from '@photon-ai/api'
import { allMedicines, daysLeft, pillsLeft, refillDue, type MedEntry } from '../src/meds'
import { appointments, formatTime, scheduleFor, ymd } from '../src/schedule'
import type { DoseLog, DoseSource, GlassesMessage, HaloData, ImessageStatus, Medicine, PriceCheck, TextAlertKind, TextMessage } from '../src/types'
import { answerCaregiver, type CaregiverAction } from './ai'
import type { Glasses } from './glasses'
import { RefillError, type Refills } from './refills.ts'
import { formatCents } from '../../shared/refill-types.ts'
import { traceTask } from './sentry'

const POLL_MS = 3_000
const ALERT_MS = 30_000
const MISSED_AFTER_MIN = 30
// Doses older than this are not texted about, so a restart doesn't send a backlog
const MISSED_WINDOW_MIN = 3 * 60
const MAX_MESSAGES = 200

type Caregiver = { handle: string; spaceId: string; agentId: string; linkedAt: string; paused: boolean }

type State = {
  caregivers: Caregiver[]
  since: string
  handled: string[]
  alerts: Record<string, { at: string; kind: TextAlertKind; medKey: string }>
  // The doses each caregiver last reported by text, so "he didn't take it" can undo them
  marked?: Record<string, { medKey: string; slot: string }[]>
}

type Reply = { text: string; glassesId?: string }

// Same shape the page sees, but stored with the full handle
type StoredMessage = TextMessage

// The fields HALO reads from a Photon Message
type Incoming = {
  id: string
  status: string
  createdAt: string
  content: { type: string; format?: string; text?: string }
  sentBy: { kind: string; handle?: string }
  receivedBy?: { kind: string; id: string }
  space: { id: string; kind: string }
}

export type ImessageDeps = {
  projectId: string
  apiKey: string
  agentNumber: string
  groqKey: string
  stateFile: string
  messagesFile: string
  readData: () => HaloData
  saveData: (data: HaloData) => void
  readDoses: () => DoseLog[]
  readPrices: () => Record<string, PriceCheck>
  startPriceCheck: (key: string, med: Medicine, zip: string) => void
  setDose: (medKey: string, slot: string, taken: boolean, by?: DoseSource) => void
  glasses: Glasses
  refills: Refills // GoodRx refills the family approves here or in the portal
  notify: () => void
}

const readJson = <T>(file: string, fallback: T): T =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2))

const idempotencyKey = (...parts: string[]) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40)

export function maskHandle(handle: string) {
  const digits = handle.replace(/\D/g, '')
  if (digits.length >= 4 && !handle.includes('@')) return `(•••) •••-${digits.slice(-4)}`
  const [name, domain] = handle.split('@')
  return domain ? `${name.slice(0, 1)}•••@${domain}` : '•••'
}

export function formatNumber(e164: string) {
  const d = e164.replace(/\D/g, '')
  return d.length === 11 && d.startsWith('1') ? `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : e164
}

const money = (n: number) => `$${n.toFixed(2)}`
const medName = (e: MedEntry) => `${e.med.name} ${e.med.strength}`.trim()
const isGreeting = (text: string) => /^(hi|hello|hey|hiya|start|yo)\b[\s!.]*$/i.test(text.trim())
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const slotDate = (slot: string) => new Date(`${slot.replace(' ', 'T')}:00`)
// Doses up to an hour early can be marked, for pills given a little ahead of time
const EARLY_MS = 60 * 60_000
const RECENT_MS = MISSED_WINDOW_MIN * 60_000

function joinNames(names: string[]) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

export function createImessage(deps: ImessageDeps) {
  const photon = new Photon({ headers: { Authorization: `Bearer ${deps.apiKey}` } })
  let state = readJson<State>(deps.stateFile, {
    caregivers: [], since: new Date().toISOString(), handled: [], alerts: {},
  })
  let lastError: string | undefined
  let stopped = false
  const timers = new Set<NodeJS.Timeout>()

  const saveState = () => writeJson(deps.stateFile, state)
  const messages = () => readJson<StoredMessage[]>(deps.messagesFile, [])
  const logMessage = (m: StoredMessage) => {
    writeJson(deps.messagesFile, [...messages(), m].slice(-MAX_MESSAGES))
    deps.notify()
  }
  const setError = (err: unknown) => {
    const message = `Can't reach Photon: ${err instanceof Error ? err.message : String(err)}`
    if (message !== lastError) deps.notify()
    lastError = message
  }
  // A failed send stays visible on the page until a later send works
  let sendError: string | undefined
  const failed = (err: unknown): never => {
    sendError = `Couldn't answer or send a text: ${err instanceof Error ? err.message : String(err)}`
    deps.notify()
    throw err
  }

  // Shared iMessage lines reject threaded replies, so every text is a plain message in the Space
  async function send(c: Caregiver, text: string, key: string, extra?: Pick<TextMessage, 'alert' | 'glassesId'>) {
    await photon.projects.sendMessage({
      path: { id: deps.projectId },
      headers: { 'idempotency-key': idempotencyKey(key, c.handle) },
      body: { spaceId: c.spaceId, senderId: c.agentId, content: { type: 'text', format: 'plain', text } },
    })
    sendError = undefined
    logMessage({ at: new Date().toISOString(), direction: 'out', handle: c.handle, text, ...extra })
  }

  const typing = (c: Caregiver, on: boolean) =>
    photon.projects.setSpaceTyping({
      path: { id: deps.projectId, spaceId: c.spaceId },
      body: { senderId: c.agentId, typing: on },
    }).catch(() => {})

  // ---- What HALO knows when it answers ----

  function careRecord(): string {
    const data = deps.readData()
    const doses = deps.readDoses()
    const prices = deps.readPrices()
    const now = new Date()
    const today = ymd(now)
    const lines = [
      `Patient: ${data.patient.name || 'unknown'}`,
      `Now: ${now.toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
      '', "Today's schedule:",
    ]
    const items = scheduleFor(data, now)
    for (const i of items) {
      const taken = i.kind === 'medicine' && doses.find(d => d.medKey === i.medKey && d.slot === i.slot)
      const when = i.time ? `${formatTime(i.time)} (${i.time})` : 'All day'
      lines.push(i.kind === 'medicine'
        ? `- ${when} take ${i.title} [key ${i.medKey}]: ${taken ? `taken at ${clock(taken.at)}` : 'not taken yet'}`
        : `- ${when} ${i.title} (appointment)`)
    }
    if (!items.length) lines.push('- nothing scheduled')
    const lastGlasses = deps.glasses.messages().at(-1)
    lines.push('', `Patient's glasses: ${deps.glasses.online() ? 'connected' : 'offline'}.`
      + (lastGlasses ? ` Last message sent: "${lastGlasses.text}", ${lastGlasses.seenAt ? `seen at ${clock(lastGlasses.seenAt)}` : 'not seen yet'}.` : ''))

    lines.push('', 'Medicines:')
    for (const e of allMedicines(data)) {
      const left = pillsLeft(e, data, doses)
      const days = daysLeft(e, data, doses)
      const refill = deps.refills.state().refills.find(r => r.medKey === e.key && r.status !== 'cancelled' && r.status !== 'received')
      const p = prices[e.key]
      const best = p?.quotes?.[0]
      lines.push(`- key ${e.key}: ${medName(e)}, ${e.med.instructions}. Times: ${e.med.times.map(formatTime).join(', ') || 'none'}.`
        + ` Pills left: ${left ?? 'unknown'}${days != null ? ` (about ${days} days)` : ''}.`
        + `${refillDue(e, data, doses) ? ' Refill due.' : ''}`
        + `${refill ? ` Refill ${refill.status.replace('_', ' ')}${refill.quote ? `: ${formatCents(refill.quote.priceCents)} at ${refill.quote.pharmacy} on GoodRx` : ''}.` : ''}`
        + `${p?.status === 'checking' ? ' GoodRx check running.' : ''}`
        + `${best ? ` Cheapest on GoodRx: ${money(best.price)} at ${best.pharmacy}.` : ''}`)
    }
    if (!allMedicines(data).length) lines.push('- none yet')

    const upcoming = appointments(data).filter(a => a.date >= today).slice(0, 5)
    lines.push('', 'Upcoming appointments:', ...(upcoming.length
      ? upcoming.map(a => `- ${a.date}${a.time ? ` ${formatTime(a.time)}` : ''}: ${a.title}`) : ['- none']))
    const notes = data.prescriptions.flatMap(rx => rx.reading?.notes ?? [])
    lines.push('', "Doctor's notes:", ...(notes.length ? notes.map(n => `- ${n}`) : ['- none']))
    lines.push('', 'Family and visitors:', ...(data.people.length
      ? data.people.map(p => `- ${p.name} (${p.relation})`) : ['- none']))
    lines.push('', `Patient ZIP code: ${data.patient.zip || 'not set'}`)
    return lines.join('\n')
  }

  // The model only names a medicine and/or a time; the doses themselves come from today's schedule
  function markTaken(c: Caregiver, data: HaloData, medKey: string | null, time: string | null): string {
    const name = (data.patient.name || 'the patient').split(' ')[0]
    const doses = deps.readDoses()
    const now = new Date()
    const meds = scheduleFor(data, now).filter(i => i.kind === 'medicine' && i.slot && i.medKey && i.time)
    const isTaken = (i: typeof meds[number]) => doses.some(d => d.medKey === i.medKey && d.slot === i.slot)
    const matching = meds.filter(i => (!medKey || i.medKey === medKey) && (!time || i.time === time))
    if (!matching.length) return `I couldn't find that dose on ${name}'s schedule for today.`

    let allowed = matching.filter(i => slotDate(i.slot!).getTime() - now.getTime() <= EARLY_MS)
    if (!allowed.length) {
      const first = matching[0]
      return `${name}'s ${formatTime(first.time!)} ${first.title} isn't due yet, so I haven't marked it.`
    }
    // "He took his meds" means the recent doses, not ones skipped hours ago
    if (!medKey && !time) {
      allowed = allowed.filter(i => now.getTime() - slotDate(i.slot!).getTime() <= RECENT_MS)
      if (!allowed.length) return `Which dose do you mean? Try something like "he took his 9pm pills".`
    }
    let picked = allowed.filter(i => !isTaken(i))
    if (!picked.length) return `That's already marked as taken.`
    // "Gave him the Memantine" means the dose closest to now, not every open one today
    if (medKey && !time) {
      picked = [picked.reduce((a, b) =>
        Math.abs(slotDate(b.slot!).getTime() - now.getTime()) < Math.abs(slotDate(a.slot!).getTime() - now.getTime()) ? b : a)]
    }

    for (const i of picked) deps.setDose(i.medKey!, i.slot!, true, 'imessage')
    state.marked = { ...state.marked, [c.handle]: picked.map(i => ({ medKey: i.medKey!, slot: i.slot! })) }
    saveState()
    const times = [...new Set(picked.map(i => formatTime(i.time!)))]
    return `Got it. Marked ${joinNames(picked.map(i => i.title))} (${joinNames(times)}) as taken at ${clock(now.toISOString())}.`
  }

  function undoTaken(c: Caregiver): string {
    const last = state.marked?.[c.handle] ?? []
    const doses = deps.readDoses()
    const still = last.filter(m => doses.some(d => d.medKey === m.medKey && d.slot === m.slot && d.by === 'imessage'))
    if (!still.length) return "There's no dose from your texts to undo. You can change doses on the patient page."
    for (const m of still) deps.setDose(m.medKey, m.slot, false)
    state.marked = { ...state.marked, [c.handle]: [] }
    saveState()
    const data = deps.readData()
    const names = still.map(m => allMedicines(data).find(e => e.key === m.medKey)).filter(Boolean).map(e => medName(e!))
    return `Okay, ${joinNames(names) || 'that dose'} ${names.length > 1 ? 'are' : 'is'} back to not taken.`
  }

  function runAction(c: Caregiver, action: CaregiverAction): Reply | null {
    const data = deps.readData()
    const name = (data.patient.name || 'the patient').split(' ')[0]
    if (action.type === 'pause_alerts' || action.type === 'resume_alerts') {
      c.paused = action.type === 'pause_alerts'
      saveState()
      deps.notify()
      return {
        text: c.paused
          ? "Okay, I've paused alert texts. Text \"resume alerts\" to turn them back on."
          : `Alerts are back on. I'll text you if ${name} misses a dose or a refill comes due.`,
      }
    }
    if (action.type === 'mark_taken') return { text: markTaken(c, data, action.medKey, action.time) }
    if (action.type === 'undo_taken') return { text: undoTaken(c) }
    if (action.type === 'send_to_glasses') {
      const m = deps.glasses.add(action.text, c.handle)
      return {
        glassesId: m.id,
        text: `Sent to ${name}'s glasses: "${action.text}" `
          + (deps.glasses.online()
            ? `I'll text you when ${name} sees it.`
            : `The glasses look offline right now, so ${name} will see it when they reconnect.`),
      }
    }
    const entry = allMedicines(data).find(e => e.key === action.medKey)
    if (!entry) return null
    if (action.type === 'approve_refill') {
      const open = deps.refills.state().refills.find(r => r.medKey === entry.key && r.status === 'awaiting_approval' && r.quote)
      if (!open?.quote) return { text: `There is no ${medName(entry)} refill waiting for approval. I only ask once the GoodRx prices are in.` }
      try {
        const r = deps.refills.approve(open.id, { approvedBy: formatNumber(c.handle), expectedPriceCents: open.quote.priceCents })
        return {
          text: `Approved: ${r.quantity} tablets of ${medName(entry)} at ${r.quote!.pharmacy} for ${formatCents(r.quote!.priceCents)} with the GoodRx coupon. `
            + 'A pickup reminder is on the calendar. I have not bought anything, so pick it up there.',
        }
      } catch (err) {
        if (err instanceof RefillError) return { text: err.message }
        throw err
      }
    }
    const zip = data.patient.zip ?? ''
    if (!/^\d{5}$/.test(zip)) return { text: "I need the patient's ZIP code before I can check prices. Add it in the HALO portal." }
    deps.startPriceCheck(entry.key, entry.med, zip)
    return { text: `Checking GoodRx prices for ${medName(entry)} near ${zip}. I'll text you when they're in, usually in 1 to 3 minutes.` }
  }

  // Tells the caregiver who sent a glasses message that the patient saw it
  async function glassesSeen(m: GlassesMessage) {
    const c = state.caregivers.find(x => x.handle === m.handle)
    if (!c || !m.seenAt) return
    const name = (deps.readData().patient.name || 'The patient').split(' ')[0]
    await traceTask('Text that a message was seen', 'imessage.seen', () =>
      send(c, `${name} saw your message on the glasses at ${clock(m.seenAt!)}.`, `seen:${m.id}`).catch(failed))
  }

  async function handle(m: Incoming) {
    const text = m.content.text?.trim() ?? ''
    const handle = m.sentBy.handle ?? ''
    if (!text || !handle || !m.receivedBy) return

    logMessage({ at: m.createdAt, direction: 'in', handle, text })
    let c = state.caregivers.find(x => x.handle === handle)
    const isNew = !c
    if (!c) {
      c = { handle, spaceId: m.space.id, agentId: m.receivedBy.id, linkedAt: new Date().toISOString(), paused: false }
      state.caregivers.push(c)
      saveState()
    } else if (c.spaceId !== m.space.id || c.agentId !== m.receivedBy.id) {
      c.spaceId = m.space.id
      c.agentId = m.receivedBy.id
      saveState()
    }

    const name = (deps.readData().patient.name || 'your family member').split(' ')[0]
    if (isNew) {
      await send(c, `Hi, I'm HALO, ${name}'s care assistant. I'll text you here if a dose is missed or a refill is due. `
        + 'Ask me anything about meds, doses, or appointments.', `welcome:${m.id}`)
      if (isGreeting(text)) return
    }

    // Refill texts say "Reply approve", so a bare approve goes to the one waiting refill
    if (/^(approve|approved|yes approve)( (the )?refill)?[\s.!]*$/i.test(text)) {
      const waiting = deps.refills.state().refills.filter(r => r.status === 'awaiting_approval')
      if (waiting.length === 1) {
        await send(c, runAction(c, { type: 'approve_refill', medKey: waiting[0].medKey })!.text, `reply:${m.id}`)
        return
      }
    }

    if (!deps.groqKey) {
      await send(c, "I can't answer questions right now. Check the HALO portal for the latest.", `reply:${m.id}`)
      return
    }
    await typing(c, true)
    try {
      const history = messages()
        .filter(x => x.handle === handle && x.at < m.createdAt)
        .slice(-6)
        .map(x => ({ from: x.direction === 'in' ? 'caregiver' as const : 'halo' as const, text: x.text }))
      const { reply, action } = await answerCaregiver(deps.groqKey, careRecord(), history, text)
      const done = action ? runAction(c, action) : null
      await send(c, done?.text ?? (reply || "Sorry, I didn't catch that. Try asking about today's doses or the next appointment."),
        `reply:${m.id}`, done?.glassesId ? { glassesId: done.glassesId } : undefined)
    } finally {
      await typing(c, false)
    }
  }

  async function poll() {
    const startedAt = new Date().toISOString()
    // Re-read a minute back because results are eventually consistent; handled ids prevent repeats
    const createdSince = new Date(Date.parse(state.since) - 60_000).toISOString()
    let pageToken: string | undefined
    const fresh: Incoming[] = []
    do {
      const page = await photon.projects.listMessages({
        path: { id: deps.projectId },
        query: { createdSince, direction: 'received', order: 'asc', pageSize: 100, platform: 'imessage', ...(pageToken ? { pageToken } : {}) },
      })
      for (const item of page.items as unknown as Incoming[]) {
        if (state.handled.includes(item.id)) continue
        if (item.status !== 'received' || item.sentBy.kind !== 'human' || item.receivedBy?.kind !== 'agent') continue
        if (item.space.kind !== 'direct' || item.content.type !== 'text') continue
        fresh.push(item)
      }
      pageToken = page.nextPageToken
    } while (pageToken)

    for (const m of fresh) {
      state.handled = [...state.handled, m.id].slice(-500)
      saveState()
      await traceTask('Answer an iMessage', 'imessage.reply', () => handle(m).catch(failed))
    }
    state.since = startedAt
    saveState()
    if (lastError) {
      lastError = undefined
      deps.notify()
    }
  }

  // ---- Texts HALO sends on its own ----

  async function checkAlerts() {
    const listening = state.caregivers.filter(c => !c.paused)
    if (!listening.length) return
    const data = deps.readData()
    const doses = deps.readDoses()
    const prices = deps.readPrices()
    const now = new Date()
    const name = (data.patient.name || 'The patient').split(' ')[0]
    const due: { keys: string[]; kind: TextAlertKind; medKeys: string[]; text: string }[] = []

    // Doses missed around the same time go out as one text
    const missed: { key: string; medKey: string; label: string; late: number }[] = []
    for (const i of scheduleFor(data, now)) {
      if (i.kind !== 'medicine' || !i.time || !i.slot || !i.medKey) continue
      const late = (now.getTime() - new Date(`${i.slot.replace(' ', 'T')}:00`).getTime()) / 60_000
      if (late < MISSED_AFTER_MIN || late > MISSED_WINDOW_MIN) continue
      if (doses.some(d => d.medKey === i.medKey && d.slot === i.slot)) continue
      const key = `missed:${i.medKey}|${i.slot}`
      if (!state.alerts[key]) missed.push({ key, medKey: i.medKey, label: `${formatTime(i.time)} ${i.title}`, late })
    }
    if (missed.length === 1) {
      const [d] = missed
      due.push({
        keys: [d.key], kind: 'missed', medKeys: [d.medKey],
        text: `${name} hasn't marked the ${d.label} as taken yet. It was due ${Math.round(d.late)} minutes ago.`,
      })
    } else if (missed.length > 1) {
      const labels = missed.map(d => d.label)
      due.push({
        keys: missed.map(d => d.key), kind: 'missed', medKeys: missed.map(d => d.medKey),
        text: `${name} hasn't marked these doses as taken yet: ${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}.`,
      })
    }

    for (const e of allMedicines(data)) {
      // The family is asked once the errands agent has the GoodRx prices (never before, and never again for the same quote)
      const waiting = deps.refills.state().refills.find(r => r.medKey === e.key && r.status === 'awaiting_approval' && r.quote)
      if (waiting?.quote) {
        const others = waiting.quote.prices.length - 1
        due.push({
          keys: [`refill:${waiting.id}:${waiting.quote.expiresAt}`], kind: 'refill', medKeys: [e.key],
          text: `${medName(e)} is running low, about ${daysLeft(e, data, doses)} days left. Cheapest on GoodRx: ${formatCents(waiting.quote.priceCents)} at ${waiting.quote.pharmacy}`
            + `${others > 0 ? ` (${others} more pharmacies in the portal)` : ''}. I won't buy anything. Reply "approve" and I'll put a pickup reminder on the calendar.`,
        })
      }
      const p = prices[e.key]
      const fresh = p?.checkedAt && now.getTime() - Date.parse(p.checkedAt) < 30 * 60_000
      if (p?.status === 'done' && fresh && p.checkedAt) {
        const top = (p.quotes ?? []).slice(0, 3)
        due.push({
          keys: [`prices:${e.key}:${p.checkedAt}`], kind: 'prices', medKeys: [e.key],
          text: top.length
            ? `GoodRx prices for ${medName(e)} near ${p.zip}: ${top.map(q => `${q.pharmacy} ${money(q.price)}`).join(', ')}.`
            : `GoodRx didn't list prices for ${medName(e)} near ${p.zip}.${p.note ? ` ${p.note}` : ''}`,
        })
      }
    }

    for (const alert of due) {
      if (alert.keys.some(k => state.alerts[k])) continue
      alert.keys.forEach((k, i) => { state.alerts[k] = { at: now.toISOString(), kind: alert.kind, medKey: alert.medKeys[i] } })
      saveState()
      await traceTask('Send a care alert', 'imessage.alert', async () => {
        for (const c of listening) await send(c, alert.text, `alert:${alert.keys.join(',')}`, { alert: alert.kind }).catch(failed)
      })
    }
  }

  function loop(fn: () => Promise<void>, every: number) {
    const tick = async () => {
      if (stopped) return
      try {
        await fn()
      } catch (err) {
        setError(err)
      }
      if (stopped) return
      const timer = setTimeout(() => {
        timers.delete(timer)
        void tick()
      }, every)
      timers.add(timer)
    }
    void tick()
  }

  return {
    start() {
      loop(poll, POLL_MS)
      loop(checkAlerts, ALERT_MS)
    },
    stop() {
      stopped = true
      timers.forEach(clearTimeout)
      timers.clear()
    },
    checkAlerts: () => checkAlerts().catch(setError),
    glassesSeen: (m: GlassesMessage) => glassesSeen(m).catch(() => {}),
    status(): ImessageStatus {
      const alerts: ImessageStatus['alerts'] = {}
      for (const a of Object.values(state.alerts)) {
        if (!alerts[a.medKey] || alerts[a.medKey].at < a.at) alerts[a.medKey] = { kind: a.kind, at: a.at }
      }
      const seen = new Map(deps.glasses.messages().map(g => [g.id, g.seenAt]))
      return {
        configured: true,
        agentNumber: formatNumber(deps.agentNumber),
        glassesOnline: deps.glasses.online(),
        ...(lastError ?? sendError ? { error: lastError ?? sendError } : {}),
        caregivers: state.caregivers.map(c => ({ handle: maskHandle(c.handle), linkedAt: c.linkedAt, paused: c.paused })),
        messages: messages().slice(-30).map(m => {
          const seenAt = m.glassesId ? seen.get(m.glassesId) : undefined
          return { ...m, handle: maskHandle(m.handle), ...(seenAt ? { glassesSeenAt: seenAt } : {}) }
        }),
        alerts,
      }
    },
  }
}
