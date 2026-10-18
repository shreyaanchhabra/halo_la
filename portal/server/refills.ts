import fs from 'node:fs'
import path from 'node:path'
import { allMedicines, pillsLeft, refillDue } from '../src/meds.ts'
import type { DoseLog, HaloData } from '../src/types'
import { formatCents, type ActivityEntry, type Refill, type RefillState, type RefillStatus } from '../../shared/refill-types.ts'
import type { PharmacyDriver } from './errands.ts'
import type { Pharmacy } from './pharmacy.ts'

// Refill before it runs out (Flow E).
//
//   1. The pill count drops to 7 days left.
//   2. The errands agent shops on the pharmacy website and STOPS before paying.
//   3. The family gets "Refill Donepezil 5 mg, $12.40, approve?" in the care portal.
//   4. Approval, within the family's spending limit, places the order, and the pickup goes on the calendar.
//
// Pill counts come from the care portal's own data (stock, doses, prescriptions), so there is one count.
// Every transition is persisted before it returns, and nothing is ever ordered twice.

export class RefillError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}

export type RefillOptions = {
  dataDir: string // ':memory:' keeps everything in memory (tests)
  driver: PharmacyDriver
  pharmacy: Pharmacy
  readData: () => HaloData
  readDoses: () => DoseLog[]
  setStock: (medKey: string, count: number, at: string) => void // the family's new pill count
  addToCalendar: (event: { activity: string; start: string }) => { id: string }
  notify?: () => void
  now?: () => Date
  quoteTtlMs?: number
  defaultLimitCents?: number
}

