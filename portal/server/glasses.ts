import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { appointments, scheduleFor, ymd } from '../src/schedule'
import type { DoseLog, GlassesMessage, GlassesView, HaloData } from '../src/types'

// The glasses check in every few seconds; past this they count as offline
const ONLINE_MS = 2 * 60_000
const MAX_MESSAGES = 50
// Older doses aren't prompted on the glasses; taking them hours late could double up with the next one
const DUE_WINDOW_MS = 3 * 60 * 60_000

const readJson = <T>(file: string, fallback: T): T =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

export function createGlasses(file: string, notify: () => void) {
  let lastCheckIn = 0
  let offlineTimer: NodeJS.Timeout | undefined
  const messages = () => readJson<GlassesMessage[]>(file, [])
  const save = (list: GlassesMessage[]) => {
    fs.writeFileSync(file, JSON.stringify(list.slice(-MAX_MESSAGES), null, 2))
    notify()
  }
  const online = () => Date.now() - lastCheckIn < ONLINE_MS

  return {
    online,
    messages,
    add(text: string, handle: string): GlassesMessage {
      const m = { id: randomUUID(), text, handle, sentAt: new Date().toISOString() }
      save([...messages(), m])
      return m
    },
    // Returns the message only the first time it's marked seen
    markSeen(id: string): GlassesMessage | null {
      const list = messages()
      const m = list.find(x => x.id === id)
      if (!m || m.seenAt) return null
      m.seenAt = new Date().toISOString()
      save(list)
      return m
    },
    view(data: HaloData, doses: DoseLog[]): GlassesView {
      const wasOnline = online()
      lastCheckIn = Date.now()
      if (!wasOnline) notify()
      // Open pages learn the glasses went offline once the check-ins stop
      clearTimeout(offlineTimer)
      offlineTimer = setTimeout(notify, ONLINE_MS + 1_000)

      const now = new Date()
      const time = hhmm(now)
      const items = scheduleFor(data, now)
      const open = items.filter(i => i.kind !== 'medicine' || !doses.some(d => d.medKey === i.medKey && d.slot === i.slot))
      const due = open.find(i => i.kind === 'medicine' && i.time && i.time <= time
        && now.getTime() - new Date(`${i.slot!.replace(' ', 'T')}:00`).getTime() <= DUE_WINDOW_MS)
      const next = open.find(i => i.time && i.time > time)
      const today = ymd(now)
      const appointment = appointments(data).find(a => a.date > today || (a.date === today && (!a.time || a.time > time)))
      const unseen = messages().find(m => !m.seenAt)

      return {
        patientName: data.patient.name,
        message: unseen ? { id: unseen.id, text: unseen.text } : null,
        due: due ? { medKey: due.medKey!, slot: due.slot!, title: due.title, time: due.time!, detail: due.detail } : null,
        next: next ? { title: next.title, time: next.time!, kind: next.kind } : null,
        appointment: appointment ?? null,
      }
    },
  }
}

export type Glasses = ReturnType<typeof createGlasses>
