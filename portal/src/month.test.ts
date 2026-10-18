import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { gridDays, longDate, monthGridHtml, monthTitle, shiftMonth, type Mark } from './month.ts'

const oct = new Date(2026, 9, 1) // 1 Oct 2026 is a Thursday
const html = (marksFor: (d: string) => Mark[] = () => [], over = {}) =>
  monthGridHtml({ view: oct, selected: '2026-10-17', today: '2026-10-17', marksFor, ...over })
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

describe('month grid', () => {
  test('always six weeks, starting on the Sunday on or before the 1st', () => {
    const days = gridDays(oct)
    assert.equal(days.length, 42)
    assert.equal(days[0].getDay(), 0)
    assert.deepEqual([days[0].getMonth(), days[0].getDate()], [8, 27]) // Sun 27 Sep
    assert.equal(days[41].getDate(), 7) // Sat 7 Nov
  })

  test('a month that starts on a Sunday has no days from the month before', () => {
    assert.equal(gridDays(new Date(2026, 10, 1))[0].getDate(), 1)
  })

  test('42 day buttons and 7 weekday headings', () => {
    const h = html()
    assert.equal(count(h, /<button type="button" class="day/g), 42)
    assert.equal(count(h, /role="columnheader"/g), 7)
  })

  test('today and the selected day are marked, and only those', () => {
    const h = html(() => [], { today: '2026-10-17', selected: '2026-10-20' })
    assert.equal(count(h, / today/g), 1)
    assert.equal(count(h, / sel"/g), 1)
    assert.match(h, /data-day="2026-10-20"[^>]*aria-pressed="true"/)
    assert.match(h, /data-day="2026-10-21"[^>]*aria-pressed="false"/)
  })

  test('days from other months are dimmed', () => {
    const h = html()
    assert.match(h, /class="day out"[^>]*data-day="2026-09-27"/)
    assert.doesNotMatch(h, /class="day out"[^>]*data-day="2026-10-15"/)
  })

  test('events appear as chips with their time, and are counted for screen readers', () => {
    const h = html(d => d === '2026-10-24' ? [{ time: '2 PM', label: 'Maya: park', cls: '', at: 1 }] : [])
    assert.match(h, /<span class="chip " title="2 PM Maya: park">2 PM Maya: park<\/span>/)
    assert.match(h, /aria-label="Saturday, October 24, 1 event"/)
    assert.match(h, /aria-label="Sunday, October 25, 0 events"/)
  })

  test('only a few chips are shown, with "+N more" for the rest', () => {
    const many = (d: string): Mark[] => d === '2026-10-24' ? [1, 2, 3, 4, 5].map(n => ({ time: '', label: `Event ${n}`, cls: '', at: n })) : []
    assert.equal(count(html(many), /class="chip /g), 3)
    assert.match(html(many), /\+2 more/)
    assert.equal(count(html(many, { maxChips: 2 }), /class="chip /g), 2)
    assert.match(html(many, { maxChips: 2 }), /\+3 more/)
  })

  test('a day\'s events are in time order, whatever order they were given in', () => {
    const at = (h: number) => new Date(2026, 9, 18, h).getTime()
    const marks: Mark[] = [
      { time: '10:00 AM', label: 'Pickup', cls: '', at: at(10) },
      { time: '9:00 PM', label: 'Evening', cls: '', at: at(21) },
      { time: '7:30 AM', label: 'Early', cls: '', at: at(7.5) },
      { time: '', label: 'All day', cls: '', at: at(0) },
    ]
    const h = html(d => d === '2026-10-18' ? marks : [], { maxChips: 4 })
    const order = [...h.matchAll(/class="chip " title="[^"]*">([^<]*)</g)].map(m => m[1])
    assert.deepEqual(order, ['All day', '7:30 AM Early', '10:00 AM Pickup', '9:00 PM Evening'])
  })

  test('only the first few in time order are shown, so a late event is the one folded into "more"', () => {
    const at = (h: number) => new Date(2026, 9, 18, h).getTime()
    const h = html(d => d === '2026-10-18' ? [
      { time: '9 PM', label: 'Late', cls: '', at: at(21) }, { time: '7 AM', label: 'A', cls: '', at: at(7) },
      { time: '8 AM', label: 'B', cls: '', at: at(8) }, { time: '10 AM', label: 'C', cls: '', at: at(10) },
    ] : [], { maxChips: 3 })
    assert.doesNotMatch(h, />9 PM Late</)
    assert.match(h, /\+1 more/)
  })

  test('chip styles follow the kind of event', () => {
    const h = html(() => [], {})
    assert.doesNotMatch(h, /class="chip/)
    const g = html(d => d === '2026-10-20' ? [{ time: '', label: 'a', cls: 'pending', at: 1 }, { time: '', label: 'b', cls: 'appt', at: 2 }] : [])
    assert.match(g, /class="chip pending"/)
    assert.match(g, /class="chip appt"/)
  })

  test('words in an event cannot inject HTML', () => {
    const h = html(d => d === '2026-10-20' ? [{ time: '', label: '<img src=x onerror=alert(1)>', cls: '', at: 1 }] : [])
    assert.doesNotMatch(h, /<img/)
    assert.match(h, /&#60;img/)
  })
})

describe('moving between months', () => {
  test('across a year boundary', () => {
    assert.deepEqual([shiftMonth(new Date(2026, 11, 1), 1).getFullYear(), shiftMonth(new Date(2026, 11, 1), 1).getMonth()], [2027, 0])
    assert.deepEqual([shiftMonth(new Date(2026, 0, 1), -1).getFullYear(), shiftMonth(new Date(2026, 0, 1), -1).getMonth()], [2025, 11])
  })
  test('titles and long dates', () => {
    assert.equal(monthTitle(oct), 'October 2026')
    assert.equal(longDate('2026-10-24'), 'Saturday, October 24')
  })
})
