import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { refillRoutes } from './refill-routes.ts'
import { goodrxFinder } from './errands.ts'

// The real endpoints over HTTP, with real files in a temp folder. GoodRx is faked; no money is spent.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-refill-http-'))
const events: { activity: string; start: string }[] = []
let routes: ReturnType<typeof refillRoutes>
let server: http.Server
let base = ''
let lookups = 0

const writeCare = (stockCount: number, zip = '90024', to = dir) => fs.writeFileSync(path.join(to, 'halo.json'), JSON.stringify({
  patient: { name: 'Joe Martinez', zip }, people: [],
  prescriptions: [{ id: 'rx1', file: 'f', originalName: 'rx.pdf', doctor: 'Dr. Patel', date: '2026-10-01', notes: '', uploadedAt: '2026-10-01T00:00:00Z',
    reading: { medicines: [{ name: 'Donepezil', strength: '5 mg', form: 'tablet', instructions: '', times: ['21:00'], quantity: 30, refills: 2 }], appointments: [], notes: [], readAt: '' } }],
  stock: { 'rx1:0': { count: stockCount, at: '2026-10-17T00:00:00Z' } },
}))
const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const settle = () => routes.refills.idle()

before(async () => {
  writeCare(8)
  fs.writeFileSync(path.join(dir, 'doses.json'), '[]')
  const finder = goodrxFinder({ apiKey: 'k', lookup: async () => { lookups++; return { url: 'https://www.goodrx.com/donepezil', quantity: 30, note: '', quotes: [{ pharmacy: 'Walmart', price: 13.1, priceType: 'GoodRx coupon' }, { pharmacy: 'CVS Pharmacy', price: 12.4, priceType: 'GoodRx coupon' }] } } })
  routes = refillRoutes({ dataDir: dir, finder, calendar: { addManual: e => { events.push(e); return { id: 'cal1' } as never } }, checkEveryMs: 3_600_000 })
  server = http.createServer(async (req, res) => { if (!(await routes.handle(req, res, new URL(req.url ?? '/', 'http://x')))) { res.statusCode = 404; res.end('no') } })
  await new Promise<void>(r => server.listen(0, r))
  base = `http://localhost:${(server.address() as { port: number }).port}`
})
after(() => { routes.stop(); server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('refills over HTTP', () => {
  test('nothing due yet: no refills, no lookup, default limit $25, and GoodRx named as the source', async () => {
    const r = await api('GET', '/api/refills')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.refills, [])
    assert.equal(r.body.settings.spendingLimitCents, 2500)
    assert.match(r.body.driver, /GoodRx/)
    assert.equal(lookups, 0)
  })

  test('one dose later, 7 days are left and GoodRx prices appear, cheapest first', async () => {
    fs.writeFileSync(path.join(dir, 'doses.json'), JSON.stringify([{ medKey: 'rx1:0', slot: '2026-10-17 21:00', at: '2026-10-17T09:00:00Z' }]))
    await api('POST', '/api/refills/check'); await settle()
    const r = (await api('GET', '/api/refills')).body.refills
    assert.equal(r.length, 1)
    assert.equal(r[0].status, 'awaiting_approval')
    assert.equal(r[0].quote.pharmacy, 'CVS Pharmacy')
    assert.equal(r[0].quote.priceCents, 1240)
    assert.deepEqual(r[0].quote.prices.map((p: { pharmacy: string }) => p.pharmacy), ['CVS Pharmacy', 'Walmart'])
    assert.equal(lookups, 1)
    assert.equal(events.length, 0)
  })

  test('there is no pharmacy website or order endpoint any more', async () => {
    assert.equal((await fetch(`${base}/test-pharmacy`)).status, 404)
  })

  test('approval needs a name and the exact price, and respects the limit', async () => {
    const { id } = (await api('GET', '/api/refills')).body.refills[0]
    assert.equal((await api('POST', `/api/refills/${id}/approve`, { expectedPriceCents: 1240 })).status, 400)
    assert.equal((await api('POST', `/api/refills/${id}/approve`, { approvedBy: 'Maya', expectedPriceCents: 1 })).status, 409)
    await api('PUT', '/api/refills/settings', { spendingLimitCents: 1000 })
    const over = await api('POST', `/api/refills/${id}/approve`, { approvedBy: 'Maya', expectedPriceCents: 1240 })
    assert.equal(over.status, 409)
    assert.match(over.body.error, /over the family limit of \$10\.00/)
    assert.equal((await api('PUT', '/api/refills/settings', { spendingLimitCents: 'lots' })).status, 400)
    assert.equal(events.length, 0)
  })

  test('approved within the limit: a pickup reminder is on the calendar, and nothing is "ordered"', async () => {
    await api('PUT', '/api/refills/settings', { spendingLimitCents: 2000 })
    const { id } = (await api('GET', '/api/refills')).body.refills[0]
    const ok = await api('POST', `/api/refills/${id}/approve`, { approvedBy: 'Maya', expectedPriceCents: 1240 })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.status, 'approved')
    assert.deepEqual(events.map(e => e.activity), ['Pick up Donepezil 5 mg at CVS Pharmacy'])
    assert.equal(events[0].start, ok.body.pickupAt)
    assert.equal(ok.body.order, undefined)
  })

  test('approving again changes nothing', async () => {
    const { id } = (await api('GET', '/api/refills')).body.refills[0]
    assert.equal((await api('POST', `/api/refills/${id}/approve`, { approvedBy: 'Maya', expectedPriceCents: 1240 })).status, 409)
    assert.equal(events.length, 1)
  })

  test('receiving the medicine raises the pill count in the care data, once', async () => {
    const { id } = (await api('GET', '/api/refills')).body.refills[0]
    assert.equal((await api('POST', `/api/refills/${id}/received`)).status, 200)
    assert.equal((await api('POST', `/api/refills/${id}/received`)).status, 200)
    const care = JSON.parse(fs.readFileSync(path.join(dir, 'halo.json'), 'utf8'))
    assert.equal(care.stock['rx1:0'].count, 7 + 30) // 7 left (8, minus the dose taken) plus the 30 that arrived
    assert.equal(care.patient.name, 'Joe Martinez', 'the rest of the care data is untouched')
    assert.equal(care.patient.zip, '90024')
  })

  test('unknown refills', async () => {
    assert.equal((await api('GET', '/api/refills/nope')).status, 404)
    assert.equal((await api('POST', '/api/refills/does-not-exist/approve', { approvedBy: 'M', expectedPriceCents: 1 })).status, 404)
  })

  test('refill state is saved to disk', () => {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'refills.json'), 'utf8'))
    assert.equal(saved.refills[0].status, 'received')
    assert.ok(saved.activity.length >= 4)
  })
})

describe('with no Browser Use key', () => {
  test('the refill says what is missing, and spends nothing', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-refill-nokey-'))
    writeCare(8, '90024', d)
    fs.writeFileSync(path.join(d, 'doses.json'), JSON.stringify([{ medKey: 'rx1:0', slot: '2026-10-17 21:00', at: '2026-10-17T09:00:00Z' }]))
    const r = refillRoutes({ dataDir: d, calendar: { addManual: () => ({ id: 'x' }) as never }, checkEveryMs: 3_600_000 })
    try {
      r.check(); await r.refills.idle()
      const refill = r.refills.state().refills[0]
      assert.equal(refill.status, 'needs_review')
      assert.match(refill.error!, /BROWSER_USE_API_KEY is missing/)
      assert.equal(refill.quote, undefined)
    } finally {
      r.stop(); fs.rmSync(d, { recursive: true, force: true })
    }
  })
})
