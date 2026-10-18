import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  AudioInputSource,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import type { GlassesState, Plan } from '../shared/calendar.ts'
import type { GlassesMenu } from '../portal/src/types.ts'
import { API, getCare, getMenu, getState, markSeen, markTaken, postAudio, postWho, postStats } from './api.ts'
import { AudioPipeline } from './audio/pipeline.ts'
import { pressAction } from './buttons.ts'
import type { SegmenterOptions } from './audio/segmenter.ts'
import { GlassesMessaging } from './messaging.ts'
import {
  buildScreen, detailScreen, layoutForDisplay, MENU, SCREEN_MARGIN_PX,
  type CareCard, type MenuPage, type Mic, type PersonCard,
} from './screens.ts'

// ?debug shows mic levels on the display and exposes test hooks on window.
// ?minRms=80&startRatio=2.5 (and the other segmenter options) tune the cutter without a rebuild.
const params = new URLSearchParams(location.search)
const DEBUG = params.has('debug')
// ?mic=injected: never open the real microphone; audio only comes from window.__haloFeed (needs ?debug). For tests.
const MIC_INJECTED = DEBUG && params.get('mic') === 'injected'
const SEGMENTER_KEYS: (keyof SegmenterOptions)[] = ['minRms', 'startRatio', 'sustainRatio', 'endSilenceMs', 'minSpeechMs', 'calibrationMs']
const segmenterOverrides: Partial<SegmenterOptions> = {}
for (const k of SEGMENTER_KEYS) {
  const v = Number(params.get(k))
  if (params.has(k) && Number.isFinite(v)) segmenterOverrides[k] = v
}

const POLL_MS = 250
const STATS_MS = 5000
const MIC_RETRY_MS = 10_000
const MIC_STALL_MS = 4000 // the mic sends an audio event every 100 ms, even in silence, so a gap this long means it died
const MIC_RESTART_COOLDOWN_MS = 10_000
const REMINDER_SHOW_MS = 20_000
const MENU_IDLE_MS = 60_000 // the menu goes back home after this long without a touch
const BRIDGE_TIMEOUT_MS = 5000
const OFFLINE_AFTER_FAILURES = 2

const bridge = await waitForEvenAppBridge()

// ---- state --------------------------------------------------------------------------------

let state: GlassesState | null = null
let online = true
let failures = 0
let mic: Mic = 'off'
let userPaused = false
let skewMs = 0 // server clock minus this device's clock, so reminders fire on the family's calendar time
let reminder: Plan | null = null
let reminderTimer: ReturnType<typeof setTimeout> | undefined
let micRetry: ReturnType<typeof setTimeout> | undefined
let lastDebug = ''
let lastAudioAt = Date.now()
let lastMicRestart = 0
let notice: string | null = null
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let care: CareCard | null = null
let person: PersonCard | null = null
// A card just tapped stays hidden until the server catches up
const tapped = new Set<string>()
// Home is today's events; an item picked in the glasses menu opens its page
type Mode = { at: 'home' } | { at: 'page'; page: MenuPage; index: number }
let mode: Mode = { at: 'home' }
let menu: GlassesMenu | null = null
let menuIdle: ReturnType<typeof setTimeout> | undefined

// Approved-contact messages and voice replies. Calendar questions, reminders and care cards come first.
const messaging = new GlassesMessaging(refresh)
let replyPipeline: AudioPipeline | null = null
let startingReply = false

const nowDate = () => new Date(Date.now() + skewMs)

// ---- display --------------------------------------------------------------------------------

const withTimeout = <T>(p: Promise<T>, ms = BRIDGE_TIMEOUT_MS) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('bridge timeout')), ms))])

const CONTAINER = { id: 1, name: 'main' }
const INPUT = { id: 2, name: 'input' }
let shown = ''
let wanted = ''
let drawing = false

function screen(): string {
  if (mode.at === 'page') {
    messaging.suspend()
    replyPipeline = null
    return layoutForDisplay(detailScreen(mode.page, menu, nowDate(), mode.index).text)
  }
  const canShow = !userPaused && state && online && !state.prompt && !state.resolved && !reminder && !care && !person
  const message = canShow ? messaging.screen() : null
  if (message) { messaging.visible = true; return layoutForDisplay(message) }
  messaging.suspend()
  replyPipeline = null
  return layoutForDisplay(buildScreen({ now: nowDate(), state, online, mic: userPaused ? 'paused' : mic, reminder, notice, care, person, debug: DEBUG ? lastDebug : undefined }))
}

