import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RefillService, emptyRefills } from './refills.ts'

const input = { sku: 'donepezil-5mg-30', prescriptionId: 'rx-001', doctor: 'Dr. Patel', tabletsPerDay: 1, tabletsRemaining: 8, doctorConfirmed: true }
function setup(remaining = 8) {
  let now = new Date('2026-10-17T17:00:00Z')
  let saves = 0
  const service = new RefillService(emptyRefills(), () => { saves++ }, () => now)
  const medication = service.addMedication({ ...input, tabletsRemaining: remaining })
  return { service, medication, advance: (ms: number) => { now = new Date(now.getTime() + ms) }, saves: () => saves }
}
function quoted() {
  const f = setup(7)
  const refill = f.service.data.refills[0]
  f.service.prepare(refill.id)
  return { ...f, refill, approval: { approvedBy: 'Maya', expectedTotalCents: 1240 } }
}

test('crossing 7 days creates one refill, and repeated dose IDs do not decrement twice', () => {
  const { service: s, medication: m, saves } = setup()
  assert.equal(s.data.refills.length, 0)
  s.dose(m.id, { eventId: 'dose-1', tablets: 1 })
  s.dose(m.id, { eventId: 'dose-1', tablets: 1 })
  s.check(); s.check()
  assert.equal(m.tabletsRemaining, 7)
  assert.equal(s.data.refills.length, 1)
  assert.equal(s.data.doses.length, 1)
  assert.ok(saves() > 0)
})
test('threshold uses prescribed daily consumption', () => {
  const s = new RefillService(emptyRefills())
  s.addMedication({ ...input, tabletsPerDay: 2, tabletsRemaining: 14 })
  assert.equal(s.data.refills.length, 1)
})
test('a dose ID cannot be reused with different details, and stock cannot go negative', () => {
  const { service: s, medication: m } = setup(1)
  s.dose(m.id, { eventId: 'dose-1', tablets: 1 })
  assert.throws(() => s.dose(m.id, { eventId: 'dose-1', tablets: 2 }), /different details/)
  assert.throws(() => s.dose(m.id, { eventId: 'dose-2', tablets: 1 }), /exceeds recorded stock/)
})
test('checkout requires family approval of the exact quote', () => {
  const { service: s, refill: r } = quoted()
  assert.throws(() => s.place(r.id), /approval is required/)
  assert.throws(() => s.approve(r.id, { approvedBy: 'Maya', expectedTotalCents: 1200 }), /price changed/)
  assert.throws(() => s.approve(r.id, { approvedBy: '', expectedTotalCents: 1240 }), /approvedBy/)
  assert.equal(r.status, 'awaiting_approval')
})
test('limit blocks approval and is rechecked immediately before checkout', () => {
  const { service: s, refill: r, approval } = quoted()
  s.setLimit(1000)
  assert.throws(() => s.approve(r.id, approval), /spending limit/)
  s.setLimit(1240); s.approve(r.id, approval); s.setLimit(1239)
  assert.throws(() => s.place(r.id), /spending limit/)
  assert.equal(r.orderId, undefined)
})
test('expired quotes require a fresh quote and another approval', () => {
  const { service: s, refill: r, advance, approval } = quoted()
  advance(30 * 60_000)
  assert.throws(() => s.approve(r.id, approval), /expired/)
  s.retry(r.id); s.prepare(r.id); s.approve(r.id, approval)
  assert.equal(r.status, 'ordering')
})
test('duplicate checkout and receipt calls do not duplicate orders or stock', () => {
  const { service: s, medication: m, refill: r, approval } = quoted()
  s.approve(r.id, approval)
  assert.throws(() => s.approve(r.id, approval), /not waiting/)
  s.place(r.id)
  const orderId = r.orderId
  s.place(r.id)
  assert.equal(r.orderId, orderId)
  assert.equal(m.tabletsRemaining, 7)
  s.receive(r.id); s.receive(r.id)
  assert.equal(m.tabletsRemaining, 37)
  assert.equal(s.data.activity.filter(a => a.text.includes('order TEST-')).length, 1)
})
test('rejection pauses automatic refills until explicitly requested again', () => {
  const { service: s, refill: r, approval } = quoted()
  s.reject(r.id); s.check()
  assert.equal(s.data.refills.length, 1)
  assert.throws(() => s.approve(r.id, approval), /not waiting/)
  s.retry(r.id); s.prepare(r.id)
  assert.equal(r.status, 'awaiting_approval')
})
test('unknown checkout outcome cannot be retried automatically', () => {
  const { service: s, refill: r, approval } = quoted()
  s.approve(r.id, approval); s.fail(r.id, 'timeout')
  assert.equal(r.status, 'needs_review')
  assert.throws(() => s.retry(r.id), /uncertain checkout/)
  s.check()
  assert.equal(s.data.refills.length, 1)
})
test('a confirmed order survives an automation error', () => {
  const { service: s, refill: r, approval } = quoted()
  s.approve(r.id, approval); s.place(r.id); s.fail(r.id, 'browser timed out')
  assert.equal(r.status, 'ordered')
})
test('invalid quantities, unconfirmed prescriptions and duplicate prescriptions are rejected', () => {
  const { service: s } = setup()
  assert.throws(() => s.addMedication(input), /already tracked/)
  for (const patch of [{ doctorConfirmed: false }, { tabletsPerDay: 0 }, { tabletsRemaining: -1 }, { tabletsPerDay: 1.5 }, { sku: 'unknown' }]) {
    assert.throws(() => s.addMedication({ ...input, prescriptionId: 'rx-invalid', ...patch }))
  }
  assert.throws(() => s.setLimit(NaN))
  assert.throws(() => s.setLimit('2000'))
  assert.throws(() => s.setLimit(-1))
})
test('persisted state can resume an approved order without creating another refill', () => {
  const { service: s, refill: r, approval } = quoted()
  s.approve(r.id, approval)
  const restored = new RefillService(JSON.parse(JSON.stringify(s.data)), () => {}, () => new Date('2026-10-17T17:00:00Z'))
  restored.check(); restored.place(r.id)
  assert.equal(restored.data.refills.length, 1)
  assert.equal(restored.get(r.id).status, 'ordered')
})
