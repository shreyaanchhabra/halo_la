import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { getTextWidth } from '@evenrealities/pretext'
import { buildScreen, detailScreen, fit, inLabel, layoutForDisplay, MAX_LINES, MENU, TEXT_WIDTH_PX } from './screens.ts'
import type { GlassesState, HeardSpeaker, Plan } from '../shared/calendar.ts'
import type { GlassesMenu } from '../portal/src/types.ts'

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
    assert.match(s, /\+3 more/)
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

  const maya = { name: 'Maya', relation: 'Granddaughter', patient: false }

  test('before the words arrive, the name and the family\'s line are shown', () => {
    const s = buildScreen({ ...base, state: state({ heard: { text: '', note: '', speaker: { ...maya, blurb: 'Studies art in Chicago' } } }) })
    assert.match(s, /Maya, your granddaughter:/)
    assert.match(s, /Studies art in Chicago/)
    assert.doesNotMatch(s, /Unknown/)
  })

  test('what was heard is shown under today\'s plans: who said it, then what they said', () => {
    const s = buildScreen({ ...base, state: state({ heard: { text: 'Remember to take your tablet at 2', note: 'Not a calendar plan', speaker: maya } }) })
    assert.match(s, /\n\nMaya, your granddaughter:\nRemember to take your tablet at 2\nTap then hold for menu$/)
  })

  test('the patient is "You", and a voice no one knows is "Unknown"', () => {
    const said = (speaker: HeardSpeaker | null | undefined) => buildScreen({ ...base, state: state({ heard: { text: 'Hello', note: '', speaker } }) })
    assert.match(said({ name: 'Joe Martinez', relation: '', patient: true }), /\nYou:\nHello\n/)
    assert.match(said({ name: 'Raj', relation: '', patient: false }), /\nRaj:\nHello\n/)
    assert.match(said(null), /\nUnknown:\nHello\n/)
    assert.match(said(undefined), /\nUnknown:\nHello\n/)
  })

  test('a long sentence is cut to one line with ...', () => {
    const s = buildScreen({ ...base, state: state({ heard: { text: 'I think that on the whole we should probably go to the park and then have lunch somewhere nice afterwards', note: '', speaker: maya } }) })
    const lines = s.split('\n')
    const at = lines.indexOf('Maya, your granddaughter:')
    assert.ok(at > 0)
    assert.ok(lines[at + 1].endsWith('...'), lines[at + 1])
    assert.ok(!lines[at + 1].endsWith('....'), lines[at + 1])
    for (const l of lines) assert.ok(l.length <= 34, `"${l}" is ${l.length}`)
    const exact = buildScreen({ ...base, state: state({ heard: { text: "Let's sit down and catch up for a while.", note: '', speaker: maya } }) })
    assert.match(exact, /\nLet's sit down and catch up for\.\.\.\n/)
  })

  test('a long name and relation still fit on one line', () => {
    const s = buildScreen({ ...base, state: state({ heard: { text: 'Hi', note: '', speaker: { name: 'Maximilian-Alexander', relation: 'great-grandson', patient: false } } }) })
    const label = s.split('\n').find(l => l.endsWith(':'))!
    assert.ok(label.length <= 34, label)
  })

  test('plans give way to the heard text so everything fits the display', () => {
    const today = [1, 2, 3, 4].map(n => plan({ id: String(n), start: `2026-10-24T${12 + n}:00:00` }))
    const s = buildScreen({ ...base, state: state({ today, heard: { text: 'Do you want to meet at 6', note: 'Not a calendar plan', speaker: maya } }) })
    assert.ok(s.split('\n').length <= MAX_LINES, `${s.split('\n').length} lines`)
    assert.match(s, /Maya, your granddaughter:/)
    assert.match(s, /1 PM/)
    assert.doesNotMatch(s, /4 PM/)
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

describe('family messages and doses', () => {
  const message = { kind: 'message' as const, id: 'm1', text: 'Your family is coming over at 5 tomorrow, and bringing your favourite tea.' }
  const dose = { kind: 'dose' as const, medKey: 'rx:0', slot: '2026-10-24 21:00', title: 'Donepezil 5 mg', time: '21:00', detail: 'At bedtime' }

  test('a family message wraps onto short lines and asks for a tap', () => {
    const s = buildScreen({ ...base, state: state(), care: message })
    assert.match(s, /^Message from family/)
    assert.match(s, /favourite tea\./)
    assert.ok(s.split('\n').every(l => l.length <= 34))
    assert.match(s, /Tap: got it/)
  })

  test('a due dose shows the medicine and its time', () => {
    const s = buildScreen({ ...base, state: state(), care: dose })
    assert.match(s, /Time for your medicine/)
    assert.match(s, /Donepezil 5 mg/)
    assert.match(s, /Due at 9 PM/)
    assert.match(s, /Tap: I took it/)
  })

  test('a spoken question or reminder comes first', () => {
    const prompt = { id: 'p1', lines: ['Park with Maya at 2 PM?', 'Say yes or no'], expiresAt: now.toISOString() }
    assert.match(buildScreen({ ...base, state: state({ prompt }), care: message }), /Park with Maya/)
    assert.match(buildScreen({ ...base, state: state(), reminder: plan({}), care: dose }), /^Coming up/)
  })
})

describe('laying out for the display', () => {
  const lines = (s: string) => s.split('\n')

  test('each line is centered across the 568 px text area', () => {
    for (const l of lines(layoutForDisplay('This is\n\nRaj\nYour neighbor')).filter(Boolean)) {
      const pad = l.length - l.trimStart().length
      const left = pad * getTextWidth(' ')
      const right = TEXT_WIDTH_PX - left - getTextWidth(l.trimStart())
      assert.ok(Math.abs(left - right) <= 2 * getTextWidth(' '), `${JSON.stringify(l)}: ${left} vs ${right}`)
    }
  })

  test('a short screen sits in the middle, top to bottom, and keeps its blank lines', () => {
    const out = lines(layoutForDisplay('This is\n\nRaj\nYour neighbor'))
    assert.equal(out.length, 2 + 4)
    assert.deepEqual(out.slice(0, 2), ['', ''])
    assert.equal(out[3], '')
  })

  test('words get twice the usual gap, and nothing is wider than the display', () => {
    const out = layoutForDisplay(buildScreen({ ...base, state: state(), care: { kind: 'message', id: 'm', text: 'Your family is coming over at 5 tomorrow, and bringing your favourite tea.' } }))
    assert.match(out, /Message {2}from {2}family/)
    for (const l of lines(out)) assert.ok(getTextWidth(l) <= TEXT_WIDTH_PX, l)
    assert.ok(lines(out).length <= MAX_LINES)
  })

  test('a full screen gets no extra lines on top', () => {
    const full = Array.from({ length: MAX_LINES }, (_, n) => `Line ${n + 1}`).join('\n')
    assert.equal(lines(layoutForDisplay(full)).length, MAX_LINES)
    assert.match(lines(layoutForDisplay(full))[0], /Line {2}1$/)
  })
})

describe('the menu', () => {
  const menu: GlassesMenu = {
    appointments: [
      { title: 'Maya: park', date: '2026-10-24', time: '14:00' },
      { title: 'Dr Lee checkup', date: '2026-10-25', time: '09:30' },
      { title: 'Blood test', date: '2026-10-27', time: null },
    ],
    medicines: [
      { title: 'Donepezil 5 mg', times: ['08:00', '20:00'], takenToday: 1, daysLeft: 29, low: false },
      { title: 'Memantine 10 mg', times: ['09:00'], takenToday: 0, daysLeft: 5, low: true },
    ],
    family: [{ name: 'Maya', relation: 'Daughter' }, { name: 'Raj', relation: '' }],
  }
  const body = (s: string) => s.split('\n')
  // Every page of a menu item, one after another
  const allPages = (page: Parameters<typeof detailScreen>[0], m = menu) =>
    Array.from({ length: detailScreen(page, m, now, 0).pages }, (_, n) => detailScreen(page, m, now, n).text.split('\n').slice(2, -3).filter(Boolean).join('\n')).join('\n')

  test('home says how to open the menu', () => {
    assert.match(buildScreen({ ...base, state: state() }), /Tap then hold for menu$/)
  })

  test('nothing else on screen offers the menu: a card that wants the tap keeps it', () => {
    const message = { kind: 'message' as const, id: 'm1', text: 'Hi' }
    assert.doesNotMatch(buildScreen({ ...base, state: state(), care: message }), /menu/)
    assert.doesNotMatch(buildScreen({ ...base, mic: 'paused', state: state() }), /menu/)
  })

  test('the glasses menu starts with Today (home), then the three pages, with ids it accepts', () => {
    assert.deepEqual(MENU.map(m => m.label), ['Today', 'Appointments', 'Medications', 'Family'])
    assert.deepEqual(MENU.map(m => m.page), [null, 'appointments', 'medications', 'family'])
    assert.equal(new Set(MENU.map(m => m.id)).size, MENU.length)
    assert.ok(MENU.every(m => Number.isInteger(m.id) && m.id > 0))
  })

  test('appointments are grouped by day, with times', () => {
    assert.match(detailScreen('appointments', menu, now, 0).text, /^Appointments\n\nToday\n/)
    assert.match(detailScreen('appointments', menu, now, 0).text, /Tap: back$/)
    assert.equal(allPages('appointments'), 'Today\n2 PM  Maya: park\nTomorrow\n9:30 AM  Dr Lee checkup\nTue 27 Oct\nAll day  Blood test')
  })

  test('medications show their times, today\'s doses, and which are running low', () => {
    assert.match(detailScreen('medications', menu, now, 0).text, /^Medications\n\n1 is running low\n/)
    const s = allPages('medications')
    assert.match(s, /Donepezil 5 mg\n8 AM, 8 PM {2}\(1 of 2 taken\)/)
    assert.match(s, /Memantine 10 mg\n9 AM {2}\(0 of 1 taken\)\n! Running low: 5 days left/)
  })

  test('family members with how they are related', () => {
    const s = detailScreen('family', menu, now, 0).text
    assert.equal(s, 'Family\n\nMaya, your daughter\nRaj\n\nTap: back')
  })

  test('empty pages say so, and a page still loading says that', () => {
    const none: GlassesMenu = { appointments: [], medicines: [], family: [] }
    assert.match(detailScreen('appointments', none, now, 0).text, /No appointments in the\nnext 3 days/)
    assert.match(detailScreen('medications', none, now, 0).text, /No medicines/)
    assert.match(detailScreen('family', none, now, 0).text, /No family/)
    assert.match(detailScreen('family', null, now, 0).text, /Loading/)
  })

  test('a long page is split, says how to see more, and every page fits the display', () => {
    const many: GlassesMenu = { ...menu, family: Array.from({ length: 12 }, (_, n) => ({ name: `Person ${n + 1}`, relation: 'friend' })) }
    const first = detailScreen('family', many, now, 0)
    assert.ok(first.pages > 1)
    assert.match(first.text, /Swipe for more {2}1\/\d/)
    for (let p = 0; p < first.pages; p++) {
      const { text } = detailScreen('family', many, now, p)
      assert.ok(body(layoutForDisplay(text)).length <= MAX_LINES, text)
      assert.match(text, /Tap: back$/)
    }
    assert.match(detailScreen('family', many, now, first.pages - 1).text, /Person 12/)
    const heights = Array.from({ length: first.pages }, (_, p) => body(detailScreen('family', many, now, p).text).length)
    assert.equal(new Set(heights).size, 1, `every page the same height: ${heights}`)
    assert.equal(detailScreen('family', many, now, 99).text, detailScreen('family', many, now, first.pages - 1).text)
  })
})

describe('who is talking', () => {
  const maya = { name: 'Maya', relation: 'granddaughter', fact: 'Coming to the park with you on Saturday' }

  test('shows the name, how they are related, and one recent fact', () => {
    const s = buildScreen({ ...base, state: state(), person: maya })
    assert.equal(s, ['This is', '', 'Maya', 'Your granddaughter', '', 'Coming to the park with you on', 'Saturday'].join('\n'))
  })

  test('comes before a waiting message, but after a question', () => {
    const message = { kind: 'message' as const, id: 'm1', text: 'Hi' }
    assert.match(buildScreen({ ...base, state: state(), person: maya, care: message }), /^This is/)
    const prompt = { id: 'p1', lines: ['Park with Maya at 2 PM?', 'Say yes or no'], expiresAt: now.toISOString() }
    assert.match(buildScreen({ ...base, state: state({ prompt }), person: maya }), /^Park with Maya/)
  })

  test('works without a relation or fact', () => {
    assert.equal(buildScreen({ ...base, state: state(), person: { name: 'Raj', relation: '', fact: '' } }), 'This is\n\nRaj')
  })
})
