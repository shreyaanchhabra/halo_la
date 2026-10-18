import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createRefills, RefillError } from './refills.ts'
import { goodrxFinder, noKeyFinder, type GoodRxLookup, type PriceFinder } from './errands.ts'
import { medKey } from '../src/schedule.ts'
import type { DoseLog, HaloData } from '../src/types'

const KEY = medKey('rx1', 0)
const T0 = new Date('2026-10-17T10:00:00')

// What GoodRx would say: cheapest first is not guaranteed, so the finder has to sort
const GOODRX = {
  url: 'https://www.goodrx.com/donepezil', quantity: 30, note: '',
  quotes: [
    { pharmacy: 'Walmart', price: 13.1, priceType: 'GoodRx coupon' },
    { pharmacy: 'CVS Pharmacy', price: 12.4, priceType: 'GoodRx coupon' },
    { pharmacy: 'Costco', price: 14.95, priceType: 'GoodRx coupon' },
  ],
}
const fakeLookup = (result = GOODRX): GoodRxLookup & { calls: unknown[][] } => {
  const f = (async (...args: unknown[]) => { f.calls.push(args); return result }) as GoodRxLookup & { calls: unknown[][] }
  f.calls = []
  return f
}

function world(o: { count?: number; finder?: PriceFinder; dataDir?: string; limit?: number; zip?: string | null; medicine?: Record<string, unknown>; lookup?: ReturnType<typeof fakeLookup> } = {}) {
  let t = T0.getTime()
  const now = () => new Date(t)
  const lookup = o.lookup ?? fakeLookup()
  const care: HaloData = {
    patient: { name: 'Joe Martinez', ...(o.zip === null ? {} : { zip: o.zip ?? '90024' }) }, people: [],
    prescriptions: [{
      id: 'rx1', file: 'f', originalName: 'rx.pdf', doctor: 'Dr. Patel', date: '2026-10-01', notes: '', uploadedAt: '2026-10-01T00:00:00Z',
      reading: { medicines: [{ name: 'Donepezil', strength: '5 mg', form: 'tablet', instructions: '', times: ['21:00'], quantity: 30, refills: 2, ...o.medicine }], appointments: [], notes: [], readAt: '2026-10-01T00:00:00Z' },
    }],
    stock: { [KEY]: { count: o.count ?? 8, at: '2026-10-17T00:00:00Z' } },
  }
  const doses: DoseLog[] = []
  const events: { id: string; activity: string; start: string }[] = []
  const refills = createRefills({
    dataDir: o.dataDir ?? ':memory:', now, defaultLimitCents: o.limit ?? 2500,
    finder: o.finder ?? goodrxFinder({ apiKey: 'test-key', lookup }),
    readData: () => care, readDoses: () => doses,
    setStock: (k, count, at) => { care.stock = { ...care.stock, [k]: { count, at } } },
    addToCalendar: e => { const ev = { id: `ev${events.length + 1}`, ...e }; events.push(ev); return ev },
  })
  return { care, doses, events, refills, lookup, advance: (ms: number) => { t += ms }, now }
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
    assert.equal(w.lookup.calls.length, 0, 'no GoodRx lookup (it costs money) until a refill is due')
  })

  test('7 days left: a refill starts and GoodRx is asked once', async () => {
    const w = await due()
    assert.equal(w.refills.state().refills.length, 1)
    assert.equal(first(w).medicine, 'Donepezil 5 mg')
    assert.equal(w.lookup.calls.length, 1)
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

  test('checking again and again still makes one refill and one lookup per medicine', async () => {
    const w = await due()
    w.refills.check(); w.refills.check(); await w.refills.idle()
    assert.equal(w.refills.state().refills.length, 1)
    assert.equal(w.lookup.calls.length, 1)
  })

  test('a medicine whose pill count is unknown is left alone', () => {
    const w = world({ medicine: { quantity: null } }); delete w.care.stock
    w.refills.check()
    assert.equal(w.refills.state().refills.length, 0)
  })
})

