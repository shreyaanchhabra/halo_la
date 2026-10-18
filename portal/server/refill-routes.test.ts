import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { refillRoutes } from './refill-routes.ts'

// The real endpoints and the pharmacy website, over HTTP, with real files in a temp folder
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-refill-http-'))
const events: { activity: string; start: string }[] = []
let routes: ReturnType<typeof refillRoutes>
let server: http.Server
let base = ''

const writeCare = (stockCount: number) => fs.writeFileSync(path.join(dir, 'halo.json'), JSON.stringify({
  patient: { name: 'Joe Martinez' }, people: [],
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
  routes = refillRoutes({ dataDir: dir, calendar: { addManual: e => { events.push(e); return { id: 'cal1' } as never } }, checkEveryMs: 3_600_000 })
  server = http.createServer(async (req, res) => { if (!(await routes.handle(req, res, new URL(req.url ?? '/', 'http://x')))) { res.statusCode = 404; res.end('no') } })
  await new Promise<void>(r => server.listen(0, r))
  base = `http://localhost:${(server.address() as { port: number }).port}`
})
after(() => { routes.stop(); server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('refills over HTTP', () => {
  test('nothing due yet: no refills, and the default limit is $25', async () => {
    const r = await api('GET', '/api/refills')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.refills, [])
    assert.equal(r.body.settings.spendingLimitCents, 2500)
    assert.match(r.body.driver, /Test pharmacy/)
  })

  test('one dose later, 7 days are left and a quote appears with nothing paid', async () => {
    fs.writeFileSync(path.join(dir, 'doses.json'), JSON.stringify([{ medKey: 'rx1:0', slot: '2026-10-17 21:00', at: '2026-10-17T09:00:00Z' }]))
    await api('POST', '/api/refills/check'); await settle()
    const r = await api('GET', '/api/refills')
    assert.equal(r.body.refills.length, 1)
    assert.equal(r.body.refills[0].status, 'awaiting_approval')
    assert.equal(r.body.refills[0].quote.priceCents, 1240)
  })

  test('the pharmacy website shows the cart with checkout locked, and refuses an order', async () => {
    const { quote } = (await api('GET', '/api/refills')).body.refills[0]
    const page = await (await fetch(`${base}/test-pharmacy/cart/${quote.cartId}`)).text()
    assert.match(page, /\$12\.40/)
    assert.match(page, /Checkout is locked until they do/)
    assert.match(page, /id="place-order" disabled/)
    const forced = await fetch(`${base}/test-pharmacy/cart/${quote.cartId}/order`, { method: 'POST', redirect: 'manual' })
    assert.equal(forced.status, 403)
    assert.equal(events.length, 0)
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

  test('approved within the limit: the order is placed and the pickup is on the calendar', async () => {
    await api('PUT', '/api/refills/settings', { spendingLimitCents: 2000 })
    const { id, quote } = (await api('GET', '/api/refills')).body.refills[0]
    const ok = await api('POST', `/api/refills/${id}/approve`, { approvedBy: 'Maya', expectedPriceCents: 1240 })
    assert.equal(ok.status, 200)
    await settle()
    const r = (await api('GET', '/api/refills')).body.refills[0]
    assert.equal(r.status, 'ordered')
    assert.equal(r.approvedBy, 'Maya')
    assert.deepEqual(events.map(e => e.activity), ['Pick up Donepezil 5 mg'])
    assert.equal(events[0].start, r.order.readyAt)
    const page = await (await fetch(`${base}/test-pharmacy/cart/${quote.cartId}`)).text()
    assert.match(page, new RegExp(`Order ${r.order.id} confirmed`))
  })

  test('approving again, or pressing Place order again, changes nothing', async () => {
    const { id, quote, order } = (await api('GET', '/api/refills')).body.refills[0]
    assert.equal((await api('POST', `/api/refills/${id}/approve`, { approvedBy: 'Maya', expectedPriceCents: 1240 })).status, 409)
    await fetch(`${base}/test-pharmacy/cart/${quote.cartId}/order`, { method: 'POST', redirect: 'manual' })
    assert.equal(events.length, 1)
    assert.equal((await api('GET', '/api/refills')).body.refills[0].order.id, order.id)
  })

  test('receiving the medicine raises the pill count in the care data, once', async () => {
    const { id } = (await api('GET', '/api/refills')).body.refills[0]
    assert.equal((await api('POST', `/api/refills/${id}/received`)).status, 200)
    assert.equal((await api('POST', `/api/refills/${id}/received`)).status, 200)
    const care = JSON.parse(fs.readFileSync(path.join(dir, 'halo.json'), 'utf8'))
    assert.equal(care.stock['rx1:0'].count, 7 + 30) // 7 left (8, minus the dose taken) plus the 30 that arrived
    assert.equal(care.patient.name, 'Joe Martinez', 'the rest of the care data is untouched')
  })

  test('unknown routes and unknown refills', async () => {
    assert.equal((await api('GET', '/api/refills/nope')).status, 404)
    assert.equal((await api('POST', '/api/refills/does-not-exist/approve', { approvedBy: 'M', expectedPriceCents: 1 })).status, 404)
  })

  test('the pharmacy website home and search work for a browser agent', async () => {
    assert.match(await (await fetch(`${base}/test-pharmacy`)).text(), /Search/)
    const search = await (await fetch(`${base}/test-pharmacy/search?name=Donepezil%205%20mg&quantity=30`)).text()
    assert.match(search, /\$12\.40/)
    assert.match(search, /Add to cart/)
  })

  test('refill state is saved to disk', () => {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'refills.json'), 'utf8'))
    assert.equal(saved.refills[0].status, 'received')
    assert.ok(saved.activity.length >= 5)
  })
})