// Bridge calls are serialized, and only the newest screen is ever drawn
async function draw() {
  if (drawing) return
  drawing = true
  try {
    while (wanted !== shown) {
      const text = wanted
      try {
        await withTimeout(bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: CONTAINER.id, containerName: CONTAINER.name, contentOffset: 0, contentLength: 0, content: text,
        })))
        shown = text
      } catch (err) {
        console.warn('[halo] draw failed, retrying', err)
        await new Promise(r => setTimeout(r, 500))
      }
    }
  } finally {
    drawing = false
  }
}

function flash(message: string, ms = 8000) {
  notice = message
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { notice = null; refresh() }, ms)
  refresh()
}

function refresh() {
  wanted = screen()
  void draw()
}

wanted = screen()
const created = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  // The firmware springs the touch-capturing text box when it's swiped, so touches go to an empty box
  // underneath and the one with the words never moves
  containerTotalNum: 2,
  textObject: [new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: 576, height: 288,
    borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: INPUT.id, containerName: INPUT.name,
    content: ' ', isEventCapture: 1,
  }), new TextContainerProperty({
    xPosition: 0, yPosition: SCREEN_MARGIN_PX, width: 576, height: 288 - 2 * SCREEN_MARGIN_PX,
    borderWidth: 0, borderColor: 5, paddingLength: 4,
    containerID: CONTAINER.id, containerName: CONTAINER.name,
    content: wanted, isEventCapture: 0,
  })],
  // The glasses' own menu (tap, then long-press) gets HALO's items between its system rows
  menuObject: new MenuContainerProperty({
    menuItems: MENU.map(m => new MenuItemProperty({ itemID: m.id, itemName: m.label })),
  }),
}))
console.log('[halo] page created:', created === 0 ? 'success' : `failed (${created})`)
shown = wanted

// ---- microphone -> utterances -> server ---------------------------------------------------------

const pipeline = new AudioPipeline({
  segmenter: segmenterOverrides,
  send: async wav => {
    const reply = await postAudio(wav)
    console.log(`[halo] heard "${reply.text}" -> ${reply.kind}${reply.error ? ' (' + reply.error + ')' : ''}`)
    void poll() // show the question or the answer straight away
  },
  onPartial: wav => { void postWho(wav).then(() => poll()).catch(() => {}) },
  onError: err => { console.warn('[halo] upload failed', err); flash("Couldn't hear that. Please say it again.") },
})

function toBytes(x: unknown): Uint8Array | null {
  if (x instanceof Uint8Array) return x
  if (Array.isArray(x)) return Uint8Array.from(x)
  if (typeof x === 'string') return Uint8Array.from(atob(x), c => c.charCodeAt(0))
  return null
}

function onAudio(raw: unknown) {
  lastAudioAt = Date.now()
  if (mic !== 'on' || userPaused) return
  const pcm = toBytes(raw)
  if (!pcm?.length) return
  if (messaging.visible || startingReply) {
    if (messaging.capturing) replyPipeline?.push(pcm)
    return
  }
  pipeline.push(pcm)
}

async function startMic() {
  clearTimeout(micRetry)
  if (userPaused) return
  if (MIC_INJECTED) { mic = 'on'; refresh(); return }
  try {
    mic = (await withTimeout(bridge.audioControl(true, AudioInputSource.Glasses))) ? 'on' : 'off'
  } catch (err) {
    console.warn('[halo] microphone failed to start', err)
    mic = 'off'
  }
  if (mic === 'off') micRetry = setTimeout(() => void startMic(), MIC_RETRY_MS)
  refresh()
}

// The microphone link can drop (a Bluetooth hiccup, the phone sleeping). Notice, and reopen it.
async function restartMic() {
  lastMicRestart = Date.now()
  console.warn('[halo] microphone stalled, restarting it')
  flash('Mic stopped. Restarting it...', 5000)
  pipeline.flush()
  try { await withTimeout(bridge.audioControl(false)) } catch { /* it may already be gone */ }
  await new Promise(r => setTimeout(r, 500))
  lastAudioAt = Date.now()
  mic = 'off'
  await startMic()
}

