import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { glassesMenu } from './glasses-menu.ts'
import { medKey } from '../src/schedule.ts'
import type { Appointment, DoseLog, HaloData, Medicine, Person, Plan } from '../src/types'

const now = new Date(2026, 9, 24, 10, 0) // Sat 24 Oct, 10 AM

const med = (o: Partial<Medicine>): Medicine => ({
  name: 'Donepezil', strength: '5 mg', form: 'tablet', instructions: 'with food', times: ['08:00', '20:00'], quantity: 60, refills: 1, ...o,
})
const person = (name: string, relation: string): Person => ({ id: name, name, relation, blurb: '', voiceFile: '', createdAt: '' })
const plan = (start: Date, o: Partial<Plan> = {}): Plan => ({
  id: String(start.getTime()), activity: 'park', who: ['Maya'], start: start.toISOString(), allDay: false,
  status: 'confirmed', confirmedBy: 'patient', createdAt: '', source: { lineId: 'l1', quote: '' }, ...o,
})

function data(o: { medicines?: Medicine[]; appointments?: Appointment[]; people?: Person[]; stock?: HaloData['stock'] } = {}): HaloData {
  return {
    patient: { name: 'Joe' },
    people: o.people ?? [],
    stock: o.stock,
    prescriptions: [{
      id: 'rx1', file: '', originalName: '', doctor: 'Dr Lee', date: '2026-10-01', notes: '', uploadedAt: '2026-10-01T00:00:00Z',
      reading: { medicines: o.medicines ?? [], appointments: o.appointments ?? [], notes: [], readAt: '' },
    }],
  }
}

describe('the glasses menu', () => {
  test('appointments from now through three days ahead, soonest first, from prescriptions and the calendar', () => {
    const d = data({
      appointments: [
        { title: 'Dr Lee checkup', date: '2026-10-26', time: '09:30' },
        { title: 'Earlier today', date: '2026-10-24', time: '08:00' },
        { title: 'Too far off', date: '2026-10-28', time: '09:00' },
        { title: 'Blood test', date: '2026-10-27', time: null },
      ],
    })
    const plans = [plan(new Date(2026, 9, 24, 14, 0)), plan(new Date(2026, 9, 25, 11, 0), { status: 'asked' })]
    const m = glassesMenu(d, [], plans, now)
    assert.deepEqual(m.appointments.map(a => [a.date, a.time, a.title]), [
      ['2026-10-24', '14:00', 'Maya: park'],
      ['2026-10-26', '09:30', 'Dr Lee checkup'],
      ['2026-10-27', null, 'Blood test'],
    ])
  })

  test('medicines with their times, doses taken today, and whether they are running low', () => {
    const d = data({
      medicines: [med({}), med({ name: 'Memantine', times: ['09:00'] }), med({ name: 'Old pill', stopped: true })],
      stock: { [medKey('rx1', 1)]: { count: 5, at: '2026-10-20T00:00:00Z' } },
    })
    const doses: DoseLog[] = [
      { medKey: medKey('rx1', 0), slot: '2026-10-24 08:00', at: '2026-10-24T08:05:00' },
      { medKey: medKey('rx1', 0), slot: '2026-10-23 20:00', at: '2026-10-23T20:05:00' },
    ]
    const m = glassesMenu(d, doses, [], now)
    assert.deepEqual(m.medicines.map(x => [x.title, x.times, x.takenToday, x.low]), [
      ['Donepezil 5 mg', ['08:00', '20:00'], 1, false],
      ['Memantine 5 mg', ['09:00'], 0, true],
    ])
    assert.equal(m.medicines[1].daysLeft, 5)
  })

  test('the family, as the portal has them', () => {
    const m = glassesMenu(data({ people: [person('Maya', 'Daughter'), person('Raj', 'neighbor')] }), [], [], now)
    assert.deepEqual(m.family, [{ name: 'Maya', relation: 'Daughter' }, { name: 'Raj', relation: 'neighbor' }])
  })
})
