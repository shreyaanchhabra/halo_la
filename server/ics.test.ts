import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { toIcs } from './ics.ts'
import type { Plan } from '../shared/calendar.ts'

const NOW = new Date('2026-10-17T10:00:00Z')
const plan = (o: Partial<Plan>): Plan => ({
  id: 'abc-123', activity: 'park', who: ['Maya'], start: '2026-10-24T21:00:00.000Z', allDay: false,
  status: 'confirmed', confirmedBy: 'patient', createdAt: NOW.toISOString(), source: { lineId: 'l1', quote: "I'll come by Saturday at 2" }, ...o,
})

describe('ics feed', () => {
  test('is a well-formed calendar with CRLF line endings', () => {
    const ics = toIcs([plan({})], 'Joe', NOW)
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'))
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'))
    assert.ok(!/[^\r]\n/.test(ics), 'no bare newlines')
    const count = (s: string) => ics.split(s).length - 1
    assert.equal(count('BEGIN:VEVENT'), count('END:VEVENT'))
    assert.equal(count('BEGIN:VALARM'), count('END:VALARM'))
  })

  test('a timed event has a UTC start, a one-hour end, a title, the quote and a reminder an hour before', () => {
    const ics = toIcs([plan({})], 'Joe', NOW)
    assert.match(ics, /UID:abc-123@halo/)
    assert.match(ics, /DTSTART:20261024T210000Z/)
    assert.match(ics, /DTEND:20261024T220000Z/)
    assert.match(ics, /SUMMARY:Maya: park/)
    assert.match(ics, /HALO heard: "I'll come by Saturday at 2"/)
    assert.match(ics, /TRIGGER:-PT1H/)
  })

  test('an all-day event uses a date, ending the next day', () => {
    const ics = toIcs([plan({ allDay: true, start: new Date(2026, 9, 25).toISOString() })], 'Joe', NOW)
    assert.match(ics, /DTSTART;VALUE=DATE:20261025/)
    assert.match(ics, /DTEND;VALUE=DATE:20261026/)
  })

  test('only confirmed plans are published', () => {
    const ics = toIcs([plan({ id: 'a' }), plan({ id: 'b', status: 'asked' }), plan({ id: 'c', status: 'declined' }), plan({ id: 'd', status: 'needs_approval' })], 'Joe', NOW)
    assert.match(ics, /UID:a@halo/)
    assert.doesNotMatch(ics, /UID:[bcd]@halo/)
  })

  test('commas, semicolons and line breaks are escaped', () => {
    const ics = toIcs([plan({ activity: 'tea, cake; chat', source: { lineId: 'x', quote: 'a\nb' } })], 'Joe', NOW)
    assert.match(ics, /SUMMARY:Maya: tea\\, cake\\; chat/)
    assert.match(ics, /a\\nb/)
  })

  test('no line is longer than 75 bytes, and folding loses nothing', () => {
    const quote = 'word '.repeat(60) + 'é'.repeat(30)
    const ics = toIcs([plan({ source: { lineId: 'x', quote } })], 'Joe', NOW)
    for (const l of ics.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, `${Buffer.byteLength(l)} bytes: ${l.slice(0, 40)}`)
    assert.ok(ics.replace(/\r\n /g, '').includes(quote))
  })

  test('an empty calendar is still valid', () => {
    const ics = toIcs([], '', NOW)
    assert.match(ics, /X-WR-CALNAME:HALO\r\n/)
    assert.doesNotMatch(ics, /VEVENT/)
  })
})
