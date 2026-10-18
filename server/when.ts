import * as chrono from 'chrono-node'
import { startOfDay } from '../shared/format.ts'

export type When = {
  text: string // the words that said it, e.g. "Saturday at 2"
  start: Date
  allDay: boolean // only a date was said, no time
}

// People rarely say "2 AM" for a visit: with no am/pm, hours 1-7 mean the afternoon.
function guessMeridiem(r: chrono.ParsedResult): Date {
  const s = r.start
  const d = s.date()
  if (s.isCertain('hour') && !s.isCertain('meridiem')) {
    const h = s.get('hour')
    if (h !== null && h >= 1 && h <= 7) d.setHours(h + 12)
  }
  return d
}

// Finds dates and times in one utterance. "Saturday" said on a Saturday means next Saturday
// (forwardDate). Anything already in the past is dropped.
export function findWhen(text: string, ref: Date): When[] {
  const out: When[] = []
  for (const r of chrono.casual.parse(text, ref, { forwardDate: true })) {
    const allDay = !r.start.isCertain('hour')
    const start = allDay ? startOfDay(r.start.date()) : guessMeridiem(r)
    const stillAhead = allDay ? start.getTime() >= startOfDay(ref).getTime() : start.getTime() > ref.getTime()
    if (stillAhead) out.push({ text: r.text, start, allDay })
  }
  return out
}
