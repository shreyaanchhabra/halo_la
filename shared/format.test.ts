import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { googleCalendarUrl, planTitle, timeLabel, whenLabel } from './format.ts'

const now = new Date(2026, 9, 17, 10, 0)
const plan = { who: ['Maya'], activity: 'park', start: new Date('2026-10-24T21:00:00.000Z').toISOString(), allDay: false, source: { lineId: 'l', quote: "I'll come by Saturday at 2" } }

describe('wording', () => {
  test('titles', () => {
    assert.equal(planTitle(plan), 'Maya: park')
    assert.equal(planTitle({ who: [], activity: 'dentist appointment' }), 'dentist appointment')
    assert.equal(planTitle({ who: ['Maya', 'Paul'], activity: 'barbecue' }), 'Maya & Paul: barbecue')
  })
  test('times', () => {
    assert.equal(timeLabel(new Date(2026, 9, 24, 14, 0)), '2 PM')
    assert.equal(timeLabel(new Date(2026, 9, 24, 9, 30)), '9:30 AM')
    assert.equal(timeLabel(new Date(2026, 9, 24, 0, 5)), '12:05 AM')
  })
  test('days', () => {
    assert.equal(whenLabel({ start: new Date(2026, 9, 17, 18, 0).toISOString(), allDay: false }, now), 'Today 6 PM')
    assert.equal(whenLabel({ start: new Date(2026, 9, 18, 0, 0).toISOString(), allDay: true }, now), 'Tomorrow')
    assert.equal(whenLabel({ start: new Date(2026, 9, 24, 14, 0).toISOString(), allDay: false }, now), 'Sat 24 Oct 2 PM')
  })
})

describe('Google Calendar link', () => {
  const q = (u: string) => new URL(u).searchParams
  test('opens Google Calendar with the event filled in', () => {
    const u = googleCalendarUrl(plan)
    assert.ok(u.startsWith('https://calendar.google.com/calendar/render?'))
    assert.equal(q(u).get('action'), 'TEMPLATE')
    assert.equal(q(u).get('text'), 'Maya: park')
    assert.equal(q(u).get('dates'), '20261024T210000Z/20261024T220000Z')
    assert.equal(q(u).get('details'), `HALO heard: "I'll come by Saturday at 2"`)
  })
  test('an all-day event uses dates, ending the next day', () => {
    const u = googleCalendarUrl({ ...plan, allDay: true, start: new Date(2026, 9, 25).toISOString() })
    assert.equal(q(u).get('dates'), '20261025/20261026')
  })
  test('a plan added by hand has no details', () => {
    assert.equal(q(googleCalendarUrl({ ...plan, source: undefined })).get('details'), null)
  })
  test('awkward characters survive', () => {
    assert.equal(q(googleCalendarUrl({ ...plan, activity: 'tea & cake, 50% off' })).get('text'), 'Maya: tea & cake, 50% off')
  })
})
