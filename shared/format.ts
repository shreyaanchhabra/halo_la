// Wording for dates and plans, shared so the glasses, the portal and the server say the same thing
import type { Plan } from './calendar.ts'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

export const dayDiff = (d: Date, now: Date) => Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86_400_000)

// "2 PM", "9:30 AM"
export function timeLabel(d: Date): string {
  const h = d.getHours() % 12 || 12
  const m = d.getMinutes()
  return `${h}${m ? ':' + String(m).padStart(2, '0') : ''} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}

// "Sat 24 Oct"
export const dateLabel = (d: Date) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`

// "Today 2 PM", "Tomorrow", "Sat 2 PM" (within a week), "Sat 24 Oct 2 PM"
export function whenLabel(p: Pick<Plan, 'start' | 'allDay'>, now: Date): string {
  const d = new Date(p.start)
  const n = dayDiff(d, now)
  const day = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n > 1 && n < 7 ? DAYS[d.getDay()] : dateLabel(d)
  return p.allDay ? day : `${day} ${timeLabel(d)}`
}

// "Maya: park", "dentist appointment"
export const planTitle = (p: Pick<Plan, 'who' | 'activity'>) => (p.who.length ? `${p.who.join(' & ')}: ${p.activity}` : p.activity)

const pad = (n: number) => String(n).padStart(2, '0')
const utcStamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
const dayStamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`

// A link that opens Google Calendar with this event filled in, ready to save. No sign-in set up needed.
export function googleCalendarUrl(p: Pick<Plan, 'who' | 'activity' | 'start' | 'allDay' | 'source'>): string {
  const start = new Date(p.start)
  const dates = p.allDay
    ? `${dayStamp(start)}/${dayStamp(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1))}`
    : `${utcStamp(start)}/${utcStamp(new Date(start.getTime() + 60 * 60_000))}`
  const q = new URLSearchParams({ action: 'TEMPLATE', text: planTitle(p), dates })
  if (p.source) q.set('details', `HALO heard: "${p.source.quote}"`)
  return `https://calendar.google.com/calendar/render?${q}`
}