describe('2. the errands agent looks up GoodRx prices and stops', () => {
  test('the cheapest price is the quote, and the others are shown too', async () => {
    const w = await due()
    const r = first(w)
    assert.equal(r.status, 'awaiting_approval')
    assert.equal(r.quote?.pharmacy, 'CVS Pharmacy')
    assert.equal(r.quote?.priceCents, 1240)
    assert.equal(r.quote?.priceType, 'GoodRx coupon')
    assert.equal(r.quote?.quantity, 30)
    assert.deepEqual(r.quote?.prices.map(p => [p.pharmacy, p.priceCents]), [['CVS Pharmacy', 1240], ['Walmart', 1310], ['Costco', 1495]])
    assert.equal(r.quote?.url, 'https://www.goodrx.com/donepezil')
  })

  test('nothing is bought and nothing is on the calendar yet', async () => {
    const w = await due()
    assert.equal(first(w).status, 'awaiting_approval')
    assert.equal(first(w).approvedBy, undefined)
    assert.equal(w.events.length, 0)
  })

  test('GoodRx is asked about the right medicine, size, form and the patient\'s ZIP code', async () => {
    const w = await due()
    assert.deepEqual(w.lookup.calls[0], ['test-key', { name: 'Donepezil', strength: '5 mg', form: 'tablet', quantity: 30 }, '90024'])
  })

  test('no ZIP code: it says what to do instead of guessing', async () => {
    const w = await due(world({ zip: null }))
    assert.equal(first(w).status, 'needs_review')
    assert.match(first(w).error!, /ZIP code/)
    assert.equal(w.lookup.calls.length, 0, 'and it does not spend money on a lookup')
  })

  test('GoodRx has no price: a person is told why', async () => {
    const w = await due(world({ lookup: fakeLookup({ url: '', quantity: 30, quotes: [], note: 'GoodRx does not list this medicine.' }) }))
    assert.equal(first(w).status, 'needs_review')
    assert.match(first(w).error!, /GoodRx had no price for Donepezil 5 mg: GoodRx does not list this medicine/)
  })

  test('GoodRx offers a different size: the price is for that many tablets, and receiving credits that many', async () => {
    const w = await due(world({ lookup: fakeLookup({ ...GOODRX, quantity: 60 }) }))
    assert.equal(first(w).quote?.quantity, 60)
    assert.equal(first(w).quantity, 60)
    w.refills.approve(first(w).id, { approvedBy: 'Maya', expectedPriceCents: 1240 })
    w.refills.received(first(w).id)
    assert.equal(w.care.stock![KEY].count, 7 + 60)
  })

  test('a lookup that fails needs a person, and asking again recovers', async () => {
    let up = false
    const finder: PriceFinder = { name: 'x', quoteTtlMs: 1000, prepare: async () => { if (!up) throw new Error('Browser Use run failed'); return { pharmacy: 'CVS', priceCents: 1000, quantity: 30, prices: [{ pharmacy: 'CVS', priceCents: 1000, priceType: '' }] } } }
    const w = await due(world({ finder }))
    assert.equal(first(w).status, 'needs_review')
    assert.match(first(w).error!, /Browser Use run failed/)
    up = true
    w.refills.requote(first(w).id); await w.refills.idle()
    assert.equal(first(w).status, 'awaiting_approval')
  })

  test('with no Browser Use key it says so, with no made-up prices', async () => {
    const w = await due(world({ finder: noKeyFinder }))
    assert.equal(first(w).status, 'needs_review')
    assert.match(first(w).error!, /BROWSER_USE_API_KEY is missing/)
    assert.equal(first(w).quote, undefined)
  })
})

