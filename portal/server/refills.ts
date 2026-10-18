import fs from 'node:fs'
import path from 'node:path'
import { allMedicines, pillsLeft, refillDue } from '../src/meds.ts'
import type { DoseLog, HaloData } from '../src/types'
import { formatCents, type ActivityEntry, type Refill, type RefillState, type RefillStatus } from '../../shared/refill-types.ts'
import type { PriceFinder } from './errands.ts'

// Refill before it runs out (Flow E).
//
//   1. The pill count drops to 7 days left.
//   2. The errands agent looks up GoodRx prices near the patient (Browser Use) and STOPS. Nothing is bought.
//   3. The family sees "Refill Donepezil 5 mg: $12.40 at CVS (GoodRx), approve?" in the care portal.
//   4. Approving, within the family's spending limit, puts a pickup reminder on the calendar.
//
// HALO never places an order. GoodRx is a price and coupon site, so the family picks the medicine up.
// Pill counts come from the care portal's own data (stock, doses, prescriptions), so there is one count.
// Every change is saved before it returns.

export class RefillError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}

export type RefillOptions = {
  dataDir: string // ':memory:' keeps everything in memory (tests)
  finder: PriceFinder
  readData: () => HaloData
  readDoses: () => DoseLog[]
  setStock: (medKey: string, count: number, at: string) => void // the family's new pill count
  addToCalendar: (event: { activity: string; start: string }) => { id: string }
  notify?: () => void
  now?: () => Date
  defaultLimitCents?: number
}

const OPEN: RefillStatus[] = ['preparing', 'awaiting_approval', 'approved', 'rejected', 'needs_review']
const STALE_WHEN_COUNT_UPDATED: RefillStatus[] = ['preparing', 'awaiting_approval', 'approved', 'rejected']
const MAX_ACTIVITY = 200

const text = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !v.trim() || v.length > 100) throw new RefillError(`${name} is required (up to 100 characters)`)
  return v.trim()
}

