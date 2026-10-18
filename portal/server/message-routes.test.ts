import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'

test('HTTP Flow F: approve, filter, deduplicate, review, confirm demo reply, revoke', async () => {
  process.env.HALO_MESSAGES_FILE = ':memory:'
  process.env.HALO_MESSAGE_WEBHOOK_TOKEN = crypto.randomUUID()
  delete process.env.HALO_MESSAGE_SEND_URL
  const { configurePhotonMessaging, isApprovedMessageContact, messageRoutes, receivePhotonMessage, recordPhotonOutgoing } = await import('./message-routes.ts')
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
    const webhookMessage = (await call('/state')).data.message
    assert.equal(webhookMessage.demo, false)
    await call(`/${webhookMessage.id}/dismiss`, {})
    const sentToPhoton: string[] = []
    configurePhotonMessaging({
      send: async reply => { sentToPhoton.push(reply.text); return 'photon-accepted-1' },
      status: () => ({ configured: true, agentNumber: '+12025550100', connected: [c.phone] }),
    })
    const photonMessage = { providerId: 'photon-1', from: c.phone, text: 'Running late', receivedAt: '2026-10-18T08:00:00.000Z' }
    const receivedPhoton = receivePhotonMessage(photonMessage)
    assert.equal(receivedPhoton.allowedOnArrival, true)
    assert.equal(receivePhotonMessage(photonMessage).id, receivedPhoton.id)
    assert.equal(isApprovedMessageContact(c.phone), true)
    const photonState = (await call('')).data
    assert.equal(photonState.mode, 'photon')
    assert.equal(photonState.photon.agentNumber, '+12025550100')
    const pending = (await call('/state')).data.message
    const draft = (await call(`/${pending.id}/draft`, { text: 'See you soon!' })).data
    const confirmed = await call(`/${draft.id}/confirm`, { confirmed: true, text: draft.text })
    assert.equal(confirmed.data.providerId, 'photon-accepted-1')
    assert.deepEqual(sentToPhoton, ['See you soon!'])
    recordPhotonOutgoing({ providerId: 'photon-alert-1', to: c.phone, text: 'A friendly care update', kind: 'care' })
    assert.equal((await call('/contacts', { ...c, approved: false })).status, 200)
    assert.equal(isApprovedMessageContact(c.phone), false)
    assert.equal((await call('/state')).data.message, null)
    const inbox = (await call('')).data
    assert.equal(inbox.messages.length, 4)
    assert.equal(inbox.replies.length, 2)
    assert.deepEqual(inbox.outgoing.map((message: { providerId: string; kind: string }) => ({ providerId: message.providerId, kind: message.kind })), [{ providerId: 'photon-alert-1', kind: 'care' }])
    assert.equal((await call('/demo', { from: 'bad', providerId: 'bad', text: 'bad' })).status, 400)
  } finally {
    const { configurePhotonMessaging } = await import('./message-routes.ts')
    configurePhotonMessaging(null)
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  }
})
