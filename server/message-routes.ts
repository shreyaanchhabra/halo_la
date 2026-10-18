import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage as Request, ServerResponse } from 'node:http'
import { emptyMessages, MessageError, MessageService, type MessageTransport } from './messages.ts'
import { transcribe } from './groq.ts'
import type { MessagingData } from '../shared/messages.ts'

const file = process.env.HALO_MESSAGES_FILE ?? fileURLToPath(new URL('./data/messages.json', import.meta.url))
const memory = file === ':memory:'
const data: MessagingData = !memory && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : emptyMessages()
// An interrupted send is ambiguous after restart. Never automatically send it again.
for (const r of data.replies) if (r.status === 'sending') r.status = 'unknown'
const service = new MessageService(data, () => {
  if (memory) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
})

// HALO adapter contract, not a claim about Photon's API. The adapter translates to the provider.
const transport: MessageTransport = {
  mode: process.env.HALO_MESSAGE_SEND_URL ? 'live' : 'demo',
  async send(reply) {
    const destination = new URL(process.env.HALO_MESSAGE_SEND_URL!)
    if (destination.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname)) throw new Error('Adapter must use HTTPS')
    const response = await fetch(destination, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': reply.id, ...(process.env.HALO_MESSAGE_SEND_TOKEN ? { Authorization: `Bearer ${process.env.HALO_MESSAGE_SEND_TOKEN}` } : {}) },
      body: JSON.stringify({ id: reply.id, to: reply.to, text: reply.text }),
    })
    if (!response.ok) throw new Error('Adapter rejected reply')
    const result = await response.json() as { providerId?: unknown }
    if (typeof result.providerId !== 'string' || !result.providerId) throw new Error('Adapter must return providerId')
    return result.providerId
  },
}

async function body(req: Request, max = 16_384): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) throw new MessageError('Request too large', 413)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
async function json(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse((await body(req)).toString() || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch (e) { if (e instanceof MessageError) throw e; throw new MessageError('Expected a JSON object') }
}

export async function messageRoutes(req: Request, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/messages')) return false
  const send = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value)) }
  const route = `${req.method} ${url.pathname}`
  try {
    if (route === 'GET /api/messages/state') send(service.state())
    else if (route === 'GET /api/messages') send({ ...data, mode: transport.mode })
    else if (route === 'POST /api/messages/contacts') send(service.upsertContact(await json(req)))
    else if (route === 'POST /api/messages/demo') send(service.receive(await json(req), true), 201)
    else if (route === 'POST /api/messages/incoming') {
      const token = process.env.HALO_MESSAGE_WEBHOOK_TOKEN
      if (!token) throw new MessageError('Live incoming webhook is not configured', 503)
      const expected = Buffer.from(`Bearer ${token}`); const actual = Buffer.from(req.headers.authorization ?? '')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new MessageError('Invalid webhook authorization', 401)
      send(service.receive(await json(req)), 201)
    } else {
      const match = /^\/api\/messages\/([\w-]+)\/(dismiss|draft|audio|confirm|cancel)$/.exec(url.pathname)
      if (!match || req.method !== 'POST') throw new MessageError('Message route not found', 404)
      const [, id, action] = match
      if (action === 'dismiss') { service.dismiss(id); send({ ok: true }) }
      if (action === 'cancel') { service.cancel(id); send({ ok: true }) }
      if (action === 'draft') send(service.draft(id, (await json(req)).text), 201)
      if (action === 'audio') {
        // Reject a revoked or unknown message before uploading any recording to transcription.
        if (service.state().message?.id !== id) throw new MessageError('Message no longer active', 403)
        const wav = await body(req, 2 * 1024 * 1024)
        const transcript = await transcribe(wav)
        if (!transcript) throw new MessageError('No speech recognized. Hold to try again.')
        send(service.draft(id, transcript), 201)
      }
      if (action === 'confirm') send(await service.confirm(id, await json(req), transport))
    }
  } catch (e) {
    send({ error: e instanceof MessageError ? e.message : 'Messaging request failed' }, e instanceof MessageError ? e.status : 500)
  }
  return true
}
