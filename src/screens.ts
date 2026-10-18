import { getTextWidth } from '@evenrealities/pretext'
import type { GlassesState, HeardSpeaker, Plan } from '../shared/calendar.ts'
import { dateLabel, dayDiff, planTitle, timeLabel } from '../shared/format.ts'
import type { GlassesMenu } from '../portal/src/types.ts'

// What the glasses show. Pure functions of the current state, so they can be tested without glasses.
// The display is 576 x 288 with one firmware font and no alignment or spacing control: buildScreen
// writes short lines, and layoutForDisplay centers them by padding with spaces.

const MAX_CHARS = 34 // comfortably under the width of the display
const MAX_EVENTS = 4
// The text sits this far in from the top and bottom edges, which leaves room for 9 lines of 27 px
export const SCREEN_MARGIN_PX = 18
export const MAX_LINES = 9
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
  person?: PersonCard | null // who just started talking; the server shows it for a few seconds
  debug?: string
}

export type PersonCard = { name: string; relation: string; fact: string }

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
  if (lines.length > maxLines) shown[maxLines - 1] = shown[maxLines - 1].slice(0, MAX_CHARS - 3).trimEnd() + '...'
  return shown
}

// Who spoke ("Maya, your daughter:", "You:", "Guest 2:", or "Unknown:"), then one short line of what they said
export function speakerLabel(s: HeardSpeaker | null | undefined): string {
  if (!s) return 'Unknown:'
  if (s.patient) return 'You:'
  return `${fit([s.name, yourRelation(s.relation)].filter(Boolean).join(', '), MAX_CHARS - 1)}:`
}

function heardBlock(heard: GlassesState['heard']): string[] {
  if (!heard) return []
  const extra = heard.text.trim() ? heard.text : (heard.speaker?.blurb ?? '')
  return [speakerLabel(heard.speaker), ...wrap(extra, 1)]
}

function careScreen(card: CareCard): string[] {
  if (card.kind === 'message') return ['Message from family', '', ...wrap(card.text, 5), '', 'Tap: got it']
  const [h, m] = card.time.split(':').map(Number)
  const due = new Date(2000, 0, 1, h, m)
  return ['Time for your medicine', '', fit(card.title), ...wrap(card.detail, 2), `Due at ${timeLabel(due)}`, '', 'Tap: I took it']
}

const yourRelation = (relation: string) => (relation ? `your ${relation.toLowerCase().replace(/^(your|my|his|her)\s+/, '')}` : '')

function personScreen(p: PersonCard): string[] {
  const relation = yourRelation(p.relation).replace(/^y/, 'Y')
  return ['This is', '', fit(p.name), ...(relation ? [fit(relation)] : []), ...(p.fact ? ['', ...wrap(p.fact, 2)] : [])]
}

// As many of today's events as fit in room lines, with "+N more" when some are left out and there's a line for it
function todayList(state: GlassesState, now: Date, room: number): string[] {
  const shown = state.today.filter(p => p.allDay || new Date(p.start).getTime() > now.getTime() - ONGOING_FOR_MS)
  if (!shown.length) return ['Nothing planned today.']
  const all = shown.length <= Math.min(MAX_EVENTS, room)
  const cap = all ? shown.length : Math.max(1, Math.min(MAX_EVENTS, room - 1))
  const lines = shown.slice(0, cap).map(p => fit(`${p.allDay ? 'All day' : timeLabel(new Date(p.start))}  ${planTitle(p)}`))
  if (!all && room > cap) lines.push(`+${shown.length - cap} more`)
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
    if (i.person) return personScreen(i.person)
    if (i.care) return careScreen(i.care)
    // header, date, gap, "Today", then the events; whatever was heard goes underneath, so events give way to it.
    // The way into the menu is always the last line.
    const extra = i.notice ? [i.notice] : heardBlock(i.state.heard)
    const room = MAX_LINES - 4 - (extra.length ? extra.length + 1 : 0) - (i.online ? 0 : 2) - (i.debug ? 2 : 0) - 1
    const home = [header(i.mic), `${dateLabel(i.now)}, ${timeLabel(i.now)}`, '', 'Today', ...todayList(i.state, i.now, room), ...(extra.length ? ['', ...extra] : []), ...(i.online ? [] : ['', '(offline)'])]
    return [...home, ...(home.length + (i.debug ? 2 : 0) < MAX_LINES - 1 ? [''] : []), MENU_HINT]
  })()
  if (i.debug) out.push('', i.debug)
  return out.join('\n')
}

// ---- the menu: items in the glasses' own menu (tap, then long-press), each opening a text page ------------

