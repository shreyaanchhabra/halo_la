import type { Medication, Refill, RefillData } from '../shared/refills.ts'
import { TEST_CATALOG } from '../shared/refills.ts'

export class RefillError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}

export const emptyRefills = (): RefillData => ({ settings: { spendingLimitCents: 2000 }, medications: [], refills: [], doses: [], activity: [] })

function integer(value: unknown, name: string, min = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > 1_000_000) throw new RefillError(`${name} must be an integer from ${min} to 1000000`)
  return Number(value)
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new RefillError(`${name} is required (maximum 200 characters)`)
  return value.trim()
}

// Single-process demo service. All state transitions are synchronous and persisted before returning.
export class RefillService {
  data: RefillData
  persist: () => void
  clock: () => Date
  constructor(data: RefillData, persist = () => {}, clock = () => new Date()) {
    this.data = data; this.persist = persist; this.clock = clock
  }
  private log(message: string, refillId?: string) {
    this.data.activity.push({ at: this.clock().toISOString(), refillId, text: message })
  }
  get(id: string): Refill {
    const r = this.data.refills.find(r => r.id === id)
    if (!r) throw new RefillError('Refill not found', 404)
    return r
  }
  medication(id: string): Medication {
    const m = this.data.medications.find(m => m.id === id)
    if (!m) throw new RefillError('Medication not found', 404)
    return m
  }
  setLimit(value: unknown) {
    this.data.settings.spendingLimitCents = integer(value, 'spendingLimitCents')
    this.log(`Family set the per-order spending limit to ${value} cents USD`)
    this.persist()
  }
  addMedication(input: Record<string, unknown>) {
    if (input.doctorConfirmed !== true) throw new RefillError('A doctor-confirmed prescription is required')
    const prescriptionId = text(input.prescriptionId, 'prescriptionId')
    if (this.data.medications.some(m => m.prescriptionId === prescriptionId)) throw new RefillError('This prescription is already tracked', 409)
    const item = TEST_CATALOG.find(p => p.sku === input.sku)
    if (!item) throw new RefillError('Choose a medication from the test pharmacy catalog')
    const m: Medication = {
      id: crypto.randomUUID(), name: item.name, sku: item.sku,
      prescriptionId, doctor: text(input.doctor, 'doctor'),
      tabletsPerDay: integer(input.tabletsPerDay, 'tabletsPerDay', 1),
      tabletsRemaining: integer(input.tabletsRemaining, 'tabletsRemaining'),
      refillQuantity: item.quantity, confirmedAt: this.clock().toISOString(),
    }
    this.data.medications.push(m)
    this.log(`Added ${m.name} from confirmed prescription ${m.prescriptionId}`)
    this.check()
    return m
  }
  // Part D calls this after a confirmed dose. A stable dose event ID prevents double decrement.
  dose(id: string, input: Record<string, unknown>) {
    const eventId = text(input.eventId, 'eventId')
    const tablets = integer(input.tablets, 'tablets', 1)
    const previous = this.data.doses.find(d => d.eventId === eventId)
    if (previous) {
      if (previous.medicationId !== id || previous.tablets !== tablets) throw new RefillError('Dose event ID already used with different details', 409)
      return this.medication(id)
    }
    const m = this.medication(id)
    if (tablets > m.tabletsRemaining) throw new RefillError('Dose exceeds recorded stock; correct the stock count first', 409)
    m.tabletsRemaining -= tablets
    this.data.doses.push({ eventId, medicationId: id, tablets, at: this.clock().toISOString() })
    this.log(`Confirmed ${tablets} tablet(s) of ${m.name}; ${m.tabletsRemaining} remaining`)
    this.check()
    return m
  }
  check() {
    for (const m of this.data.medications) {
      if (m.tabletsRemaining / m.tabletsPerDay > 7) continue
      // Rejection deliberately suppresses automatic reordering until the family explicitly retries.
      if (this.data.refills.some(r => r.medicationId === m.id && r.status !== 'received')) continue
      const r: Refill = { id: crypto.randomUUID(), medicationId: m.id, medicationName: m.name, quantity: m.refillQuantity, status: 'preparing', createdAt: this.clock().toISOString() }
      this.data.refills.push(r)
      this.log(`${m.name} has at most 7 days left; preparing a test pharmacy refill`, r.id)
    }
    this.persist()
  }
  prepare(id: string) {
    const r = this.get(id)
    if (r.status === 'awaiting_approval') return r
    if (r.status !== 'preparing') throw new RefillError('Refill cannot be prepared in its current state', 409)
    const m = this.medication(r.medicationId)
    const item = TEST_CATALOG.find(p => p.sku === m.sku)!
    r.totalCents = item.totalCents
    r.quoteExpiresAt = new Date(this.clock().getTime() + 30 * 60_000).toISOString()
    r.status = 'awaiting_approval'
    this.log(`Test pharmacy quote: ${r.quantity} tablets, ${r.totalCents} cents USD. Waiting for family approval`, id)
    this.persist()
    return r
  }
  approve(id: string, input: Record<string, unknown>) {
    const r = this.get(id)
    if (r.status !== 'awaiting_approval') throw new RefillError('Refill is not waiting for approval', 409)
    if (r.totalCents !== input.expectedTotalCents) throw new RefillError('The price changed. Review the current quote', 409)
    this.validateQuote(r)
    r.approvedBy = text(input.approvedBy, 'approvedBy')
    r.approvedAt = this.clock().toISOString()
    r.status = 'ordering'
    this.log(`Family approval by ${r.approvedBy} for ${r.totalCents} cents USD`, id)
    this.persist()
    return r
  }
  private validateQuote(r: Refill) {
    if (!r.quoteExpiresAt || Date.parse(r.quoteExpiresAt) <= this.clock().getTime()) throw new RefillError('Quote expired. Request a fresh quote', 409)
    if (r.totalCents === undefined || r.totalCents > this.data.settings.spendingLimitCents) throw new RefillError('Refill exceeds the family spending limit', 409)
  }
  // Test pharmacy checkout itself enforces approval, amount, expiry and idempotency.
  place(id: string) {
    const r = this.get(id)
    if (r.orderId) return r
    if (r.status !== 'ordering' || !r.approvedBy) throw new RefillError('Family approval is required before checkout', 409)
    this.validateQuote(r)
    r.orderId = `TEST-${r.id}`
    r.pickupAt = new Date(this.clock().getTime() + 24 * 60 * 60_000).toISOString()
    r.status = 'ordered'
    this.log(`Test pharmacy order ${r.orderId} confirmed. No real payment or medicine order was made`, id)
    this.persist()
    return r
  }
  reject(id: string) {
    const r = this.get(id)
    if (!['preparing', 'awaiting_approval'].includes(r.status)) throw new RefillError('This refill cannot be rejected', 409)
    r.status = 'rejected'
    this.log('Family rejected refill; automatic retry paused', id)
    this.persist()
    return r
  }
  retry(id: string) {
    const r = this.get(id)
    if (!['rejected', 'awaiting_approval'].includes(r.status)) throw new RefillError('An uncertain checkout must be reviewed; do not automatically retry', 409)
    r.status = 'preparing'
    delete r.totalCents; delete r.quoteExpiresAt; delete r.approvedAt; delete r.approvedBy
    this.log('Family requested a fresh quote', id)
    this.persist()
    return r
  }
  fail(id: string, message: string) {
    const r = this.get(id)
    if (r.orderId || r.status === 'received') return
    r.status = 'needs_review'; r.error = message
    this.log(`Automation needs review: ${message}`, id)
    this.persist()
  }
  receive(id: string) {
    const r = this.get(id)
    if (r.status === 'received') return r
    if (r.status !== 'ordered') throw new RefillError('Only confirmed orders can be marked received', 409)
    this.medication(r.medicationId).tabletsRemaining += r.quantity
    r.status = 'received'
    this.log(`Family confirmed receipt of ${r.quantity} tablets`, id)
    this.persist()
    return r
  }
}
