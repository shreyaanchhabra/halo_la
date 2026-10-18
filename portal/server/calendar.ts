import fs from 'node:fs'
import path from 'node:path'
import { extractPlan } from './extract.ts'
import { parseAnswer } from './yesno.ts'
import { planTitle, startOfDay, whenLabel } from '../../shared/format.ts'
import type { GlassesState, Plan, PlanStatus, TranscriptLine } from '../../shared/calendar.ts'

// Plans from conversation to calendar (Flow C).
//
// Someone speaks. If a question is on screen, a short "yes" or "no" answers it. Otherwise the
// sentence is checked for a plan with a date and time ("I'll come Saturday at 2"). A plan is put
// to the patient as a question; their spoken yes adds it to the calendar, silence sends it to the
// family in the care portal.

export type Care = { patient: string; people: { name: string; relation: string }[] }

export type CalendarOptions = {
  apiKey: string
  dataDir: string // plans.json and transcripts.json live here; ':memory:' keeps everything in memory (tests)
  care: () => Care // who the patient and the family are, from halo.json
  notify?: () => void // tells open pages to reload
  answerWindowMs?: number
}

export type Outcome =
  | { kind: 'answer'; answer: 'yes' | 'no'; plan: Plan; line: TranscriptLine }
  | { kind: 'proposed' | 'queued'; plan: Plan; line: TranscriptLine }
  | { kind: 'duplicate' | 'ignored'; line: TranscriptLine; error?: string } // error: the model call failed, so a plan may have been missed

type Stored = { plans: Plan[]; present: string[] }

const DUPLICATE_WINDOW_MS = 30 * 60_000
const CONFLICT_WINDOW_MS = 60 * 60_000
const CONTEXT_LINES = 2
const CONTEXT_MAX_AGE_MS = 90_000
const RESOLVED_SHOW_MS = 6_000
const HEARD_SHOW_MS = 12_000
const MAX_LINES = 500
const NOTES: Record<string, string> = { ignored: 'Not a calendar plan', duplicate: 'Already on the calendar' }

