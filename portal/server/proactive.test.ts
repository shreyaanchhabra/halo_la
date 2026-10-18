import { test } from 'node:test'
import assert from 'node:assert/strict'
import { careSummaryText, doseUpdateText } from './proactive.ts'
import type { DoseLog, HaloData, Plan } from '../src/types'

const NOW = new Date('2026-10-18T09:00:00')

test('dose action updates clearly say when a dose was taken or unmarked', () => {
  assert.equal(doseUpdateText('Neo', 'Donepezil 5 mg', '2026-10-18 08:00', true), 'Good news: Neo marked Donepezil 5 mg as taken for the 8:00 AM dose.')
  assert.equal(doseUpdateText('Neo', 'Donepezil 5 mg', '2026-10-18 08:00', false), "Dose update: Neo's Donepezil 5 mg 8:00 AM dose was marked not taken.")
})

test('on-request care summary reports dose status and upcoming appointments only', () => {
  const data: HaloData = {
    patient: { name: 'Neo' }, people: [], prescriptions: [{
      id: 'rx1', file: '', originalName: '', doctor: '', date: '2026-01-01', notes: '', uploadedAt: '',
      reading: {
        medicines: [{ name: 'Donepezil', strength: '5 mg', form: 'tablet', instructions: '', times: ['08:00', '20:00'], quantity: 60, refills: 1 }],
        appointments: [{ title: 'Dr Lee', date: '2026-10-19', time: '10:30' }], notes: [], readAt: '',
      },
    }],
  }
  const doses: DoseLog[] = [{ medKey: 'rx1:0', slot: '2026-10-18 08:00', at: '2026-10-18T08:05:00.000Z' }]
  const plans: Plan[] = []
  const text = careSummaryText(data, doses, plans, NOW)
  assert.match(text, /Care summary for Neo/)
  assert.match(text, /Donepezil 5 mg at 8:00 AM: taken/)
  assert.match(text, /Donepezil 5 mg at 8:00 PM: not yet marked taken/)
  assert.match(text, /Dr Lee.*10:30 AM/)
  assert.doesNotMatch(text, /Good morning|coming up tomorrow/)
})
