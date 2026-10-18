import type { Appointment, HaloData } from './types'

export type ScheduleItem = {
  time: string | null // "HH:MM", null for all-day
  title: string
  detail: string
  kind: 'medicine' | 'appointment'
  medKey?: string
  slot?: string // "YYYY-MM-DD HH:MM", identifies one dose
}

export const medKey = (rxId: string, index: number) => `${rxId}:${index}`

export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function formatTime(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

// A prescription counts from its written date, or from when it was uploaded
const startDate = (rx: HaloData['prescriptions'][number]) => rx.date || rx.uploadedAt.slice(0, 10)

export function appointments(data: HaloData): Appointment[] {
  return data.prescriptions
    .flatMap(rx => rx.reading?.appointments ?? [])
    .sort((a, b) => `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`))
}

export function scheduleFor(data: HaloData, day: Date): ScheduleItem[] {
  const date = ymd(day)
  const items: ScheduleItem[] = []

  for (const rx of data.prescriptions) {
    if (startDate(rx) > date) continue
    rx.reading?.medicines.forEach((m, i) => {
      for (const time of m.times) {
        items.push({
          time, title: `${m.name} ${m.strength}`.trim(), detail: m.instructions, kind: 'medicine',
          medKey: medKey(rx.id, i), slot: `${date} ${time}`,
        })
      }
    })
  }
  for (const a of appointments(data)) {
    if (a.date === date) items.push({ time: a.time, title: a.title, detail: 'Appointment', kind: 'appointment' })
  }
  return items.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''))
}

// ---- .ics export (imports into Google Calendar, Apple Calendar, Outlook) ----

const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/[,;]/g, m => `\\${m}`).replace(/\n/g, '\\n')
const icsDate = (date: string) => date.replace(/-/g, '')
const icsDateTime = (date: string, time: string) => `${icsDate(date)}T${time.replace(':', '')}00`

export function buildIcs(data: HaloData): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const who = data.patient.name ? ` (${data.patient.name})` : ''
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HALO//Care Portal//EN', `X-WR-CALNAME:HALO${who}`]

  for (const rx of data.prescriptions) {
    rx.reading?.medicines.forEach((m, i) => {
      // Repeat daily until this fill runs out, when the quantity is known
      const days = m.quantity && m.times.length ? Math.floor(m.quantity / m.times.length) : null
      for (const time of m.times) {
        lines.push(
          'BEGIN:VEVENT',
          `UID:${rx.id}-${i}-${time.replace(':', '')}@halo`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${icsDateTime(startDate(rx), time)}`,
          'DURATION:PT15M',
          days ? `RRULE:FREQ=DAILY;COUNT=${days}` : 'RRULE:FREQ=DAILY',
          `SUMMARY:${icsText(`Take ${m.name} ${m.strength}`.trim())}`,
          `DESCRIPTION:${icsText(m.instructions)}`,
          'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`Take ${m.name}`)}`, 'TRIGGER:PT0M', 'END:VALARM',
          'END:VEVENT',
        )
      }
    })
    rx.reading?.appointments.forEach((a, i) => {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${rx.id}-appt-${i}@halo`,
        `DTSTAMP:${stamp}`,
        a.time ? `DTSTART:${icsDateTime(a.date, a.time)}` : `DTSTART;VALUE=DATE:${icsDate(a.date)}`,
        a.time ? 'DURATION:PT1H' : 'DURATION:P1D',
        `SUMMARY:${icsText(a.title)}`,
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(a.title)}`, 'TRIGGER:-PT1H', 'END:VALARM',
        'END:VEVENT',
      )
    })
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}

export function downloadIcs(data: HaloData) {
  const url = URL.createObjectURL(new Blob([buildIcs(data)], { type: 'text/calendar' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: 'halo-calendar.ics' })
  a.click()
  URL.revokeObjectURL(url)
}