export function createCalendar(o: CalendarOptions) {
  const answerWindowMs = o.answerWindowMs ?? 60_000
  const memory = o.dataDir === ':memory:'
  const plansFile = path.join(o.dataDir, 'plans.json')
  const linesFile = path.join(o.dataDir, 'transcripts.json') // shared with the patient page's live transcript
  const notify = o.notify ?? (() => {})

  const readJson = <T>(file: string, fallback: T): T => {
    try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { return fallback }
  }
  let db: Stored = memory ? { plans: [], present: [] } : readJson(plansFile, { plans: [], present: [] })
  let lines: TranscriptLine[] = memory ? [] : (() => { try { return JSON.parse(fs.readFileSync(linesFile, 'utf8')) } catch { return [] } })()
  let lastHeard: { text: string; note: string; at: number } | null = null

  function save() {
    if (!memory) {
      fs.mkdirSync(o.dataDir, { recursive: true })
      fs.writeFileSync(plansFile, JSON.stringify(db, null, 2))
    }
    notify()
  }
  function saveLines() {
    if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES)
    if (!memory) {
      fs.mkdirSync(o.dataDir, { recursive: true })
      fs.writeFileSync(linesFile, JSON.stringify(lines, null, 2))
    }
  }

  const asking = () => db.plans.filter(p => p.status === 'asked')
  const active = (p: Plan) => p.status === 'asked' || p.status === 'queued' || p.status === 'confirmed' || p.status === 'needs_approval'

  function settle(p: Plan, status: PlanStatus, now: Date, by?: Plan['confirmedBy']) {
    p.status = status
    p.resolvedAt = now.toISOString()
    if (by) p.confirmedBy = by
  }

  // Times out unanswered questions and brings up the next queued one
  function sweep(now = new Date()) {
    let changed = false
    for (const p of asking()) {
      if (now.getTime() - new Date(p.askedAt!).getTime() >= answerWindowMs) { settle(p, 'needs_approval', now); changed = true }
    }
    for (const p of db.plans.filter(x => x.status === 'queued')) {
      if (new Date(p.start).getTime() < startOfDay(now).getTime()) { settle(p, 'needs_approval', now); changed = true }
    }
    if (!asking().length) {
      const next = db.plans.filter(p => p.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      if (next) { next.status = 'asked'; next.askedAt = now.toISOString(); changed = true }
    }
    if (changed) save()
  }

  function findConflict(start: Date, allDay: boolean): string | undefined {
    if (allDay) return undefined
    return db.plans.find(p => p.status === 'confirmed' && !p.allDay && Math.abs(new Date(p.start).getTime() - start.getTime()) < CONFLICT_WINDOW_MS)?.id
  }

  function isDuplicate(start: Date, allDay: boolean): boolean {
    return db.plans.some(p => {
      if (!active(p) && p.status !== 'declined') return false
      const t = new Date(p.start)
      return allDay || p.allDay ? startOfDay(t).getTime() === startOfDay(start).getTime() : Math.abs(t.getTime() - start.getTime()) < DUPLICATE_WINDOW_MS
    })
  }

  // One thing was said. It may answer the question on screen, or contain a new plan (a statement like
  // "I'll come Saturday at 2", or a question like "Do you want to meet at 6?": either way the patient
  // is asked to confirm it before it is added).
  async function hear(text: string, speaker = 'unknown', now = new Date()): Promise<Outcome> {
    const out = await handle(text, speaker, now)
    lastHeard = { text: out.line.text, note: 'error' in out && out.error ? "Couldn't check that one" : NOTES[out.kind] ?? '', at: now.getTime() }
    notify()
    return out
  }

  async function handle(text: string, speaker: string, now: Date): Promise<Outcome> {
    sweep(now)
    const line: TranscriptLine = { id: crypto.randomUUID(), at: now.toISOString(), speaker, text: text.trim() }
    const context = lines.filter(l => now.getTime() - new Date(l.at).getTime() < CONTEXT_MAX_AGE_MS).slice(-CONTEXT_LINES)
    lines.push(line)
    saveLines()

    const answer = parseAnswer(line.text)
    const waiting = asking()[0]
    if (waiting && answer) {
      settle(waiting, answer === 'yes' ? 'confirmed' : 'declined', now, answer === 'yes' ? 'patient' : undefined)
      save()
      sweep(now)
      return { kind: 'answer', answer, plan: waiting, line }
    }

    let found
    try {
      found = await extractPlan(line, context, now, o.apiKey, o.care(), db.present)
    } catch (err) {
      console.error('[calendar] plan detection failed:', String(err))
      return { kind: 'ignored', line, error: String(err) }
    }
    if (!found) return { kind: 'ignored', line }
    if (isDuplicate(found.when.start, found.when.allDay)) return { kind: 'duplicate', line }

    const plan: Plan = {
      id: crypto.randomUUID(),
      activity: found.activity,
      who: found.who,
      start: found.when.start.toISOString(),
      allDay: found.when.allDay,
      status: waiting ? 'queued' : 'asked',
      createdAt: now.toISOString(),
      askedAt: waiting ? undefined : now.toISOString(),
      source: { lineId: line.id, quote: found.quote },
      conflictWith: findConflict(found.when.start, found.when.allDay),
    }
    db.plans.push(plan)
    save()
    return { kind: waiting ? 'queued' : 'proposed', plan, line }
  }

  // Stopgap until voice recognition names the speaker: the family says who is visiting
  function setPresent(names: string[]): string[] {
    db.present = [...new Set(names.map(n => n.trim()).filter(Boolean))]
    save()
    return db.present
  }

  // The patient answers with the buttons instead of their voice
  function patientAnswer(id: string, answer: 'yes' | 'no', now = new Date()): Plan | undefined {
    const p = db.plans.find(x => x.id === id && x.status === 'asked')
    if (!p) return undefined
    settle(p, answer === 'yes' ? 'confirmed' : 'declined', now, answer === 'yes' ? 'patient' : undefined)
    save()
    sweep(now)
    return p
  }

  // Family actions from the care portal
  function addManual(input: { activity: string; who?: string[]; start: string; allDay?: boolean }, now = new Date()): Plan {
    const plan: Plan = {
      id: crypto.randomUUID(),
      activity: input.activity.trim(),
      who: input.who ?? [],
      start: new Date(input.start).toISOString(),
      allDay: Boolean(input.allDay),
      status: 'confirmed',
      confirmedBy: 'family',
      createdAt: now.toISOString(),
      resolvedAt: now.toISOString(),
      conflictWith: findConflict(new Date(input.start), Boolean(input.allDay)),
    }
    db.plans.push(plan)
    save()
    return plan
  }

  function familyAction(id: string, action: 'approve' | 'reject', now = new Date()): Plan | undefined {
    const p = db.plans.find(x => x.id === id)
    if (!p) return undefined
    settle(p, action === 'approve' ? 'confirmed' : 'rejected', now, action === 'approve' ? 'family' : undefined)
    save()
    sweep(now)
    return p
  }

  function editPlan(id: string, patch: Partial<Pick<Plan, 'activity' | 'who' | 'start' | 'allDay'>>): Plan | undefined {
    const p = db.plans.find(x => x.id === id)
    if (!p) return undefined
    if (patch.activity !== undefined) p.activity = patch.activity.trim()
    if (patch.who !== undefined) p.who = patch.who
    if (patch.start !== undefined) p.start = new Date(patch.start).toISOString()
    if (patch.allDay !== undefined) p.allDay = patch.allDay
    save()
    return p
  }

  function deletePlan(id: string): boolean {
    const n = db.plans.length
    db.plans = db.plans.filter(p => p.id !== id)
    save()
    return db.plans.length < n
  }

  // What the glasses (and the patient page) need to draw right now
  function glassesState(now = new Date()): GlassesState {
    sweep(now)
    const asked = asking()[0]
    const sameDay = (p: Plan) => startOfDay(new Date(p.start)).getTime() === startOfDay(now).getTime()
    const confirmed = db.plans.filter(p => p.status === 'confirmed').sort((a, b) => a.start.localeCompare(b.start))
    const recent = db.plans
      .filter(p => p.resolvedAt && (p.status === 'confirmed' || p.status === 'declined') && p.confirmedBy !== 'family' && now.getTime() - new Date(p.resolvedAt).getTime() < RESOLVED_SHOW_MS)
      .sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!))[0]
    return {
      now: now.toISOString(),
      prompt: asked
        ? {
            id: asked.id,
            lines: ['Add to calendar?', planTitle(asked), whenLabel(asked, now), ...(asked.conflictWith ? ['Overlaps another plan'] : ['']), 'Say yes or no'],
            expiresAt: new Date(new Date(asked.askedAt!).getTime() + answerWindowMs).toISOString(),
          }
        : null,
      resolved: recent
        ? { id: recent.id, status: recent.status, text: recent.status === 'confirmed' ? `Added\n${planTitle(recent)}\n${whenLabel(recent, now)}` : 'OK, not added.' }
        : null,
      heard: lastHeard && !asked && !recent && now.getTime() - lastHeard.at < HEARD_SHOW_MS ? { text: lastHeard.text, note: lastHeard.note } : null,
      today: confirmed.filter(sameDay),
      upcoming: confirmed.filter(p => !p.allDay && new Date(p.start).getTime() > now.getTime() && new Date(p.start).getTime() - now.getTime() <= 60 * 60_000),
    }
  }

  return {
    hear, sweep, glassesState, setPresent, patientAnswer, addManual, familyAction, editPlan, deletePlan,
    plans: () => { sweep(); return db.plans },
    present: () => db.present,
    lines: () => lines.slice(-100),
    // test hooks
    _db: () => db,
    _lines: () => lines,
  }
}

export type Calendar = ReturnType<typeof createCalendar>
