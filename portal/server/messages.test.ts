import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyMessages, MessageService, phone, type MessageTransport } from './messages.ts'

function fixture() {
  let time = Date.parse('2026-10-18T00:00:00Z'), sends = 0
  const service = new MessageService(emptyMessages(), () => {}, () => new Date(time))
  const contact = { phone: '+12025550101', name: 'Maya', relation: 'granddaughter', approved: true }
  const transport: MessageTransport = { mode: 'live', send: async () => { sends++; return 'accepted-1' } }
  const receive = (demo = false) => service.receive({ from: contact.phone, providerId: 'incoming-1', text: 'Running 10 min late!' }, demo)
  return { service, contact, transport, receive, advance: (ms: number) => { time += ms }, sends: () => sends }
}
test('unknown senders remain in family inbox and never reach glasses, even after approval', () => {
  const f = fixture(), m = f.receive()
  assert.equal(f.service.data.messages.length, 1)
  assert.equal(f.service.state().message, null)
  f.service.upsertContact(f.contact)
  assert.equal(f.service.state().message, null)
  assert.throws(() => f.service.draft(m.id, 'Hello'), /not approved/)
})
test('approved message shows only name, relationship, body and source ID; webhook retries deduplicate', () => {
  const f = fixture(); f.service.upsertContact(f.contact)
  const m = f.receive()
  assert.equal(f.receive().id, m.id)
  assert.equal(f.service.data.messages.length, 1)
  assert.deepEqual(f.service.state().message, { id: m.id, name: 'Maya', relation: 'granddaughter', text: m.text, demo: false })
  assert.throws(() => f.service.receive({ from: f.contact.phone, providerId: 'incoming-1', text: 'changed' }), /already used/)
})
test('revocation removes queued messages, cancels drafts and reapproval does not resurrect them', async () => {
  const f = fixture(); f.service.upsertContact(f.contact)
  const m = f.receive(), r = f.service.draft(m.id, 'See you soon')
  f.service.upsertContact({ ...f.contact, approved: false })
  assert.deepEqual(f.service.state(), { message: null, reply: null })
  await assert.rejects(f.service.confirm(r.id, { confirmed: true, text: r.text }, f.transport), /cancelled/)
  f.service.upsertContact(f.contact)
  assert.equal(f.service.state().message, null)
  assert.equal(f.sends(), 0)
})
test('exact explicit confirmation is required; successful confirmation is idempotent', async () => {
  const f = fixture(); f.service.upsertContact(f.contact)
  const r = f.service.draft(f.receive().id, 'See you soon')
  assert.equal(f.sends(), 0)
  await assert.rejects(f.service.confirm(r.id, { text: r.text }, f.transport), /exact reviewed/)
  await assert.rejects(f.service.confirm(r.id, { confirmed: true, text: 'Changed' }, f.transport), /exact reviewed/)
  assert.equal((await f.service.confirm(r.id, { confirmed: true, text: r.text }, f.transport)).status, 'sent')
  await f.service.confirm(r.id, { confirmed: true, text: r.text }, f.transport)
  assert.equal(f.sends(), 1)
  assert.equal(f.service.state().message, null)
})
test('demo replies never use live transport', async () => {
  const f = fixture(); f.service.upsertContact(f.contact)
  const r = f.service.draft(f.receive(true).id, 'Hello')
  assert.equal((await f.service.confirm(r.id, { confirmed: true, text: r.text }, f.transport)).status, 'demo_sent')
  assert.equal(f.sends(), 0)
})
test('cancelled, expired and dismissed drafts cannot send', async () => {
  for (const action of ['cancel', 'expire', 'dismiss']) {
    const f = fixture(); f.service.upsertContact(f.contact)
    const m = f.receive(), r = f.service.draft(m.id, 'Hello')
    if (action === 'cancel') f.service.cancel(r.id)
    if (action === 'expire') f.advance(120_001)
    if (action === 'dismiss') f.service.dismiss(m.id)
    await assert.rejects(f.service.confirm(r.id, { confirmed: true, text: r.text }, f.transport))
    assert.equal(f.sends(), 0)
  }
})
test('simultaneous confirmation cannot send twice, and unknown delivery never retries', async () => {
  const f = fixture(); f.service.upsertContact(f.contact)
  const r = f.service.draft(f.receive().id, 'Hello')
  let release!: () => void
  const failed: MessageTransport = { mode: 'live', send: () => new Promise<string>((_resolve, reject) => { release = () => reject(new Error('timeout')) }) }
  const first = f.service.confirm(r.id, { confirmed: true, text: r.text }, failed)
  await assert.rejects(f.service.confirm(r.id, { confirmed: true, text: r.text }, f.transport), /sending/)
  release()
  assert.equal((await first).status, 'unknown')
  await assert.rejects(f.service.confirm(r.id, { confirmed: true, text: r.text }, f.transport), /unknown/)
  assert.throws(() => f.service.draft(r.messageId, 'Try again'))
  assert.equal(f.sends(), 0)
})
test('phone numbers normalize formatting but do not guess a country', () => {
  assert.equal(phone('+1 (202) 555-0101'), '+12025550101')
  assert.throws(() => phone('2025550101'), /international/)
  assert.throws(() => phone('Maya'), /international/)
})
test('live incoming messages cannot silently use demo delivery', async () => {
  const f = fixture(); f.service.upsertContact(f.contact)
  const r = f.service.draft(f.receive().id, 'Hello')
  await assert.rejects(f.service.confirm(r.id, { confirmed: true, text: r.text }, { ...f.transport, mode: 'demo' }), /not configured/)
  assert.equal(r.status, 'draft')
})
