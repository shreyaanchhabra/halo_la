import fs from 'node:fs'
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseAnswer, parseDoseAnswer } from './yesno.ts'
import { findWhen } from './when.ts'
import { createCalendar, type Care } from './calendar.ts'

// Plans that need the model run only when a Groq key is available (portal/.env or the environment)
const apiKey = process.env.GROQ_API_KEY ?? (() => {
  try { return /^GROQ_API_KEY=(.+)$/m.exec(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'))?.[1].trim() ?? '' } catch { return '' }
})()
const hasKey = () => Boolean(apiKey)

const care: Care = { patient: 'Joe Martinez', people: [{ name: 'Maya', relation: 'granddaughter' }, { name: 'Paul', relation: 'friend' }] }
const fresh = () => createCalendar({ apiKey, dataDir: ':memory:', care: () => care, answerWindowMs: 60_000 })
let cal = fresh()
const P = () => cal._db().plans

// Saturday 17 Oct 2026, 10:00, the day this was written
const NOW = new Date('2026-10-17T10:00:00')
const at = (secs: number) => new Date(NOW.getTime() + secs * 1000)
const fmt = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

describe('yes / no', () => {
  const yes = ['yes', 'Yeah, sure', 'yep', 'okay add it', 'Yes please.', 'go ahead', 'sounds good']
  const no = ['no', 'No.', 'nope', "no don't", 'not now', 'cancel', 'nah']
  const neither = ['maybe', 'Saturday is lovely', "I think Saturday was lovely and yes", 'what time is it', '', 'hello Joe how are you']
  for (const t of yes) test(`"${t}" is yes`, () => assert.equal(parseAnswer(t), 'yes'))
  for (const t of no) test(`"${t}" is no`, () => assert.equal(parseAnswer(t), 'no'))
  for (const t of neither) test(`"${t}" is neither`, () => assert.equal(parseAnswer(t), null))
})

describe('medication taken / not taken answers', () => {
  const yes = ['taken', 'Taken it', 'I took it', 'I have taken it', 'already took it']
  const no = ['not taken', 'not taken it', "I didn't take it", "I haven't taken it", 'I have not taken it']
  for (const text of yes) test(`"${text}" marks a dose taken`, () => assert.equal(parseDoseAnswer(text), 'yes'))
  for (const text of no) test(`"${text}" leaves a dose not taken`, () => assert.equal(parseDoseAnswer(text), 'no'))
  test('ordinary conversation is not a dose answer', () => assert.equal(parseDoseAnswer('I think I took it yesterday after dinner'), null))
})

describe('date and time finder', () => {
  test('Saturday said on a Saturday means next Saturday', () => {
    const [w] = findWhen("I'll come by Saturday at 2", NOW)
    assert.equal(fmt(w.start.toISOString()), 'Sat, Oct 24, 2:00 PM')
  })
  test('"at 2" with no am/pm is the afternoon, "at 9" stays morning', () => {
    assert.equal(findWhen('tomorrow at 2', NOW)[0].start.getHours(), 14)
    assert.equal(findWhen('tomorrow at 9', NOW)[0].start.getHours(), 9)
  })
  test('explicit am is respected', () => assert.equal(findWhen('Tuesday at 2 am', NOW)[0].start.getHours(), 2))
  test('a date with no time is all-day', () => assert.equal(findWhen('next Sunday', NOW)[0].allDay, true))
  test('no date or time, nothing found', () => assert.equal(findWhen('what a lovely park', NOW).length, 0))
  test('times already passed today are dropped', () => assert.equal(findWhen('at 9 am today', NOW).length, 0))
})

const live = hasKey() ? {} : { skip: 'GROQ_API_KEY not set' }

describe('Scheduler picks out calendar plans only', live, () => {
  beforeEach(() => { cal = fresh() })

  const plans: [string, string, RegExp, string][] = [
    ['Set an event for Saturday at 2 and we will go to the park', 'Maya', /park/, 'Sat, Oct 24, 2:00 PM'],
    ['Set an event for the dentist on Tuesday at 9:30 in the morning', 'Maya', /dentist/, 'Tue, Oct 20, 9:30 AM'],
    ['Set an event for dinner together tomorrow at 6', 'Maya', /dinner/, 'Sun, Oct 18, 6:00 PM'],
    ['Set an event for the barbecue on Friday at 11, Paul and I will pick you up', 'Maya', /barbecue|pick/, 'Fri, Oct 23, 11:00 AM'],
  ]
  for (const [text, speaker, activity, when] of plans) {
    test(`plan: "${text}"`, async () => {
      const out = await cal.hear(text, speaker, NOW)
      assert.equal(out.kind, 'proposed')
      if (out.kind !== 'proposed') return
      assert.match(out.plan.activity, activity)
      assert.equal(fmt(out.plan.start), when)
      assert.equal(out.plan.source?.lineId, out.line.id)
      assert.ok(out.line.text.toLowerCase().includes(out.plan.source!.quote.toLowerCase()), 'quote comes from the line')
    })
  }

  const notPlans = [
    'I went to the park on Saturday',
    'Take your tablet at 2 this afternoon',
    'Remember to take your pills tomorrow at 8',
    'I had toast and tea at 8 this morning',
    'We should go to the park sometime next week',
    "I'll be back in five minutes",
    'It is about 3 o\'clock now',
    'Did you sleep well last night?',
    'What a lovely park',
  ]
  for (const text of notPlans) {
    test(`not a plan: "${text}"`, async () => {
      const out = await cal.hear(text, 'Maya', NOW)
      assert.ok(out.kind === 'ignored', `got ${out.kind}`)
      assert.equal('error' in out ? out.error : undefined, undefined, 'the model call itself must not have failed')
      assert.equal(P().length, 0)
    })
  }

  test('patient is never listed as a participant', async () => {
    const out = await cal.hear('Set an event for Saturday at 2, Joe', 'Maya', NOW)
    assert.equal(out.kind, 'proposed')
    if (out.kind === 'proposed') assert.ok(!out.plan.who.map(w => w.toLowerCase()).includes('joe'))
  })
})

describe('ask, answer, timeout', live, () => {
  beforeEach(() => { cal = fresh() })
  const SAY = 'Set an event for Saturday at 2 and we will go to the park'

  test('proposal shows on the glasses; saying yes adds it to the calendar', async () => {
    await cal.hear(SAY, 'Maya', NOW)
    const s = cal.glassesState(at(2))
    assert.ok(s.prompt)
    assert.match(s.prompt.lines.join('\n'), /Sat 24 Oct 2 PM/)
    assert.match(s.prompt.lines.join('\n'), /yes or no/i)

    const out = await cal.hear('Yes', 'Joe', at(5))
    assert.equal(out.kind, 'answer')
    const after = cal.glassesState(at(6))
    assert.equal(after.prompt, null)
    assert.equal(after.resolved?.status, 'confirmed')
    assert.equal(P()[0].status, 'confirmed')
    assert.equal(P()[0].confirmedBy, 'patient')
  })

  test('saying no declines it, and asking again does not re-propose', async () => {
    await cal.hear(SAY, 'Maya', NOW)
    await cal.hear('No', 'Joe', at(4))
    assert.equal(P()[0].status, 'declined')
    const again = await cal.hear(SAY, 'Maya', at(30))
    assert.equal(again.kind, 'duplicate')
    assert.equal(P().length, 1)
  })

  test('ordinary conversation while a proposal is up is not taken as an answer', async () => {
    await cal.hear(SAY, 'Maya', NOW)
    const out = await cal.hear('Oh that sounds wonderful, the park is lovely in autumn', 'Joe', at(5))
    assert.equal(out.kind, 'ignored')
    assert.equal(P()[0].status, 'asked')
  })

  test('no answer in 60 seconds sends it to the family; family approves it', async () => {
    await cal.hear(SAY, 'Maya', NOW)
    cal.sweep(at(61))
    assert.equal(cal.glassesState(at(61)).prompt, null)
    assert.equal(P()[0].status, 'needs_approval')
    assert.equal(cal.glassesState(at(62)).today.length, 0)
    cal.familyAction(P()[0].id, 'approve', at(100))
    assert.equal(P()[0].status, 'confirmed')
    assert.equal(P()[0].confirmedBy, 'family')
  })

  test('the same plan said twice is one proposal', async () => {
    await cal.hear(SAY, 'Maya', NOW)
    const again = await cal.hear("Yes so Saturday at 2, don't forget the park!", 'Maya', at(10))
    assert.ok(again.kind === 'duplicate' || again.kind === 'ignored')
    assert.equal(P().length, 1)
  })

  test('a second plan waits its turn', async () => {
    await cal.hear(SAY, 'Maya', NOW)
    const second = await cal.hear('Set an event for the dentist on Tuesday at 9:30 am', 'Maya', at(5))
    assert.equal(second.kind, 'queued')
    await cal.hear('yes', 'Joe', at(10))
    const s = cal.glassesState(at(11))
    assert.ok(s.prompt, 'the dentist plan is now on screen')
    assert.match(s.prompt.lines.join('\n'), /Tue 9:30 AM/)
  })

  test('overlapping with a confirmed event is flagged', async () => {
    const existing = cal.addManual({ activity: 'hairdresser', start: '2026-10-24T14:30:00' }, NOW)
    const out = await cal.hear(SAY, 'Maya', at(1))
    assert.equal(out.kind, 'proposed')
    if (out.kind === 'proposed') assert.equal(out.plan.conflictWith, existing.id)
  })

  test('reminder list holds only events within the next hour', async () => {
    cal.addManual({ activity: 'tea with Maya', start: '2026-10-17T10:40:00' }, NOW)
    cal.addManual({ activity: 'later', start: '2026-10-17T15:00:00' }, NOW)
    const s = cal.glassesState(NOW)
    assert.deepEqual(s.upcoming.map(p => p.activity), ['tea with Maya'])
    assert.equal(s.today.length, 2)
  })
})

describe('naming who the plan is with, before voice recognition exists', live, () => {
  beforeEach(() => { cal = fresh() })
  const SAY = 'Set an event for Saturday at 2 and we will go to the park'

  test('unknown speaker, one visitor listed: "I" is that visitor', async () => {
    cal.setPresent(['Maya'])
    const out = await cal.hear(SAY, 'unknown', NOW)
    assert.equal(out.kind, 'proposed')
    if (out.kind === 'proposed') assert.deepEqual(out.plan.who, ['Maya'])
  })

  test('unknown speaker, nobody listed: no name is invented', async () => {
    const out = await cal.hear(SAY, 'unknown', NOW)
    assert.equal(out.kind, 'proposed')
    if (out.kind === 'proposed') assert.deepEqual(out.plan.who, [])
  })

  test('a name that is actually said is used even when nobody is listed', async () => {
    const out = await cal.hear('Set an event for the park on Saturday at 2 with Maya and Paul', 'unknown', NOW)
    assert.equal(out.kind, 'proposed')
    if (out.kind === 'proposed') assert.deepEqual([...out.plan.who].sort(), ['Maya', 'Paul'])
  })

  test('a known speaker wins over the visitor list', async () => {
    cal.setPresent(['Paul'])
    const out = await cal.hear(SAY, 'Maya', NOW)
    assert.equal(out.kind, 'proposed')
    if (out.kind === 'proposed') assert.ok(out.plan.who.includes('Maya'))
  })

  test('visitor list is de-duplicated and trimmed', () => {
    assert.deepEqual(cal.setPresent([' Maya ', 'Maya', '', 'Paul']), ['Maya', 'Paul'])
  })
})

describe('questions that propose a plan are asked straight away', live, () => {
  beforeEach(() => { cal = fresh() })
  const ASK = 'Set an event for basketball today at 6 PM'

  test('the question itself is put to the patient, and one yes adds it', async () => {
    const out = await cal.hear(ASK, 'Maya', NOW)
    assert.equal(out.kind, 'proposed')
    if (out.kind !== 'proposed') return
    assert.equal(out.plan.status, 'asked')
    assert.equal(fmt(out.plan.start), 'Sat, Oct 17, 6:00 PM')
    assert.match(cal.glassesState(at(1)).prompt!.lines.join('\n'), /Say yes or no/)
    const yes = await cal.hear('Yes', 'Joe', at(8))
    assert.equal(yes.kind, 'answer')
    assert.equal(P()[0].status, 'confirmed')
  })

  test('a no declines it', async () => {
    await cal.hear(ASK, 'Maya', NOW)
    await cal.hear('No, not today', 'Joe', at(5))
    assert.equal(P()[0].status, 'declined')
  })

  test('a yes with nothing asked is just a yes', async () => {
    const out = await cal.hear('Yes', 'Joe', NOW)
    assert.equal(out.kind, 'ignored')
    assert.equal(P().length, 0)
  })

  test('a question without a date or time is not a plan', async () => {
    const out = await cal.hear('Do you want to go to the park sometime?', 'Maya', NOW)
    assert.equal(out.kind, 'ignored')
  })
})

describe('calendar waits for the set-an-event command', () => {
  test('casual talk with a time is ignored without calling the model', async () => {
    const cal = createCalendar({ apiKey: 'not-a-key', dataDir: ':memory:', care: () => care })
    const out = await cal.hear("I'll come by Saturday at 2 and we'll go to the park", 'Maya', NOW)
    assert.equal(out.kind, 'ignored')
    assert.equal('error' in out ? out.error : undefined, undefined)
    assert.equal(cal._db().plans.length, 0)
  })
})

describe('the glasses see who is talking before any words', () => {
  test('noteSpeaker puts the name on the glasses, and hear fills in the text', async () => {
    const cal = createCalendar({ apiKey: 'not-a-key', dataDir: ':memory:', care: () => ({
      ...care,
      people: [{ name: 'Maya', relation: 'granddaughter', blurb: 'Studies art in Chicago. Visits on Sundays.' }],
    }) })
    cal.noteSpeaker('Maya', NOW)
    const who = cal.glassesState(NOW).heard
    assert.equal(who?.text, '')
    assert.deepEqual(who?.speaker, { name: 'Maya', relation: 'granddaughter', patient: false, blurb: 'Studies art in Chicago' })
    const hearing = cal.hear('What a lovely park', 'Maya', NOW)
    assert.equal(cal.glassesState(NOW).heard?.text, 'What a lovely park')
    assert.equal(cal.glassesState(NOW).heard?.speaker?.name, 'Maya')
    await hearing
  })
})

describe('the glasses see what was heard straight away', () => {
  test('before the plan check has answered', async () => {
    const cal = createCalendar({ apiKey: 'not-a-key', dataDir: ':memory:', care: () => care })
    const hearing = cal.hear('What a lovely park', 'Maya', NOW)
    const h = cal.glassesState(at(0)).heard
    assert.equal(h?.text, 'What a lovely park')
    assert.deepEqual(h?.speaker, { name: 'Maya', relation: 'granddaughter', patient: false })
    await hearing
  })
})

describe('the glasses are told what was heard', live, () => {
  beforeEach(() => { cal = fresh() })

  test('something that is not a plan is shown, with why nothing happened', async () => {
    await cal.hear('Remember to take your tablet at 2 this afternoon', 'Maya', NOW)
    const h = cal.glassesState(at(2)).heard
    assert.equal(h?.text, 'Remember to take your tablet at 2 this afternoon')
    assert.equal(h?.note, 'Not a calendar plan')
    assert.deepEqual(h?.speaker, { name: 'Maya', relation: 'granddaughter', patient: false })
  })

  test('says who it was: the patient, a saved person, or no one for a voice it could not place', async () => {
    const who = async (speaker: string) => { await cal.hear('What a lovely park', speaker, NOW); return cal.glassesState(at(1)).heard?.speaker }
    assert.deepEqual(await who('Joe Martinez'), { name: 'Joe Martinez', relation: '', patient: true })
    assert.deepEqual(await who('Maya'), { name: 'Maya', relation: 'granddaughter', patient: false })
    assert.equal(await who('unknown'), null)
    assert.equal(await who('Guest 2'), null)
  })

  test('it disappears after a few seconds', async () => {
    await cal.hear('What a lovely park', 'Maya', NOW)
    assert.ok(cal.glassesState(at(5)).heard)
    assert.equal(cal.glassesState(at(20)).heard, null)
  })

  test('when a question is on screen, the question takes the screen instead', async () => {
    await cal.hear('Set an event for Saturday at 2 and we will go to the park', 'Maya', NOW)
    const s = cal.glassesState(at(1))
    assert.ok(s.prompt)
    assert.equal(s.heard, null)
  })
})