const watchdog = setInterval(() => {
  const stalled = Date.now() - lastAudioAt > MIC_STALL_MS
  if (!MIC_INJECTED && mic === 'on' && !userPaused && stalled && Date.now() - lastMicRestart > MIC_RESTART_COOLDOWN_MS) void restartMic()
}, 1000)

async function stopMic() {
  messaging.suspend()
  replyPipeline = null
  clearTimeout(micRetry)
  pipeline.flush()
  if (MIC_INJECTED) { mic = 'off'; return }
  try { await withTimeout(bridge.audioControl(false)) } catch (err) { console.warn('[halo] microphone failed to stop', err) }
  mic = 'off'
}

// ---- server polling and reminders -----------------------------------------------------------------

const REMINDED_KEY = 'halo.reminded'
const reminded = new Set<string>()
try {
  const saved = await withTimeout(bridge.getLocalStorage(REMINDED_KEY))
  if (saved) for (const id of JSON.parse(saved) as string[]) reminded.add(id)
} catch { /* first run, or storage unavailable: worst case a reminder repeats */ }

function rememberReminded() {
  void withTimeout(bridge.setLocalStorage(REMINDED_KEY, JSON.stringify([...reminded].slice(-50)))).catch(() => {})
}

function checkReminders() {
  if (!state) return
  for (const p of state.upcoming) {
    if (reminded.has(p.id)) continue
    reminded.add(p.id)
    rememberReminded()
    // Just confirmed by the patient a moment ago: they know, no need to repeat it
    if (p.resolvedAt && nowDate().getTime() - new Date(p.resolvedAt).getTime() < 60_000) continue
    reminder = p
    clearTimeout(reminderTimer)
    reminderTimer = setTimeout(() => { reminder = null; refresh() }, REMINDER_SHOW_MS)
  }
}

const cardKey = (c: CareCard) => (c.kind === 'message' ? `m:${c.id}` : `d:${c.medKey}|${c.slot}`)

// A family message comes before a dose that's due
function careCard(view: Awaited<ReturnType<typeof getCare>>): CareCard | null {
  const cards: CareCard[] = [
    ...(view.message ? [{ kind: 'message' as const, ...view.message }] : []),
    ...(view.due ? [{ kind: 'dose' as const, ...view.due }] : []),
  ]
  return cards.find(c => !tapped.has(cardKey(c))) ?? null
}

async function tapCare(card: CareCard) {
  tapped.add(cardKey(card))
  care = null
  flash(card.kind === 'message' ? 'Got it.' : `${card.title} taken. Thank you.`, 4000)
  try {
    if (card.kind === 'message') await markSeen(card.id)
    else await markTaken(card.medKey, card.slot)
  } catch (err) {
    console.warn('[halo] tap failed to save', err)
    tapped.delete(cardKey(card))
    flash("Couldn't save that. Please tap again.")
  }
  void poll()
}

// ---- the menu --------------------------------------------------------------------------------------

function goHome() {
  clearTimeout(menuIdle)
  if (mode.at === 'home') return
  mode = { at: 'home' }
  refresh()
}

// Any touch on a menu page restarts the clock back to home
function touchMenu() {
  clearTimeout(menuIdle)
  menuIdle = setTimeout(goHome, MENU_IDLE_MS)
}

async function loadMenu() {
  try {
    menu = await getMenu()
    if (mode.at === 'page') refresh()
  } catch (err) {
    console.warn('[halo] menu failed to load', err)
  }
}

function openPage(page: MenuPage) {
  mode = { at: 'page', page, index: 0 }
  touchMenu()
  refresh()
  void loadMenu()
}

function turnPage(by: number) {
  if (mode.at !== 'page') return
  const pages = detailScreen(mode.page, menu, nowDate(), 0).pages
  mode = { ...mode, index: Math.min(pages - 1, Math.max(0, mode.index + by)) }
  touchMenu()
  refresh()
}

// A question to answer, a reminder, or someone who just started talking can't wait behind the menu
const interrupting = () => Boolean(state?.prompt || state?.resolved || reminder || person)