const OPEN: RefillStatus[] = ['preparing', 'awaiting_approval', 'ordering', 'ordered', 'rejected', 'needs_review']
const STALE_WHEN_COUNT_UPDATED: RefillStatus[] = ['preparing', 'awaiting_approval', 'rejected']
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
  const ttl = o.quoteTtlMs ?? 30 * 60_000

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

  // A restart during checkout is ambiguous. A person looks; nothing is ordered again on its own.
  for (const r of data.refills) {
    if (r.status === 'ordering' && !r.order) {
      r.status = 'needs_review'
      r.error = 'HALO restarted while the order was being placed. Check the pharmacy before ordering again.'
      log(r.error, r.id)
    }
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
        log(`${r.medicine} is down to 7 days or less. Looking for a refill.`, r.id)
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

  // ---- 2. the errands agent shops, and stops before paying -------------------------------------------------

  function startPreparing(r: Refill) {
    if (inflight.has(r.id)) return
    const job = (async () => {
      try {
        const q = await o.driver.prepare({ medicine: r.medicine, quantity: r.quantity })
        r.quote = { ...q, expiresAt: new Date(now().getTime() + ttl).toISOString() }
        r.status = 'awaiting_approval'
        log(`${q.pharmacy} quote: ${r.quantity} tablets for ${formatCents(q.priceCents)}. Nothing has been paid. Waiting for the family to approve.`, r.id)
      } catch (err) {
        r.status = 'needs_review'
        r.error = `The pharmacy check did not finish: ${err instanceof Error ? err.message : String(err)}`
        log(r.error, r.id)
      }
      persist()
    })().finally(() => inflight.delete(r.id))
    inflight.set(r.id, job)
  }

  // ---- 3 and 4. approval, the order, and the calendar --------------------------------------------------------

  const limit = () => data.settings.spendingLimitCents

  function approve(id: string, input: { approvedBy?: unknown; expectedPriceCents?: unknown }): Refill {
    const r = get(id)
    const by = text(input.approvedBy, 'Your name')
    if (r.status !== 'awaiting_approval' || !r.quote) throw new RefillError('This refill is not waiting for approval', 409)
    if (r.quote.priceCents !== input.expectedPriceCents) throw new RefillError('The price changed. Look at the current price before approving.', 409)
    if (Date.parse(r.quote.expiresAt) <= now().getTime()) throw new RefillError('This price has expired. Get a fresh price first.', 409)
    if (r.quote.priceCents > limit()) throw new RefillError(`This refill costs ${formatCents(r.quote.priceCents)}, which is over the family limit of ${formatCents(limit())}.`, 409)
    try { o.pharmacy.approve(r.quote.cartId, by, r.quote.priceCents) } catch (e) { throw new RefillError((e as Error).message, 409) }
    r.approvedBy = by
    r.approvedAt = now().toISOString()
    r.status = 'ordering'
    log(`${by} approved ${formatCents(r.quote.priceCents)} for ${r.medicine}.`, id)
    persist()
    startOrdering(r)
    return r
  }

  function startOrdering(r: Refill) {
    if (inflight.has(r.id)) return
    const job = (async () => {
      try {
        const placed = await o.driver.place(r.quote!.cartId)
        complete(r, placed)
      } catch (err) {
        // The pharmacy's own record wins over an ambiguous failure
        const placed = o.pharmacy.get(r.quote!.cartId)?.order
        if (placed) { complete(r, { orderId: placed.id, readyAt: placed.readyAt, method: placed.method, priceCents: placed.priceCents }); return }
        r.status = 'needs_review'
        r.error = `The order did not complete: ${err instanceof Error ? err.message : String(err)}. Check the pharmacy before ordering again.`
        log(r.error, r.id)
        persist()
      }
    })().finally(() => inflight.delete(r.id))
    inflight.set(r.id, job)
  }

  function complete(r: Refill, placed: { orderId: string; readyAt: string; method: 'pickup' | 'delivery'; priceCents: number }) {
    r.order = { id: placed.orderId, placedAt: now().toISOString(), readyAt: placed.readyAt, method: placed.method, priceCents: placed.priceCents }
    r.status = 'ordered'
    delete r.error
    if (!r.calendarPlanId) {
      const verb = placed.method === 'delivery' ? 'Delivery of' : 'Pick up'
      r.calendarPlanId = o.addToCalendar({ activity: `${verb} ${r.medicine}`, start: placed.readyAt }).id
    }
    log(`Order ${placed.orderId} placed for ${formatCents(placed.priceCents)}. ${placed.method === 'delivery' ? 'Delivery' : 'Pickup'}: ${new Date(placed.readyAt).toLocaleString()}. Added to the calendar.`, r.id)
    persist()
  }

  function reject(id: string): Refill {
    const r = get(id)
    if (r.status !== 'preparing' && r.status !== 'awaiting_approval') throw new RefillError('This refill can no longer be turned down', 409)
    r.status = 'rejected'
    log('The family said not now. Nothing was ordered, and HALO will not try again until asked.', id)
    persist()
    return r
  }

  // A fresh price, and another approval, after a no, an expired price or a failed check
  function requote(id: string): Refill {
    const r = get(id)
    if (!['rejected', 'awaiting_approval', 'needs_review'].includes(r.status)) throw new RefillError('This refill cannot get a new price right now', 409)
    if (r.quote && o.pharmacy.get(r.quote.cartId)?.order) throw new RefillError('An order already exists for this refill. Check the pharmacy.', 409)
    delete r.quote; delete r.approvedBy; delete r.approvedAt; delete r.error
    r.status = 'preparing'
    log('The family asked for a fresh price.', id)
    persist()
    startPreparing(r)
    return r
  }

  // The medicine arrived: the pill count goes up once, and the refill is finished
  function received(id: string): Refill {
    const r = get(id)
    if (r.status === 'received') return r
    if (r.status !== 'ordered') throw new RefillError('Only an order the pharmacy confirmed can be marked as received', 409)
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

  const state = (): RefillState => ({ ...data, refills: [...data.refills].reverse(), activity: [...data.activity].reverse().slice(0, 50), driver: o.driver.name })

  // Resume anything that was mid-air when HALO last stopped
  for (const r of data.refills) if (r.status === 'preparing') queueMicrotask(() => startPreparing(r))

  return {
    check, approve, reject, requote, received, setLimit, state, get,
    idle: async () => { while (inflight.size) await Promise.all([...inflight.values()]) }, // tests wait for the errands agent
  }
}

export type Refills = ReturnType<typeof createRefills>
export type { ActivityEntry }