export function createRefills(o: RefillOptions) {
  const memory = o.dataDir === ':memory:'
  const file = path.join(o.dataDir, 'refills.json')
  const now = o.now ?? (() => new Date())
  const notify = o.notify ?? (() => {})

  let data: Pick<RefillState, 'settings' | 'refills' | 'activity'> = { settings: { spendingLimitCents: o.defaultLimitCents ?? 2500 }, refills: [], activity: [] }
  try { if (!memory) data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { /* first run */ }

  const inflight = new Map<string, Promise<void>>()

  function persist() {
    if (!memory) {
      fs.mkdirSync(o.dataDir, { recursive: true })
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2))
      fs.renameSync(`${file}.tmp`, file)
    }
    notify()
  }
  function log(message: string, refillId?: string) {
    data.activity.push({ at: now().toISOString(), refillId, text: message })
    if (data.activity.length > MAX_ACTIVITY) data.activity.splice(0, data.activity.length - MAX_ACTIVITY)
  }
  const get = (id: string): Refill => {
    const r = data.refills.find(x => x.id === id)
    if (!r) throw new RefillError('Refill not found', 404)
    return r
  }

  // ---- 1. the pill count ---------------------------------------------------------------------------------

  // Look at every medicine: start a refill when 7 days are left, drop one that is no longer needed
  function check() {
    const care = o.readData()
    const doses = o.readDoses()
    const meds = allMedicines(care)
    let changed = false
    for (const e of meds) {
      const due = refillDue(e, care, doses)
      const open = data.refills.find(r => r.medKey === e.key && OPEN.includes(r.status))
      if (due && !open) {
        const r: Refill = {
          id: crypto.randomUUID(), medKey: e.key, medicine: `${e.med.name} ${e.med.strength}`.trim(),
          quantity: e.med.quantity ?? 30, status: 'preparing', createdAt: now().toISOString(),
        }
        data.refills.push(r)
        log(`${r.medicine} is down to 7 days or less. Looking up GoodRx prices.`, r.id)
        changed = true
      } else if (!due && open && STALE_WHEN_COUNT_UPDATED.includes(open.status)) {
        open.status = 'cancelled'
        log('The pill count was updated, so this refill is not needed yet.', open.id)
        changed = true
      }
    }
    for (const r of data.refills) {
      if (STALE_WHEN_COUNT_UPDATED.includes(r.status) && !meds.some(e => e.key === r.medKey)) {
        r.status = 'cancelled'; log('This medicine is no longer on a prescription.', r.id); changed = true
      }
    }
    if (changed) persist()
    for (const r of data.refills) if (r.status === 'preparing') startPreparing(r)
  }

  // ---- 2. the errands agent looks up prices, and stops ------------------------------------------------------

  function startPreparing(r: Refill) {
    if (inflight.has(r.id)) return
    const job = (async () => {
      try {
        const care = o.readData()
        const entry = allMedicines(care).find(e => e.key === r.medKey)
        const q = await o.finder.prepare({
          medicine: r.medicine, quantity: r.quantity, zip: care.patient.zip,
          med: entry && { name: entry.med.name, strength: entry.med.strength, form: entry.med.form },
        })
        if (r.status !== 'preparing') return // cancelled or turned down while the lookup ran: drop the answer
        r.quantity = q.quantity // the price is for this many tablets
        r.quote = { ...q, expiresAt: new Date(now().getTime() + o.finder.quoteTtlMs).toISOString() }
        r.status = 'awaiting_approval'
        log(`GoodRx: ${formatCents(q.priceCents)} for ${q.quantity} tablets at ${q.pharmacy}${q.priceType ? ` (${q.priceType})` : ''}. Nothing has been bought. Waiting for the family to approve.`, r.id)
      } catch (err) {
        if (r.status !== 'preparing') return
        r.status = 'needs_review'
        r.error = `The price lookup did not finish: ${err instanceof Error ? err.message : String(err)}`
        log(r.error, r.id)
      }
      persist()
    })().finally(() => inflight.delete(r.id))
    inflight.set(r.id, job)
  }

  // ---- 3 and 4. approval and the pickup reminder -------------------------------------------------------------

  const limit = () => data.settings.spendingLimitCents

  function approve(id: string, input: { approvedBy?: unknown; expectedPriceCents?: unknown }): Refill {
    const r = get(id)
    const by = text(input.approvedBy, 'Your name')
    if (r.status !== 'awaiting_approval' || !r.quote) throw new RefillError('This refill is not waiting for approval', 409)
    if (r.quote.priceCents !== input.expectedPriceCents) throw new RefillError('The price changed. Look at the current price before approving.', 409)
    if (Date.parse(r.quote.expiresAt) <= now().getTime()) throw new RefillError('This price is out of date. Get fresh prices first.', 409)
    if (r.quote.priceCents > limit()) throw new RefillError(`This refill costs ${formatCents(r.quote.priceCents)}, which is over the family limit of ${formatCents(limit())}.`, 409)
    r.approvedBy = by
    r.approvedAt = now().toISOString()
    const pickup = new Date(now()); pickup.setDate(pickup.getDate() + 1); pickup.setHours(10, 0, 0, 0) // tomorrow at 10; the family can move it on the calendar
    r.pickupAt = pickup.toISOString()
    r.status = 'approved'
    r.calendarPlanId = o.addToCalendar({ activity: `Pick up ${r.medicine} at ${r.quote.pharmacy}`, start: r.pickupAt }).id
    log(`${by} approved ${formatCents(r.quote.priceCents)} at ${r.quote.pharmacy}. A pickup reminder is on the calendar for ${pickup.toLocaleString()}.`, id)
    persist()
    return r
  }

  function reject(id: string): Refill {
    const r = get(id)
    if (r.status !== 'preparing' && r.status !== 'awaiting_approval') throw new RefillError('This refill can no longer be turned down', 409)
    r.status = 'rejected'
    log('The family said not now. HALO will not look again until asked.', id)
    persist()
    return r
  }

  // Fresh prices, and another approval, after a no, an out-of-date price or a failed lookup
  function requote(id: string): Refill {
    const r = get(id)
    if (!['rejected', 'awaiting_approval', 'needs_review'].includes(r.status)) throw new RefillError('This refill cannot get new prices right now', 409)
    delete r.quote; delete r.approvedBy; delete r.approvedAt; delete r.error
    r.status = 'preparing'
    log('The family asked for fresh prices.', id)
    persist()
    startPreparing(r)
    return r
  }

  // The medicine is in hand: the pill count goes up once, and the refill is finished
  function received(id: string): Refill {
    const r = get(id)
    if (r.status === 'received') return r
    if (r.status !== 'approved') throw new RefillError('Only an approved refill can be marked as received', 409)
    const care = o.readData()
    const entry = allMedicines(care).find(e => e.key === r.medKey)
    if (entry) o.setStock(r.medKey, (pillsLeft(entry, care, o.readDoses()) ?? 0) + r.quantity, now().toISOString())
    r.status = 'received'
    log(`The family has the ${r.quantity} tablets of ${r.medicine}. The pill count was updated.`, id)
    persist()
    return r
  }

  function setLimit(cents: unknown) {
    if (!Number.isSafeInteger(cents) || (cents as number) < 0 || (cents as number) > 1_000_000) throw new RefillError('The limit must be a whole number of cents from 0 to 1,000,000')
    data.settings.spendingLimitCents = cents as number
    log(`The family set the limit per refill to ${formatCents(cents as number)}.`)
    persist()
    return data.settings
  }

  const state = (): RefillState => ({ ...data, refills: [...data.refills].reverse(), activity: [...data.activity].reverse().slice(0, 50), driver: o.finder.name })

  // Resume any lookup that was mid-air when HALO last stopped
  for (const r of data.refills) if (r.status === 'preparing') queueMicrotask(() => startPreparing(r))

  return {
    check, approve, reject, requote, received, setLimit, state, get,
    idle: async () => { while (inflight.size) await Promise.all([...inflight.values()]) }, // tests wait for the errands agent
  }
}

export type Refills = ReturnType<typeof createRefills>
export type { ActivityEntry }