let polling = false
async function poll() {
  if (polling) return
  polling = true
  try {
    const [next, view] = await Promise.all([getState(), getCare().catch(() => undefined)])
    state = next
    skewMs = new Date(state.now).getTime() - Date.now()
    failures = 0
    online = true
    checkReminders()
    if (view) { care = careCard(view); person = view.person ?? null }
    if (interrupting()) goHome()
    else if (mode.at === 'page') void loadMenu()
    await messaging.poll()
  } catch (err) {
    if (++failures >= OFFLINE_AFTER_FAILURES) online = false
    if (failures === OFFLINE_AFTER_FAILURES) console.warn('[halo] server unreachable', err)
  } finally {
    polling = false
  }
  if (DEBUG) {
    const s = pipeline.stats()
    lastDebug = `rms ${s.lastRms} floor ${s.noiseFloor} thr ${s.startThreshold} n ${s.utterances}`
  }
  refresh()
}

const pollTimer = setInterval(() => void poll(), POLL_MS)
const statsTimer = setInterval(() => {
  if (mic !== 'on') return
  const s = pipeline.stats()
  void postStats({ ...s, at: new Date().toISOString(), source: 'glasses', segmenter: segmenterOverrides }).catch(() => {})
  if (DEBUG) console.log('[halo] mic', JSON.stringify(s))
}, STATS_MS)

// ---- buttons and lifecycle --------------------------------------------------------------------------

async function togglePause() {
  userPaused = !userPaused
  if (userPaused) await stopMic()
  else await startMic()
  refresh()
}

async function cleanup() {
  clearInterval(pollTimer)
  clearInterval(statsTimer)
  clearInterval(watchdog)
  clearTimeout(reminderTimer)
  clearTimeout(menuIdle)
  await stopMic()
  unsubscribe()
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  if (event.audioEvent) onAudio(event.audioEvent.audioPcm)

  // An item picked in the glasses menu
  if (event.menuItemClickEvent) {
    const item = MENU.find(m => m.id === event.menuItemClickEvent!.itemID)
    if (item?.page) openPage(item.page)
    else if (item) goHome()
    return
  }
  // On a menu page, a swipe turns to the next or previous page
  if (event.textEvent && mode.at === 'page') {
    const type = event.textEvent.eventType
    if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) turnPage(1)
    else if (type === OsEventTypeList.SCROLL_TOP_EVENT) turnPage(-1)
    return
  }

  if (!event.sysEvent) return
  const type = event.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT
  if (type === OsEventTypeList.CLICK_EVENT || type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    const action = pressAction(type === OsEventTypeList.CLICK_EVENT ? 'click' : 'double', { onPage: mode.at === 'page', paused: userPaused })
    if (action === 'home') goHome()
    else if (action === 'toggle-pause') void togglePause()
    // At home, a family message or due dose on screen is acknowledged with a tap; anything else is answered by voice
    else if (care && !interrupting()) void tapCare(care)
    else if (messaging.visible) void messaging.click()
    return
  }
  if (type === OsEventTypeList.LONG_PRESS_EVENT) {
    if (!userPaused && messaging.visible && !startingReply) {
      startingReply = true
      pipeline.flush()
      void pipeline.drained().then(async () => {
        replyPipeline = null
        await messaging.hold()
        if (messaging.capturing) replyPipeline = new AudioPipeline({
          segmenter: segmenterOverrides,
          send: wav => messaging.audio(wav),
        })
      }).finally(() => { startingReply = false })
    }
    return
  }
  switch (type) {
    // These also fire when the glasses menu opens and closes over the page, so the mic keeps running
    // through them; if it did stop, the watchdog restarts it.
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      if (mic === 'off') void startMic()
      void poll()
      break
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      break
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
      void cleanup()
      break
  }
})

window.addEventListener('beforeunload', () => { void bridge.audioControl(false) })

if (MIC_INJECTED) {
  // Pull test audio queued on the server (HALO_DEBUG_INJECT=1) and feed it through the real pipeline
  const CHUNK = 3200 // 100 ms, like the glasses send
  setInterval(() => {
    void fetch(`${API}/api/debug/inject`).then(r => r.json()).then((j: { clips: string[] }) => {
      for (const b64 of j.clips) {
        const pcm = toBytes(b64)!
        for (let i = 0; i < pcm.length; i += CHUNK) pipeline.push(pcm.subarray(i, i + CHUNK))
      }
    }).catch(() => {})
  }, 200)
}

if (DEBUG) {
  // Test hooks: push raw 16 kHz PCM through the real pipeline without a microphone
  Object.assign(window, {
    __haloFeed: (pcm: Uint8Array) => pipeline.push(pcm),
    __haloDrained: () => pipeline.drained(),
    __haloStats: () => pipeline.stats(),
  })
}

await startMic()
await poll()
