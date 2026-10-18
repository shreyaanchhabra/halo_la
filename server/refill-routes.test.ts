process.env.HALO_REFILLS_FILE = ':memory:'
process.env.HALO_CALENDAR_FILE = ':memory:'
delete process.env.HALO_REFILL_DRIVER

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
const { handleRefillRoute } = await import('./refill-routes.ts')
const { db } = await import('./store.ts')

test('HTTP demo: stock -> quote -> approval -> test checkout -> calendar -> receipt', async () => {
  const server = http.createServer(async (req, res) => {
    await handleRefillRoute(req, res, new URL(req.url!, 'http://localhost'), async req => {
      let body = ''; for await (const chunk of req) body += chunk.toString()
      return JSON.parse(body || '{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  async function call(path = '', method = 'GET', body?: unknown) {
    const response = await fetch(`${origin}/api/refills${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  try {
    const added = await call('/medications', 'POST', { sku: 'donepezil-5mg-30', prescriptionId: 'test-rx', doctor: 'Dr. Patel', doctorConfirmed: true, tabletsPerDay: 1, tabletsRemaining: 8 })
    assert.equal(added.status, 201)
    const id = added.body.id
    await call(`/medications/${id}/doses`, 'POST', { eventId: 'dose-001', tablets: 1 })
    let state = (await call()).body
    const r = state.refills[0]
    assert.equal(r.status, 'awaiting_approval')
    const early = await fetch(`${origin}/test-pharmacy/refills/${r.id}`, { method: 'POST', body: 'action=place' })
    assert.equal(early.status, 409)
    await call('/settings', 'PUT', { spendingLimitCents: 1000 })
    assert.equal((await call(`/${r.id}/approve`, 'POST', { approvedBy: 'Maya', expectedTotalCents: 1240 })).status, 409)
    await call('/settings', 'PUT', { spendingLimitCents: 2000 })
    assert.equal((await call(`/${r.id}/approve`, 'POST', { approvedBy: 'Maya', expectedTotalCents: 1240 })).status, 200)
    state = (await call()).body
    assert.equal(state.refills[0].status, 'ordered')
    assert.equal(state.medications[0].tabletsRemaining, 7)
    assert.equal(db.plans.filter(p => p.id === `refill-${r.id}`).length, 1)
    await call(); await call('/check', 'POST')
    assert.equal(db.plans.length, 1)
    assert.equal((await call(`/${r.id}/approve`, 'POST', { approvedBy: 'Maya', expectedTotalCents: 1240 })).status, 409)
    await call(`/${r.id}/received`, 'POST'); await call(`/${r.id}/received`, 'POST')
    assert.equal((await call()).body.medications[0].tabletsRemaining, 37)
    const site = await fetch(`${origin}/test-pharmacy/refills/${r.id}`)
    assert.match(await site.text(), /TEST-/)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
