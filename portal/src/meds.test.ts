import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { medKey } from './schedule.ts'
import { runningLow, supply, supplyText, allMedicines } from './meds.ts'
import type { DoseLog, HaloData } from './types'

const KEY = medKey('rx1', 0)
const care = (count: number | null, times = ['21:00'], quantity: number | null = 30): HaloData => ({
  patient: { name: 'Joe' }, people: [],
  prescriptions: [{ id: 'rx1', file: 'f', originalName: 'rx.pdf', doctor: 'Dr. Patel', date: '2026-10-01', notes: '', uploadedAt: '2026-10-01T00:00:00Z',
    reading: { medicines: [{ name: 'Donepezil', strength: '5 mg', form: 'tablet', instructions: '', times, quantity, refills: 1 }], appointments: [], notes: [], readAt: '' } }],
  ...(count == null ? {} : { stock: { [KEY]: { count, at: '2026-10-17T00:00:00Z' } } }),
})
const taken = (n: number): DoseLog[] => Array.from({ length: n }, (_, i) => ({ medKey: KEY, slot: `2026-10-1${7 + i} 21:00`, at: `2026-10-1${7 + i}T21:00:00Z` }))
const entry = (d: HaloData) => allMedicines(d)[0]

describe('how much is left', () => {
  test('the family count minus doses taken since it was counted', () => {
    assert.equal(supply(entry(care(8)), care(8), taken(1))?.left, 7)
    assert.equal(supply(entry(care(8)), care(8), [])?.left, 8)
  })
  test('doses logged before the count are not subtracted again', () => {
    const early: DoseLog[] = [{ medKey: KEY, slot: '2026-10-16 21:00', at: '2026-10-16T21:00:00Z' }]
    assert.equal(supply(entry(care(8)), care(8), early)?.left, 8)
  })
  test('with no count, it starts from the prescribed quantity', () => {
    assert.equal(supply(entry(care(null)), care(null), taken(2))?.left, 28)
  })
  test('never below zero', () => assert.equal(supply(entry(care(1)), care(1), taken(3))?.left, 0))
  test('unknown when there is no count and no quantity', () => assert.equal(supply(entry(care(null, ['21:00'], null)), care(null, ['21:00'], null), []), null))
})

describe('running low', () => {
  test('8 days is fine, 7 days is low', () => {
    assert.equal(runningLow(care(8), []).length, 0)
    assert.equal(runningLow(care(8), taken(1)).length, 1)
  })
  test('twice a day uses up pills twice as fast', () => {
    assert.equal(runningLow(care(14, ['08:00', '20:00']), []).length, 1)
    assert.equal(runningLow(care(16, ['08:00', '20:00']), []).length, 0)
  })
  test('fewest days first', () => {
    const d = care(5)
    d.prescriptions.push({ ...d.prescriptions[0], id: 'rx2', reading: { ...d.prescriptions[0].reading!, medicines: [{ ...d.prescriptions[0].reading!.medicines[0], name: 'Memantine' }] } })
    d.stock = { ...d.stock, [medKey('rx2', 0)]: { count: 3, at: '2026-10-17T00:00:00Z' } }
    assert.deepEqual(runningLow(d, []).map(x => x.entry.med.name), ['Memantine', 'Donepezil'])
  })
  test('the words', () => {
    assert.equal(supplyText({ left: 7, days: 7, low: true }), '7 pills left (about 7 days)')
    assert.equal(supplyText({ left: 1, days: 1, low: true }), '1 pill left (about 1 day)')
    assert.equal(supplyText({ left: 5, days: null, low: false }), '5 pills left')
  })
})
