import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'

test('HTTP Flow F: approve, filter, deduplicate, review, confirm demo reply, revoke', async () => {
  process.env.HALO_MESSAGES_FILE = ':memory:'
  process.env.HALO_MESSAGE_WEBHOOK_TOKEN = crypto.randomUUID()
  delete process.env.HALO_MESSAGE_SEND_URL
  const { messageRoutes } = await import('./message-routes.ts')
  const server = http.createServer((req, res) => { void messageRoutes(req, res, new URL(req.url!, 'http://localhost')) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  async function call(path: string, body?: object, token?: string) {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/messages${path}`, {
      ...(body ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } } : {}),
    })
    return { status: res.status, data: await res.json() }
  }
  try {
    const c = { phone: '+12025550101', name: 'Maya', relation: 'granddaughter', approved: true }
    assert.equal((await call('/contacts', c)).status, 200)
    assert.equal((await call('/demo', { from: '+12025550199', text: 'Unknown message', providerId: 'unknown-1' })).status, 201)
    assert.equal((await call('/state')).data.message, null)
    const incoming = { from: c.phone, text: 'Running 10 min late!', providerId: 'maya-1' }
    const m = (await call('/demo', incoming)).data
    assert.equal((await call('/demo', incoming)).data.id, m.id)
    assert.equal((await call('/state')).data.message.name, 'Maya')
    const r = (await call(`/${m.id}/draft`, { text: 'See you soon' })).data
    assert.equal((await call(`/${r.id}/confirm`, { text: r.text })).status, 400)
    const sent = await call(`/${r.id}/confirm`, { confirmed: true, text: r.text })
    assert.equal(sent.data.status, 'demo_sent')
    assert.equal((await call('/state')).data.message, null)
    assert.equal((await call('/incoming', { ...incoming, providerId: 'live-1' })).status, 401)
    assert.equal((await call('/incoming', { ...incoming, providerId: 'live-1' }, process.env.HALO_MESSAGE_WEBHOOK_TOKEN)).status, 201)
    assert.equal((await call('/state')).data.message.demo, false)
    assert.equal((await call('/contacts', { ...c, approved: false })).status, 200)
    assert.equal((await call('/state')).data.message, null)
    const inbox = (await call('')).data
    assert.equal(inbox.messages.length, 3)
    assert.equal(inbox.replies.length, 1)
    assert.equal((await call('/demo', { from: 'bad', providerId: 'bad', text: 'bad' })).status, 400)
  } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())) }
})
