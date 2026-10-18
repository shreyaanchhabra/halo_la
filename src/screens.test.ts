import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildScreen, fit, inLabel } from './screens.ts'
import type { GlassesState, Plan } from '../shared/calendar.ts'

const now = new Date('2026-10-24T10:02:00')
const plan = (o: Partial<Plan>): Plan => ({
  id: 'p1', activity: 'park', who: ['Maya'], start: '2026-10-24T14:00:00', allDay: false, status: 'confirmed', createdAt: now.toISOString(), ...o,
})
const state = (o: Partial<GlassesState> = {}): GlassesState => ({ now: now.toISOString(), prompt: null, resolved: null, heard: null, today: [], upcoming: [], ...o })
const base = { now, online: true, mic: 'on' as const, reminder: null }

describe('glasses screens', () => {
  test('idle shows the date and today\'s plans', () => {
    const s = buildScreen({ ...base, state: state({ today: [plan({})] }) })
    assert.match(s, /listening/)
    assert.match(s, /Sat 24 Oct, 10:02 AM/)
    assert.match(s, /2 PM {2}Maya: park/)
  })

  test('idle with nothing planned says so', () => {
    assert.match(buildScreen({ ...base, state: state() }), /Nothing planned today\./)
  })

  test('long lists are capped', () => {
    const today = [1, 2, 3, 4, 5, 6].map(n => plan({ id: String(n), start: `2026-10-24T${10 + n}:00:00` }))
    const s = buildScreen({ ...base, state: state({ today }) })
    assert.match(s, /\+2 more/)
  })

  test('events that started over an hour ago drop off the list', () => {
    const s = buildScreen({ ...base, state: state({ today: [plan({ start: '2026-10-24T08:00:00' })] }) })
    assert.match(s, /Nothing planned today/)
  })

  test('all-day events are listed as all day', () => {
    assert.match(buildScreen({ ...base, state: state({ today: [plan({ allDay: true, start: '2026-10-24T00:00:00' })] }) }), /All day/)
  })

  test('the question is shown with how to answer', () => {
    const prompt = { id: 'p1', lines: ['Add to calendar?', 'Maya: park', 'Sat 2 PM', '', 'Say yes or no'], expiresAt: now.toISOString() }
    const s = buildScreen({ ...base, state: state({ prompt }) })
    assert.match(s, /Add to calendar\?\nMaya: park\nSat 2 PM\n\nSay yes or no/)
  })

  test('the answer is confirmed back to the patient', () => {
    const s = buildScreen({ ...base, state: state({ resolved: { id: 'p1', status: 'confirmed', text: 'Added\nMaya: park\nSat 24 Oct 2 PM' } }) })
    assert.match(s, /^Added\nMaya: park/)
  })

  test('a reminder says what is coming and how long until it', () => {
    const s = buildScreen({ ...base, state: state(), reminder: plan({ start: '2026-10-24T11:00:00' }) })
    assert.match(s, /Coming up\nMaya: park\n11 AM {2}\(in 58 min\)/)
  })

  test('paused tells the wearer how to resume or exit', () => {
    const s = buildScreen({ ...base, mic: 'paused', state: state() })
    assert.match(s, /Not listening/)
    assert.match(s, /Double-tap: resume/)
    assert.match(s, /Tap: exit/)
  })

  test('with no server, it says so instead of showing a blank screen', () => {
    assert.match(buildScreen({ ...base, online: false, state: null }), /Can't reach the HALO server/)
  })

  test('if the server drops out after working, the last known plans stay up and it says offline', () => {
    const s = buildScreen({ ...base, online: false, state: state({ today: [plan({})] }) })
    assert.match(s, /Maya: park/)
    assert.match(s, /\(offline\)/)
  })

  test('a dead microphone is visible', () => {
    assert.match(buildScreen({ ...base, mic: 'off', state: state() }), /mic unavailable/)
  })

  test('nothing exceeds the display budget', () => {
    const long = plan({ who: ['Maximilian-Alexander'], activity: 'a really quite long outing to the botanical gardens and then lunch' })
    const s = buildScreen({ ...base, state: state({ today: [long], prompt: null }) })
    for (const line of s.split('\n')) assert.ok(line.length <= 34, `"${line}" is ${line.length}`)
    assert.ok(s.length < 1000)
  })

  test('what was heard is shown under today\'s plans, with why nothing happened', () => {
    const s = buildScreen({ ...base, state: state({ heard: { text: 'Remember to take your tablet at 2', note: 'Not a calendar plan' } }) })
    assert.match(s, /Heard:\nRemember to take your tablet at 2\n\(Not a calendar plan\)/)
  })

  test('a long sentence is wrapped to two lines and cut with ...', () => {
    const s = buildScreen({ ...base, state: state({ heard: { text: 'I think that on the whole we should probably go to the park and then have lunch somewhere nice afterwards', note: '' } }) })
    const lines = s.split('\n')
    const at = lines.indexOf('Heard:')
    assert.ok(at > 0)
    assert.ok(lines[at + 2].endsWith('...'), lines[at + 2])
    for (const l of lines) assert.ok(l.length <= 34, `"${l}" is ${l.length}`)
  })

  test('plans give way to the heard text so everything fits the display', () => {
    const today = [1, 2, 3, 4].map(n => plan({ id: String(n), start: `2026-10-24T${12 + n}:00:00` }))
    const s = buildScreen({ ...base, state: state({ today, heard: { text: 'Do you want to meet at 6', note: 'Not a calendar plan' } }) })
    assert.ok(s.split('\n').length <= 10, `${s.split('\n').length} lines`)
    assert.match(s, /Heard:/)
    assert.match(s, /more/)
  })

  test('a notice from the device (a clip that could not be sent) is shown', () => {
    assert.match(buildScreen({ ...base, state: state(), notice: "Couldn't hear that. Please say it again." }), /Couldn't hear that/)
  })

  test('fit and inLabel', () => {
    assert.equal(fit('short'), 'short')
    assert.equal(fit('x'.repeat(50)).length, 34)
    assert.equal(inLabel(45), 'in 45 min')
    assert.equal(inLabel(60), 'in 1 hour')
    assert.equal(inLabel(120), 'in 2 hours')
  })
})