describe('3 and 4. approval and the pickup reminder', () => {
  const approve = (w: ReturnType<typeof world>, extra = {}) => w.refills.approve(first(w).id, { approvedBy: 'Maya', expectedPriceCents: 1240, ...extra })

  test('approving within the limit puts a pickup reminder on the calendar', async () => {
    const w = await due()
    approve(w)
    const r = first(w)
    assert.equal(r.status, 'approved')
    assert.equal(r.approvedBy, 'Maya')
    assert.equal(new Date(r.pickupAt!).getHours(), 10)
    assert.equal(new Date(r.pickupAt!).getDate(), 18)
    assert.equal(w.events.length, 1)
    assert.equal(w.events[0].activity, 'Pick up Donepezil 5 mg at CVS Pharmacy')
    assert.equal(w.events[0].start, r.pickupAt)
    assert.equal(r.calendarPlanId, w.events[0].id)
  })

  test('it is never called an order, and no order is made', async () => {
    const w = await due(); approve(w)
    assert.equal('order' in first(w), false)
    assert.ok(!w.refills.state().activity.some(a => /ordered|order placed/i.test(a.text)))
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

  test('over the family limit: blocked, and nothing on the calendar', async () => {
    const w = await due(world({ limit: 1000 }))
    rejects(() => approve(w), 409, /over the family limit of \$10\.00/)
    assert.equal(first(w).status, 'awaiting_approval')
    assert.equal(w.events.length, 0)
  })

  test('raising the limit lets the same refill go ahead; a limit equal to the price is allowed', async () => {
    const w = await due(world({ limit: 1000 }))
    rejects(() => approve(w), 409)
    w.refills.setLimit(1240)
    approve(w)
    assert.equal(first(w).status, 'approved')
  })

  test('out-of-date prices need fresh prices first', async () => {
    const w = await due()
    w.advance(7 * 60 * 60_000)
    rejects(() => approve(w), 409, /out of date/)
    w.refills.requote(first(w).id); await w.refills.idle()
    approve(w)
    assert.equal(first(w).status, 'approved')
    assert.equal(w.lookup.calls.length, 2)
  })

  test('approving twice adds one reminder, not two', async () => {
    const w = await due(); approve(w)
    rejects(() => approve(w), 409, /not waiting/)
    assert.equal(w.events.length, 1)
  })
})

describe('saying no, and changing the pill count', () => {
  test('not now: nothing is added and HALO does not look again by itself', async () => {
    const w = await due()
    w.refills.reject(first(w).id)
    w.refills.check(); await w.refills.idle()
    assert.equal(first(w).status, 'rejected')
    assert.equal(w.refills.state().refills.length, 1)
    assert.equal(w.lookup.calls.length, 1)
    assert.equal(w.events.length, 0)
  })

  test('after a no, fresh prices can be asked for', async () => {
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

  test('an approved refill stays while the count is still low, and closes when the count is raised', async () => {
    const w = await due()
    w.refills.approve(first(w).id, { approvedBy: 'Maya', expectedPriceCents: 1240 })
    w.refills.check()
    assert.equal(first(w).status, 'approved')
    w.care.stock![KEY] = { count: 444, at: '2026-10-17T12:00:00Z' }
    w.refills.check()
    assert.equal(first(w).status, 'cancelled')
    assert.equal(w.refills.state().refills.length, 1)
  })

  test('a medicine taken off the prescription cancels its pending refill', async () => {
    const w = await due()
    w.care.prescriptions = []
    w.refills.check()
    assert.equal(first(w).status, 'cancelled')
  })

  test('a price that arrives after the refill was cancelled is dropped, not brought back to life', async () => {
    let release!: () => void
    const slow = (async () => { await new Promise<void>(r => { release = r }); return GOODRX }) as GoodRxLookup
    const w = world({ lookup: slow as ReturnType<typeof fakeLookup> })
    dose(w, '2026-10-17 21:00'); w.refills.check()
    w.care.prescriptions = [] // taken off the prescription while GoodRx is still being asked
    w.refills.check()
    assert.equal(first(w).status, 'cancelled')
    release(); await w.refills.idle()
    assert.equal(first(w).status, 'cancelled')
    assert.equal(first(w).quote, undefined)
  })
})

describe('the medicine is in hand', () => {
  async function approved() {
    const w = await due()
    w.refills.approve(first(w).id, { approvedBy: 'Maya', expectedPriceCents: 1240 })
    return w
  }

  test('marking it received adds the tablets to the pill count, once', async () => {
    const w = await approved()
    w.refills.received(first(w).id); w.refills.received(first(w).id)
    assert.equal(first(w).status, 'received')
    assert.equal(w.care.stock![KEY].count, 7 + 30)
  })

  test('only an approved refill can be received', async () => {
    const w = await due()
    rejects(() => w.refills.received(first(w).id), 409)
    assert.equal(w.care.stock![KEY].count, 8)
  })

  test('after receiving, the cycle is over and nothing new starts', async () => {
    const w = await approved()
    w.refills.received(first(w).id)
    w.refills.check(); await w.refills.idle()
    assert.equal(w.refills.state().refills.length, 1)
    assert.equal(w.lookup.calls.length, 1)
  })
})

describe('restarts and the log', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'halo-refills-'))
  const reopen = (d: string, w: ReturnType<typeof world>, finder: PriceFinder) => createRefills({
    dataDir: d, finder, readData: () => w.care, readDoses: () => w.doses, setStock: () => {}, addToCalendar: () => ({ id: 'x' }),
  })

  test('state survives a restart without another paid lookup', async () => {
    const d = dir()
    const w = await due(world({ dataDir: d }))
    const again = reopen(d, w, goodrxFinder({ apiKey: 'k', lookup: fakeLookup() }))
    again.check(); await again.idle()
    assert.equal(again.state().refills[0].status, 'awaiting_approval')
    assert.equal(again.state().refills[0].quote?.priceCents, 1240)
    assert.equal(again.state().refills.length, 1)
  })

  test('a restart in the middle of a lookup picks it up again', async () => {
    const d = dir()
    const hung: PriceFinder = { name: 'x', quoteTtlMs: 1000, prepare: () => new Promise(() => {}) }
    const w = world({ dataDir: d, finder: hung })
    dose(w, '2026-10-17 21:00'); w.refills.check()
    const lookup = fakeLookup()
    const again = reopen(d, w, goodrxFinder({ apiKey: 'k', lookup }))
    await new Promise(r => setTimeout(r, 5)); await again.idle()
    assert.equal(again.state().refills[0].status, 'awaiting_approval')
    assert.equal(lookup.calls.length, 1)
  })

  test('the activity log tells the story, newest first', async () => {
    const w = await due()
    w.refills.approve(first(w).id, { approvedBy: 'Maya', expectedPriceCents: 1240 })
    const log = w.refills.state().activity.map(a => a.text)
    assert.match(log[0], /Maya approved \$12\.40 at CVS Pharmacy/)
    assert.match(log[1], /GoodRx: \$12\.40 for 30 tablets at CVS Pharmacy .*Nothing has been bought/)
    assert.match(log[2], /down to 7 days.*GoodRx/)
  })

  test('the limit must be a sensible whole number of cents', () => {
    const w = world()
    rejects(() => w.refills.setLimit(-1), 400)
    rejects(() => w.refills.setLimit(12.5), 400)
    rejects(() => w.refills.setLimit('2000'), 400)
    assert.equal(w.refills.setLimit(5000).spendingLimitCents, 5000)
  })
})

describe('the GoodRx price finder', () => {
  const errand = { medicine: 'Donepezil 5 mg', quantity: 30, med: { name: 'Donepezil', strength: '5 mg', form: 'tablet' }, zip: '90024' }
  const finder = (result: typeof GOODRX) => goodrxFinder({ apiKey: 'k', lookup: fakeLookup(result) })

  test('sorts cheapest first and converts dollars to whole cents', async () => {
    const p = await finder({ ...GOODRX, quotes: [{ pharmacy: 'A', price: 10.1, priceType: '' }, { pharmacy: 'B', price: 9.99, priceType: '' }, { pharmacy: 'C', price: 19.995, priceType: '' }] }).prepare(errand)
    assert.deepEqual(p.prices.map(x => [x.pharmacy, x.priceCents]), [['B', 999], ['A', 1010], ['C', 2000]])
    assert.equal(p.pharmacy, 'B')
  })

  test('shows only the five cheapest', async () => {
    const quotes = Array.from({ length: 8 }, (_, i) => ({ pharmacy: `P${i}`, price: 20 - i, priceType: '' }))
    const p = await finder({ ...GOODRX, quotes }).prepare(errand)
    assert.equal(p.prices.length, 5)
    assert.equal(p.prices[0].pharmacy, 'P7')
  })

  test('ignores prices that are zero, negative, not numbers or have no pharmacy', async () => {
    const p = await finder({ ...GOODRX, quotes: [{ pharmacy: 'Free', price: 0, priceType: '' }, { pharmacy: 'Neg', price: -3, priceType: '' }, { pharmacy: '', price: 5, priceType: '' }, { pharmacy: 'NaN', price: NaN, priceType: '' }, { pharmacy: 'Real', price: 11, priceType: 'GoodRx coupon' }] }).prepare(errand)
    assert.deepEqual(p.prices.map(x => x.pharmacy), ['Real'])
  })

  test('no usable price is an error, with GoodRx\'s own explanation', async () => {
    await assert.rejects(finder({ ...GOODRX, quotes: [], note: 'Not listed' }).prepare(errand), /GoodRx had no price for Donepezil 5 mg: Not listed/)
  })

  test('a missing ZIP is an error', async () => {
    await assert.rejects(finder(GOODRX).prepare({ ...errand, zip: undefined }), /ZIP code/)
  })

  test('the lookup is cached for hours, not minutes', () => {
    assert.ok(finder(GOODRX).quoteTtlMs >= 3 * 60 * 60_000)
  })
})
