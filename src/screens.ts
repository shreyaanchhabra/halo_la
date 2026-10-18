import type { GlassesState, Plan } from '../shared/calendar.ts'
import { dateLabel, planTitle, timeLabel } from '../shared/format.ts'

// What the glasses show. Pure functions of the current state, so they can be tested without glasses.
// The display is 576 x 288 with no font or alignment control: short lines, left aligned.

const MAX_CHARS = 34 // comfortably under the width of the display
const MAX_EVENTS = 4
const MAX_LINES = 10 // lines that fit on the display
const ONGOING_FOR_MS = 60 * 60_000 // an event stays on the today list for an hour after it starts

export type Mic = 'on' | 'paused' | 'off'

export type ScreenInput = {
  now: Date
  state: GlassesState | null // null: the server hasn't been reached yet
  online: boolean
  mic: Mic
  reminder: Plan | null // an event to remind about right now
  notice?: string | null // a message from this device, e.g. a clip that couldn't be sent
  debug?: string
}

export function fit(s: string, max = MAX_CHARS): string {
  const t = s.replace(/[\r\n\t]+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 3).trimEnd() + '...'
}

const header = (mic: Mic) => (mic === 'on' ? 'HALO  * listening' : mic === 'paused' ? 'HALO  paused' : 'HALO  mic unavailable')

function minutesUntil(p: Plan, now: Date) {
  return Math.max(1, Math.round((new Date(p.start).getTime() - now.getTime()) / 60_000))
}

export function inLabel(mins: number): string {
  if (mins < 60) return `in ${mins} min`
  const h = Math.round(mins / 60)
  return `in ${h} hour${h === 1 ? '' : 's'}`
}

// Up to two short lines of what was heard, then how HALO took it
function heardBlock(heard: GlassesState['heard']): string[] {
  if (!heard) return []
  const words = heard.text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if (line && line.length + w.length + 1 > MAX_CHARS) { lines.push(line); line = '' }
    line = line ? `${line} ${w}` : w
  }
  if (line) lines.push(line)
  const shown = lines.slice(0, 2).map(l => fit(l))
  if (lines.length > 2) shown[1] = fit(shown[1], MAX_CHARS - 3) + '...'
  return ['Heard:', ...shown, ...(heard.note ? [`(${heard.note})`] : [])]
}

function todayList(state: GlassesState, now: Date, room: number): string[] {
  const shown = state.today.filter(p => p.allDay || new Date(p.start).getTime() > now.getTime() - ONGOING_FOR_MS)
  if (!shown.length) return ['Nothing planned today.']
  const cap = Math.max(1, Math.min(MAX_EVENTS, room))
  const lines = shown.slice(0, cap).map(p => fit(`${p.allDay ? 'All day' : timeLabel(new Date(p.start))}  ${planTitle(p)}`))
  if (shown.length > cap) lines.push(`+${shown.length - cap} more`)
  return lines
}

export function buildScreen(i: ScreenInput): string {
  const out = ((): string[] => {
    if (i.mic === 'paused') return [header('paused'), '', 'Not listening.', '', 'Double-tap: resume', 'Tap: exit']
    if (!i.state) return i.online ? ['HALO', '', 'Starting...'] : ['HALO', '', "Can't reach the HALO server.", 'Trying again...']

    if (i.state.prompt) return [...i.state.prompt.lines.map(l => fit(l)), '', i.online ? '' : '(offline: answer may not reach HALO)'].filter((l, n, a) => l !== '' || a[n - 1] !== '')
    if (i.state.resolved) return i.state.resolved.text.split('\n').map(l => fit(l))
    if (i.reminder) {
      return ['Coming up', fit(planTitle(i.reminder)), `${timeLabel(new Date(i.reminder.start))}  (${inLabel(minutesUntil(i.reminder, i.now))})`]
    }
    // header, date, gap, "Today", then the events; whatever was heard goes underneath, so events give way to it
    const extra = i.notice ? [i.notice] : heardBlock(i.state.heard)
    const room = MAX_LINES - 4 - (extra.length ? extra.length + 1 : 0) - (i.online ? 0 : 2) - (i.debug ? 2 : 0) - 1
    return [header(i.mic), `${dateLabel(i.now)}, ${timeLabel(i.now)}`, '', 'Today', ...todayList(i.state, i.now, room), ...(extra.length ? ['', ...extra] : []), ...(i.online ? [] : ['', '(offline)'])]
  })()
  if (i.debug) out.push('', i.debug)
  return out.join('\n')
}
