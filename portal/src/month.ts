import { ymd } from './schedule.ts'

// A month calendar grid, shared by the care portal and the patient page. It only draws; each page
// decides what goes on a day and what clicking does (buttons carry data-act="day" data-day="YYYY-MM-DD").

export type Mark = { time: string; label: string; cls: string; at: number } // cls: '' confirmed, 'pending', 'appt'; at: when it starts (ms), so a day's events can be put in order

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

export const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)
export const shiftMonth = (view: Date, by: number) => new Date(view.getFullYear(), view.getMonth() + by, 1)
export const monthTitle = (view: Date) => view.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
export const longDate = (key: string) => new Date(`${key}T00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

// Six weeks, starting on the Sunday on or before the 1st, so the grid never changes height
export function gridDays(view: Date): Date[] {
  const first = monthStart(view)
  return Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay() + i))
}

export type GridOptions = {
  view: Date
  selected: string // YYYY-MM-DD
  today: string
  marksFor: (day: string) => Mark[]
  maxChips?: number
}

export function monthGridHtml(o: GridOptions): string {
  const max = o.maxChips ?? 3
  const cells = DOW.map(d => `<div class="dow" role="columnheader">${d}</div>`)
  for (const d of gridDays(o.view)) {
    const key = ymd(d)
    const marks = [...o.marksFor(key)].sort((a, b) => a.at - b.at) // by the real time: "7:30 AM" comes before "10:00 AM"
    const chips = marks.slice(0, max).map(m => `<span class="chip ${m.cls}" title="${esc(`${m.time} ${m.label}`.trim())}">${m.time ? `${esc(m.time)} ` : ''}${esc(m.label)}</span>`).join('')
    cells.push(`
      <button type="button" class="day${d.getMonth() !== o.view.getMonth() ? ' out' : ''}${key === o.today ? ' today' : ''}${key === o.selected ? ' sel' : ''}" data-act="day" data-day="${key}"
        aria-label="${esc(longDate(key))}, ${marks.length} ${marks.length === 1 ? 'event' : 'events'}" aria-pressed="${key === o.selected}">
        <span class="n">${d.getDate()}</span>${chips}${marks.length > max ? `<span class="more">+${marks.length - max} more</span>` : ''}
      </button>`)
  }
  return `<div class="grid" role="grid" aria-label="${esc(monthTitle(o.view))}">${cells.join('')}</div>`
}
