import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createRefills, RefillError } from './refills.ts'
import { createPharmacy } from './pharmacy.ts'
import { localDriver, type PharmacyDriver } from './errands.ts'
import { medKey } from '../src/schedule.ts'
import type { DoseLog, HaloData } from '../src/types'

const KEY = medKey('rx1', 0)
const T0 = new Date('2026-10-17T10:00:00')

function world(o: { count?: number; driver?: (p: ReturnType<typeof createPharmacy>) => PharmacyDriver; dataDir?: string; limit?: number; medicine?: Record<string, unknown> } = {}) {
  let t = T0.getTime()
  const now = () => new Date(t)
  const care: HaloData = {
    patient: { name: 'Joe Martinez' }, people: [],
    prescriptions: [{
      id: 'rx1', file: 'f', originalName: 'rx.pdf', doctor: 'Dr. Patel', date: '2026-10-01', notes: '', uploadedAt: '2026-10-01T00:00:00Z',
      reading: { medicines: [{ name: 'Donepezil', strength: '5 mg', form: 'tablet', instructions: '', times: ['21:00'], quantity: 30, refills: 2, ...o.medicine }], appointments: [], notes: [], readAt: '2026-10-01T00:00:00Z' },
    }],
    stock: { [KEY]: { count: o.count ?? 8, at: '2026-10-17T00:00:00Z' } },
  }
  const doses: DoseLog[] = []
  const events: { id: string; activity: string; start: string }[] = []
  const pharmacy = createPharmacy({ dataDir: ':memory:', now })
  const driver = o.driver ? o.driver(pharmacy) : localDriver(pharmacy)
  const refills = createRefills({
    dataDir: o.dataDir ?? ':memory:', driver, pharmacy, now, defaultLimitCents: o.limit ?? 2500,
    readData: () => care, readDoses: () => doses,
    setStock: (k, count, at) => { care.stock = { ...care.stock, [k]: { count, at } } },
    addToCalendar: e => { const ev = { id: `ev${events.length + 1}`, ...e }; events.push(ev); return ev },
  })
  return { care, doses, events, pharmacy, refills, advance: (ms: number) => { t += ms }, now }
}
const dose = (w: ReturnType<typeof world>, slot: string) => w.doses.push({ medKey: KEY, slot, at: '2026-10-17T09:00:00Z' })
const first = (w: ReturnType<typeof world>) => w.refills.state().refills[0]
// 8 pills at 1 a day, then one dose: exactly 7 days left
async function due(w = world()) { dose(w, '2026-10-17 21:00'); w.refills.check(); await w.refills.idle(); return w }
const rejects = (fn: () => unknown, status: number, re?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof RefillError && e.status === status && (!re || re.test(e.message)))

describe('1. the pill count reaches 7 days', () => {
  test('8 days left: nothing yet', () => {
    const w = world(); w.refills.check()
    assert.equal(w.refills.state().refills.length, 0)
  })

  test('7 days left: a refill starts', async () => {
    const w = await due()
    assert.equal(w.refills.state().refills.length, 1)
    assert.equal(first(w).medicine, 'Donepezil 5 mg')
  })

  test('the count comes from the family count minus doses taken since', async () => {
    const w = world({ count: 9 })
    dose(w, '2026-10-17 21:00'); w.refills.check(); await w.refills.idle()
    assert.equal(w.refills.state().refills.length, 0, '8 left is still 8 days')
    dose(w, '2026-10-18 21:00'); w.refills.check(); await w.refills.idle()
    assert.equal(w.refills.state().refills.length, 1, '7 left')
  })

  test('twice a day halves the days left', async () => {
    const w = world({ count: 14, medicine: { times: ['08:00', '20:00'] } })
    w.refills.check(); await w.refills.idle()
    assert.equal(w.refills.state().refills.length, 1, '14 pills at 2 a day is 7 days')
  })

  test('checking again and again still makes one refill per medicine', async () => {
    const w = await due()
    w.refills.check(); w.refills.check(); await w.refills.idle()
    assert.equal(w.refills.state().refills.length, 1)
  })

  test('a medicine whose pill count is unknown is left alone', () => {
    const w = world({ medicine: { quantity: null } }); delete w.care.stock
    w.refills.check()
    assert.equal(w.refills.state().refills.length, 0)
  })
})

