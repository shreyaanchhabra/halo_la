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
  care?: CareCard | null // a family message or a dose that's due; stays until tapped
  debug?: string
}

export type CareCard =
  | { kind: 'message'; id: string; text: string }
  | { kind: 'dose'; medKey: string; slot: string; title: string; time: string; detail: string }

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

// Word-wraps to at most maxLines short lines, ending in "..." when it doesn't fit
export function wrap(text: string, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if (line && line.length + w.length + 1 > MAX_CHARS) { lines.push(line); line = '' }
    line = line ? `${line} ${w}` : w
  }
  if (line) lines.push(line)
  const shown = lines.slice(0, maxLines).map(l => fit(l))
  if (lines.length > maxLines) shown[maxLines - 1] = fit(shown[maxLines - 1], MAX_CHARS - 3) + '...'
  return shown
}

// Up to two short lines of what was heard, then how HALO took it
function heardBlock(heard: GlassesState['heard']): string[] {
  if (!heard) return []
  return ['Heard:', ...wrap(heard.text, 2), ...(heard.note ? [`(${heard.note})`] : [])]
}

function careScreen(card: CareCard): string[] {
  if (card.kind === 'message') return ['Message from family', '', ...wrap(card.text, 5), '', 'Tap: got it']
  const [h, m] = card.time.split(':').map(Number)
  const due = new Date(2000, 0, 1, h, m)
  return ['Time for your medicine', '', fit(card.title), ...wrap(card.detail, 2), `Due at ${timeLabel(due)}`, '', 'Tap: I took it']
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
    if (i.care) return careScreen(i.care)
    // header, date, gap, "Today", then the events; whatever was heard goes underneath, so events give way to it
    const extra = i.notice ? [i.notice] : heardBlock(i.state.heard)
    const room = MAX_LINES - 4 - (extra.length ? extra.length + 1 : 0) - (i.online ? 0 : 2) - (i.debug ? 2 : 0) - 1
    return [header(i.mic), `${dateLabel(i.now)}, ${timeLabel(i.now)}`, '', 'Today', ...todayList(i.state, i.now, room), ...(extra.length ? ['', ...extra] : []), ...(i.online ? [] : ['', '(offline)'])]
  })()
  if (i.debug) out.push('', i.debug)
  return out.join('\n')
}
