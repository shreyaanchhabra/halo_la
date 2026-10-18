import {
  waitForEvenAppBridge, CreateStartUpPageContainer, OsEventTypeList, TextContainerProperty, TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import type { GlassesView } from '../portal/src/types'

// The dev server forwards /api to the HALO care portal
const POLL_MS = 5_000
const THANKS_MS = 4_000
const BRIDGE_TIMEOUT_MS = 5_000

const bridge = await waitForEvenAppBridge()
const screen = { containerID: 1, containerName: 'halo' }

let view: GlassesView | null = null
let unreachable = false
let thanks: { text: string; until: number } | null = null
let shown = ''

function formatTime(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

const nowLabel = () => new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

function homeText(v: GlassesView | null) {
  const lines = [`HALO   ${nowLabel()}`, '']
  if (unreachable || !v) {
    lines.push("Can't reach HALO right now.", 'Trying again...')
    return lines.join('\n')
  }
  if (v.next) {
    lines.push(`Next  ${formatTime(v.next.time)}`, `${v.next.kind === 'medicine' ? 'Take ' : ''}${v.next.title}`)
  } else {
    lines.push('Nothing else planned today.')
  }
  if (v.appointment) {
    const day = new Date(`${v.appointment.date}T00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    lines.push('', 'Appointment', `${day}${v.appointment.time ? `, ${formatTime(v.appointment.time)}` : ''}`, v.appointment.title)
  }
  return lines.join('\n')
}

// A family message comes first, then a dose that's due, then the home screen
function screenText(): string {
  if (thanks && Date.now() < thanks.until) return thanks.text
  thanks = null
  if (!unreachable && view?.message) {
    return ['● Message from family', '', view.message.text, '', '', '▶ Tap when you have read it'].join('\n')
  }
  if (!unreachable && view?.due) {
    const d = view.due
    return ['● Time for your medicine', '', d.title, d.detail, `Due at ${formatTime(d.time)}`, '', '▶ Tap when you have taken it'].join('\n')
  }
  return homeText(view)
}

const withTimeout = <T>(p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Glasses timed out')), BRIDGE_TIMEOUT_MS))])

// Bridge calls share one Bluetooth link, so they run one at a time
let queue: Promise<unknown> = Promise.resolve()
function render() {
  queue = queue.then(async () => {
    const content = screenText()
    if (content === shown) return
    const ok = await withTimeout(bridge.textContainerUpgrade(new TextContainerUpgrade({
      ...screen, contentOffset: 0, contentLength: 0, content,
    }))).catch(() => false)
    if (ok) shown = content
  })
}

async function refresh() {
  try {
    const res = await fetch('/api/glasses')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    view = await res.json()
    unreachable = false
  } catch {
    unreachable = true
  }
  render()
}

async function post(path: string, body: unknown) {
  await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

async function onTap() {
  if (thanks || unreachable || !view) return
  if (view.message) {
    const { id } = view.message
    view = { ...view, message: null }
    thanks = { text: '\n\n   ○ Got it', until: Date.now() + THANKS_MS / 2 }
    render()
    await post('/api/glasses/seen', { id }).catch(() => {})
  } else if (view.due) {
    const { medKey, slot, title } = view.due
    view = { ...view, due: null }
    thanks = { text: `\n\n   ○ ${title} taken.\n   Thank you.`, until: Date.now() + THANKS_MS }
    render()
    await post('/api/doses', { medKey, slot, taken: true, by: 'glasses' }).catch(() => {})
  } else {
    return
  }
  setTimeout(refresh, THANKS_MS + 100)
}

const created = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 1,
  textObject: [new TextContainerProperty({
    ...screen,
    xPosition: 0, yPosition: 0, width: 576, height: 288,
    borderWidth: 0, borderColor: 5, paddingLength: 16,
    content: 'HALO',
    isEventCapture: 1,
  })],
}))
if (created !== 0) console.error(`HALO: glasses page failed to start (code ${created})`)
shown = 'HALO'

// Keeps polling in the background too: family messages and due doses shouldn't wait for the phone app to open
const timer = setInterval(refresh, POLL_MS)
bridge.onEvenHubEvent(event => {
  const type = event.sysEvent?.eventType ?? (event.sysEvent ? OsEventTypeList.CLICK_EVENT : undefined)
  if (type === OsEventTypeList.CLICK_EVENT) void onTap()
  else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) void bridge.shutDownPageContainer(1)
  else if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) void refresh()
  else if (type === OsEventTypeList.ABNORMAL_EXIT_EVENT || type === OsEventTypeList.SYSTEM_EXIT_EVENT) clearInterval(timer)
})
void refresh()