describe('2. the errands agent stops before paying', () => {
  test('a quote is ready and nothing is ordered', async () => {
    const w = await due()
    const r = first(w)
    assert.equal(r.status, 'awaiting_approval')
    assert.equal(r.quote?.priceCents, 1240)
    assert.equal(r.quote?.quantity, 30)
    assert.equal(w.pharmacy.get(r.quote!.cartId)?.status, 'review')
    assert.equal(w.pharmacy.get(r.quote!.cartId)?.order, undefined)
    assert.equal(w.events.length, 0)
  })

  test('the pharmacy will not place an order that was not approved', async () => {
    const w = await due()
    assert.throws(() => w.pharmacy.placeOrder(first(w).quote!.cartId), /not been approved/)
  })

  test('the pharmacy will not place an order approved at a different price', async () => {
    const w = await due()
    const id = first(w).quote!.cartId
    assert.throws(() => w.pharmacy.approve(id, 'Maya', 999), /price/)
    assert.throws(() => w.pharmacy.placeOrder(id), /not been approved/)
  })

  test('other medicines have prices too', () => {
    const p = createPharmacy({ dataDir: ':memory:' })
    assert.equal(p.addToCart('Memantine 5 mg', 60).priceCents, 2860)
    assert.equal(p.addToCart('Aspirin 81 mg', 100).priceCents, 4500)
  })

  test('a pharmacy that cannot be reached needs a person, and a fresh price recovers', async () => {
    let up = false
    const w = world({ driver: p => ({ ...localDriver(p), prepare: async e => { if (!up) throw new Error('site is down'); return localDriver(p).prepare(e) } }) })
    await due(w)
    assert.equal(first(w).status, 'needs_review')
    assert.match(first(w).error!, /site is down/)
    up = true
    w.refills.requote(first(w).id); await w.refills.idle()
    assert.equal(first(w).status, 'awaiting_approval')
  })
})