const MENU_HINT = 'Tap then hold for menu'
export type MenuPage = 'appointments' | 'medications' | 'family'
const PAGE_TITLES: Record<MenuPage, string> = { appointments: 'Appointments', medications: 'Medications', family: 'Family' }
// The glasses menu sends back the id of the item picked; ids must be non-zero. "Today" is the home page.
export const MENU: { id: number; label: string; page: MenuPage | null }[] = [
  { id: 4, label: 'Today', page: null },
  { id: 1, label: PAGE_TITLES.appointments, page: 'appointments' },
  { id: 2, label: PAGE_TITLES.medications, page: 'medications' },
  { id: 3, label: PAGE_TITLES.family, page: 'family' },
]

const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return timeLabel(new Date(2000, 0, 1, h, m))
}

function dayHeading(date: string, now: Date): string {
  const d = new Date(`${date}T00:00`)
  const n = dayDiff(d, now)
  return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : dateLabel(d)
}

// Each block stays on one page where it can: a day with its appointments, a medicine with its lines
function pageBlocks(page: MenuPage, menu: GlassesMenu, now: Date): string[][] {
  if (page === 'appointments') {
    if (!menu.appointments.length) return [['No appointments in the', 'next 3 days.']]
    const days = new Map<string, string[]>()
    for (const a of menu.appointments) {
      if (!days.has(a.date)) days.set(a.date, [dayHeading(a.date, now)])
      days.get(a.date)!.push(fit(`${a.time ? clock(a.time) : 'All day'}  ${a.title}`))
    }
    return [...days.values()]
  }
  if (page === 'medications') {
    if (!menu.medicines.length) return [['No medicines on file.']]
    const low = menu.medicines.filter(m => m.low).length
    return [
      [low ? `${low} ${low === 1 ? 'is' : 'are'} running low` : 'None running low'],
      ...menu.medicines.map(m => [
        fit(m.title),
        m.times.length ? fit(`${m.times.map(clock).join(', ')}  (${m.takenToday} of ${m.times.length} taken)`) : 'No set times',
        ...(m.low ? [m.daysLeft != null ? `! Running low: ${m.daysLeft} day${m.daysLeft === 1 ? '' : 's'} left` : '! Running low'] : []),
      ]),
    ]
  }
  if (!menu.family.length) return [['No family added yet.']]
  return [menu.family.map(p => fit([p.name, yourRelation(p.relation)].filter(Boolean).join(', ')))]
}

// Fills pages of size lines, starting a new page rather than splitting a block that would fit on one
function paginate(blocks: string[][], size: number): string[][] {
  const pages: string[][] = [[]]
  for (const block of blocks) {
    for (let at = 0; at < block.length; at += size) {
      const part = block.slice(at, at + size)
      if (pages.at(-1)!.length + part.length > size) pages.push([])
      pages.at(-1)!.push(...part)
    }
  }
  return pages
}

// Title, the page's lines, then how to get around: swipe for the next page, tap to go back home
export function detailScreen(page: MenuPage, menu: GlassesMenu | null, now: Date, index: number): { text: string; pages: number } {
  const title = PAGE_TITLES[page]
  if (!menu) return { text: [title, '', 'Loading...', '', 'Tap: back'].join('\n'), pages: 1 }
  const blocks = pageBlocks(page, menu, now)
  const single = MAX_LINES - 4 // title, gap, the lines, gap, footer
  if (blocks.flat().length <= single) return { text: [title, '', ...blocks.flat(), '', 'Tap: back'].join('\n'), pages: 1 }
  const pages = paginate(blocks, single - 1) // the footer is two lines
  const n = Math.min(Math.max(0, index), pages.length - 1)
  const turn = n < pages.length - 1 ? `Swipe for more  ${n + 1}/${pages.length}` : `Page ${n + 1}/${pages.length}`
  // Shorter pages are filled out to the longest, so the title and footer stay put while turning pages
  const fill = Array<string>(Math.max(...pages.map(p => p.length)) - pages[n].length).fill('')
  return { text: [title, '', ...pages[n], ...fill, '', turn, 'Tap: back'].join('\n'), pages: pages.length }
}

// The text container is the full screen with 4 px of padding; the firmware font has 27 px lines
export const TEXT_WIDTH_PX = 576 - 2 * 4
const SPACE_PX = getTextWidth(' ') // the font's only space; thin and hair spaces aren't in it
const WORD_GAP = '  ' // twice the normal gap between words: easier to read, and word shapes stay whole

// Centers every line across the display and, when there's room, the whole screen top to bottom.
// Blank lines are kept, so the groups buildScreen made stay together.
export function layoutForDisplay(text: string, maxLines = MAX_LINES): string {
  const lines = text.split('\n').map(l => l.trim().replace(/ +/g, WORD_GAP))
  while (lines.length && !lines.at(-1)) lines.pop()
  const centered = lines.map(l => {
    if (!l) return ''
    const spare = TEXT_WIDTH_PX - getTextWidth(l)
    return spare > 0 ? ' '.repeat(Math.floor(spare / 2 / SPACE_PX)) + l : l
  })
  const above = Math.max(0, Math.floor((maxLines - centered.length) / 2))
  return [...Array<string>(above).fill(''), ...centered].join('\n')
}
