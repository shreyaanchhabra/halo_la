import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { appointments, buildIcs, scheduleFor } from './schedule.ts'
import type { HaloData, Plan } from './types'

const data: HaloData = { patient: { name: 'Joe Martinez' }, people: [], prescriptions: [] }
const plan = (o: Partial<Plan>): Plan => ({
  id: 'p1', activity: 'park', who: ['Maya'], start: new Date(2026, 9, 24, 14, 0).toISOString(), allDay: false,
  status: 'confirmed', confirmedBy: 'patient', createdAt: '2026-10-17T10:00:00Z', source: { lineId: 'l1', quote: "I'll come by Saturday at 2" }, ...o,
})
const day = new Date(2026, 9, 24, 9, 0)

describe('plans in the schedule', () => {
  test('a confirmed plan is on its day, with the time and who', () => {
    const items = scheduleFor(data, day, [plan({})])
    assert.deepEqual(items.map(i => [i.time, i.title, i.kind]), [['14:00', 'Maya: park', 'plan']])
    assert.equal(items[0].detail, 'You said yes to this')
  })

  test('plans that are not confirmed are not on the schedule', () => {
    for (const status of ['asked', 'queued', 'declined', 'needs_approval', 'rejected'] as const) {
      assert.equal(scheduleFor(data, day, [plan({ status })]).length, 0, status)
    }
  })

  test('a plan on another day is not on this day, but is in coming up', () => {
    assert.equal(scheduleFor(data, new Date(2026, 9, 25), [plan({})]).length, 0)
    assert.deepEqual(appointments(data, [plan({})]).map(a => [a.date, a.time, a.title]), [['2026-10-24', '14:00', 'Maya: park']])
  })

  test('an all-day plan has no time', () => {
    const a = appointments(data, [plan({ allDay: true })])[0]
    assert.equal(a.time, null)
  })

  test('the old two-argument calls still work', () => {
    assert.deepEqual(scheduleFor(data, day), [])
    assert.deepEqual(appointments(data), [])
  })
})

describe('plans in the .ics file', () => {
  const ics = (plans: Plan[]) => buildIcs(data, plans)

  test('a timed plan: local start, one hour, title, the quote, and a reminder an hour before', () => {
    const f = ics([plan({})])
    assert.match(f, /UID:p1@halo/)
    assert.match(f, /DTSTART:20261024T140000/)
    assert.match(f, /DURATION:PT1H/)
    assert.match(f, /SUMMARY:Maya: park/)
    assert.match(f, /HALO heard: "I'll come by Saturday at 2"/)
    assert.match(f, /TRIGGER:-PT1H/)
  })

  test('an all-day plan is a date', () => {
    assert.match(ics([plan({ allDay: true, start: new Date(2026, 9, 25).toISOString() })]), /DTSTART;VALUE=DATE:20261025/)
  })

  test('only confirmed plans are included', () => {
    const f = ics([plan({ id: 'a' }), plan({ id: 'b', status: 'asked' }), plan({ id: 'c', status: 'needs_approval' })])
    assert.match(f, /UID:a@halo/)
    assert.doesNotMatch(f, /UID:[bc]@halo/)
  })

  test('commas and semicolons in the words are escaped', () => {
    assert.ok(ics([plan({ activity: 'tea, cake; chat' })]).includes('SUMMARY:Maya: tea\\, cake\\; chat'))
  })

  test('begins and ends as a calendar, with CRLF line endings', () => {
    const f = ics([plan({})])
    assert.ok(f.startsWith('BEGIN:VCALENDAR\r\n'))
    assert.ok(f.endsWith('END:VCALENDAR\r\n'))
  })
})