describe('3 and 4. approval, the order and the calendar', () => {
  const approve = (w: ReturnType<typeof world>, extra = {}) => w.refills.approve(first(w).id, { approvedBy: 'Maya', expectedPriceCents: 1240, ...extra })

  test('approving within the limit places the order and puts the pickup on the calendar', async () => {
    const w = await due()
    approve(w); await w.refills.idle()
    const r = first(w)
    assert.equal(r.status, 'ordered')
    assert.equal(r.approvedBy, 'Maya')
    assert.match(r.order!.id, /^TEST-/)
    assert.equal(r.order!.method, 'pickup')
    assert.equal(new Date(r.order!.readyAt).getHours(), 10)
    assert.equal(w.events.length, 1)
    assert.equal(w.events[0].activity, 'Pick up Donepezil 5 mg')
    assert.equal(w.events[0].start, r.order!.readyAt)
    assert.equal(r.calendarPlanId, w.events[0].id)
    assert.equal(w.pharmacy.get(r.quote!.cartId)?.status, 'ordered')
  })

  test('the price must be the one that was shown', async () => {
    const w = await due()
    rejects(() => approve(w, { expectedPriceCents: 1000 }), 409, /price changed/)
    assert.equal(first(w).status, 'awaiting_approval')
  })

  test('a name is required', async () => {
    const w = await due()
    rejects(() => approve(w, { approvedBy: '  ' }), 400, /name/)
  })

  test('over the family limit: blocked, nothing ordered, nothing on the calendar', async () => {
    const w = await due(world({ limit: 1000 }))
    rejects(() => approve(w), 409, /over the family limit of \$10\.00/)
    await w.refills.idle()
    assert.equal(first(w).status, 'awaiting_approval')
    assert.equal(w.events.length, 0)
  })

  test('raising the limit lets the same refill go ahead', async () => {
    const w = await due(world({ limit: 1000 }))
    rejects(() => approve(w), 409)
    w.refills.setLimit(2000)
    approve(w); await w.refills.idle()
    assert.equal(first(w).status, 'ordered')
  })

  test('a limit exactly equal to the price is allowed', async () => {
    const w = await due(world({ limit: 1240 }))
    approve(w); await w.refills.idle()
    assert.equal(first(w).status, 'ordered')
  })

  test('an expired price needs a fresh price first', async () => {
    const w = await due()
    w.advance(31 * 60_000)
    rejects(() => approve(w), 409, /expired/)
    w.refills.requote(first(w).id); await w.refills.idle()
    approve(w); await w.refills.idle()
    assert.equal(first(w).status, 'ordered')
  })

  test('approving twice never orders twice', async () => {
    const w = await due()
    approve(w); await w.refills.idle()
    rejects(() => approve(w), 409, /not waiting/)
    assert.equal(w.pharmacy.carts().filter(c => c.order).length, 1)
    assert.equal(w.events.length, 1)
  })

  test('a delivery goes on the calendar as a delivery', async () => {
    const w = world({ driver: p => ({ ...localDriver(p), place: async id => ({ ...(await localDriver(p).place(id)), method: 'delivery' as const }) }) })
    await due(w); approve(w); await w.refills.idle()
    assert.equal(w.events[0].activity, 'Delivery of Donepezil 5 mg')
  })

  test('if the order fails and the pharmacy has no order, a person checks and nothing is reordered', async () => {
    const w = world({ driver: p => ({ ...localDriver(p), place: async () => { throw new Error('checkout timed out') } }) })
    await due(w); approve(w); await w.refills.idle()
    assert.equal(first(w).status, 'needs_review')
    assert.match(first(w).error!, /Check the pharmacy/)
    assert.equal(w.events.length, 0)
    w.refills.check(); await w.refills.idle()
    assert.equal(w.refills.state().refills.length, 1, 'no second refill started')
  })

  test('if the driver errors after the pharmacy confirmed the order, the confirmed order wins', async () => {
    const w = world({ driver: p => ({ ...localDriver(p), place: async id => { p.placeOrder(id); throw new Error('lost connection') } }) })
    await due(w); approve(w); await w.refills.idle()
    assert.equal(first(w).status, 'ordered')
    assert.equal(w.events.length, 1)
  })
})

describe('saying no, and changing the pill count', () => {
  test('not now: nothing is ordered and HALO does not ask again by itself', async () => {
    const w = await due()
    w.refills.reject(first(w).id)
    w.refills.check(); await w.refills.idle()
    assert.equal(first(w).status, 'rejected')
    assert.equal(w.refills.state().refills.length, 1)
    assert.equal(w.pharmacy.carts().filter(c => c.order).length, 0)
  })

  test('after a no, a fresh price can be asked for', async () => {
    const w = await due()
    w.refills.reject(first(w).id)
    w.refills.requote(first(w).id); await w.refills.idle()
    assert.equal(first(w).status, 'awaiting_approval')
  })

  test('typing in a new pill count cancels a refill that is no longer due', async () => {
    const w = await due()
    w.care.stock![KEY] = { count: 30, at: '2026-10-17T12:00:00Z' }
    w.refills.check(); await w.refills.idle()
    assert.equal(first(w).status, 'cancelled')
    w.refills.check()
    assert.equal(w.refills.state().refills.length, 1)
  })

  test('an order already placed is not cancelled by a count change', async () => {
    const w = await due()
    w.refills.approve(first(w).id, { approvedBy: 'Maya', expectedPriceCents: 1240 }); await w.refills.idle()
    w.care.stock![KEY] = { count: 30, at: '2026-10-17T12:00:00Z' }
    w.refills.check()
    assert.equal(first(w).status, 'ordered')
  })

  test('a medicine taken off the prescription cancels its pending refill', async () => {
    const w = await due()
    w.care.prescriptions = []
    w.refills.check()
    assert.equal(first(w).status, 'cancelled')
  })
})

