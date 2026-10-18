import type { Plan } from '../shared/calendar.ts'
import { planTitle } from '../shared/format.ts'

// An iCalendar (.ics) feed of the confirmed plans. Apple Calendar, Google Calendar and Outlook can
// subscribe to it by URL, so what HALO adds shows up in the calendar the family already uses.

const DEFAULT_MINUTES = 60

const pad = (n: number) => String(n).padStart(2, '0')
const utc = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
const dateOnly = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` // all-day events use the calendar date as said, with no time zone

const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

// Lines over 75 bytes are folded onto continuation lines that start with a space
function fold(line: string): string {
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch)
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0 }
    cur += ch
    bytes += n
  }
  out.push(cur)
  return out.join('\r\n ')
}

export function toIcs(plans: Plan[], patient: string, now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HALO//Care calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escape(patient ? `HALO · ${patient}` : 'HALO')}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
  ]
  for (const p of plans.filter(x => x.status === 'confirmed')) {
    const start = new Date(p.start)
    const by = p.confirmedBy === 'patient' ? 'Confirmed by the patient by voice' : p.confirmedBy === 'family' ? 'Added or approved by the family' : ''
    const description = [p.source ? `HALO heard: "${p.source.quote}"` : '', by].filter(Boolean).join('\n')
    lines.push(
      'BEGIN:VEVENT',
      `UID:${p.id}@halo`,
      `DTSTAMP:${utc(now)}`,
      p.allDay ? `DTSTART;VALUE=DATE:${dateOnly(start)}` : `DTSTART:${utc(start)}`,
      p.allDay ? `DTEND;VALUE=DATE:${dateOnly(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1))}` : `DTEND:${utc(new Date(start.getTime() + DEFAULT_MINUTES * 60_000))}`,
      `SUMMARY:${escape(planTitle(p))}`,
      ...(description ? [`DESCRIPTION:${escape(description)}`] : []),
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escape(planTitle(p))}`,
      'TRIGGER:-PT1H',
      'END:VALARM',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}