describe('the medicine arrives', () => {
  async function ordered() {
    const w = await due()
    w.refills.approve(first(w).id, { approvedBy: 'Maya', expectedPriceCents: 1240 }); await w.refills.idle()
    return w
  }

  test('marking it received adds the tablets to the pill count', async () => {
    const w = await ordered()
    w.refills.received(first(w).id)
    assert.equal(first(w).status, 'received')
    assert.equal(w.care.stock![KEY].count, 7 + 30)
  })

  test('marking it received twice adds them once', async () => {
    const w = await ordered()
    w.refills.received(first(w).id); w.refills.received(first(w).id)
    assert.equal(w.care.stock![KEY].count, 37)
  })

  test('only a confirmed order can be received', async () => {
    const w = await due()
    rejects(() => w.refills.received(first(w).id), 409)
    assert.equal(w.care.stock![KEY].count, 8)
  })

  test('after receiving, the refill cycle is over and nothing new starts', async () => {
    const w = await ordered()
    w.refills.received(first(w).id)
    w.refills.check(); await w.refills.idle()
    assert.equal(w.refills.state().refills.length, 1)
  })
})

describe('restarts and the log', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'halo-refills-'))

  test('state survives a restart', async () => {
    const d = dir()
    const w = await due(world({ dataDir: d }))
    const again = createRefills({ ...{ dataDir: d, driver: localDriver(w.pharmacy), pharmacy: w.pharmacy, readData: () => w.care, readDoses: () => w.doses, setStock: () => {}, addToCalendar: () => ({ id: 'x' }) } })
    assert.equal(again.state().refills[0].status, 'awaiting_approval')
    assert.equal(again.state().refills[0].quote?.priceCents, 1240)
  })

  test('a restart in the middle of checkout needs a person; it never orders on its own', async () => {
    const d = dir()
    const w = world({ dataDir: d })
    await due(w)
    w.refills.state()
    const saved = JSON.parse(fs.readFileSync(path.join(d, 'refills.json'), 'utf8'))
    saved.refills[0].status = 'ordering'; saved.refills[0].approvedBy = 'Maya'
    fs.writeFileSync(path.join(d, 'refills.json'), JSON.stringify(saved))
    const again = createRefills({ dataDir: d, driver: localDriver(w.pharmacy), pharmacy: w.pharmacy, readData: () => w.care, readDoses: () => w.doses, setStock: () => {}, addToCalendar: () => ({ id: 'x' }) })
    assert.equal(again.state().refills[0].status, 'needs_review')
    assert.match(again.state().refills[0].error!, /restarted/)
    again.check(); await again.idle()
    assert.equal(again.state().refills.length, 1)
    assert.equal(w.pharmacy.carts().filter(c => c.order).length, 0)
  })

  test('the activity log tells the story in order, newest first', async () => {
    const w = await due()
    w.refills.approve(first(w).id, { approvedBy: 'Maya', expectedPriceCents: 1240 }); await w.refills.idle()
    const log = w.refills.state().activity.map(a => a.text)
    assert.match(log[0], /Order TEST-.* placed for \$12\.40/)
    assert.match(log[1], /Maya approved \$12\.40/)
    assert.match(log[2], /Nothing has been paid/)
    assert.match(log[3], /down to 7 days/)
  })

  test('the limit must be a sensible whole number of cents', () => {
    const w = world()
    rejects(() => w.refills.setLimit(-1), 400)
    rejects(() => w.refills.setLimit(12.5), 400)
    rejects(() => w.refills.setLimit('2000'), 400)
    assert.equal(w.refills.setLimit(5000).spendingLimitCents, 5000)
  })
})
