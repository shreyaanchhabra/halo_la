// Bridges this Mac's Messages app to HALO using Photon's imessage-kit (macOS, Full Disk Access).
// Incoming iMessages/SMS from people -> POST /api/messages/incoming. HALO's send adapter -> sdk.send.
// Run with: npm run bridge. Needs HALO_MESSAGE_WEBHOOK_TOKEN and HALO_MESSAGE_SEND_TOKEN in .env.local.
import http from 'node:http'
import { IMessageSDK } from '@photon-ai/imessage-kit'

try { process.loadEnvFile(new URL('../.env.local', import.meta.url)) } catch { /* env must come from the shell */ }
const HALO = process.env.HALO_URL ?? 'http://localhost:8787'
const PORT = Number(process.env.HALO_BRIDGE_PORT ?? 8788)
const webhookToken = process.env.HALO_MESSAGE_WEBHOOK_TOKEN
const sendToken = process.env.HALO_MESSAGE_SEND_TOKEN
if (!webhookToken || !sendToken) { console.error('[bridge] Set HALO_MESSAGE_WEBHOOK_TOKEN and HALO_MESSAGE_SEND_TOKEN in .env.local'); process.exit(1) }

const sdk = new IMessageSDK()
const sent = new Map() // Idempotency-Key -> providerId, so a retry never texts twice

async function forward(msg) {
  const from = msg.participant
  if (!from || !msg.text?.trim()) return
  try {
    const res = await fetch(`${HALO}/api/messages/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${webhookToken}` },
      body: JSON.stringify({ providerId: msg.id, from, text: msg.text }),
    })
    console.log(`[bridge] ${from} -> HALO ${res.status}`)
  } catch (e) { console.error('[bridge] could not reach HALO:', e.message) }
}

await sdk.startWatching({ onDirectMessage: msg => { if (!msg.isFromMe) void forward(msg) }, onError: e => console.error('[bridge] watcher:', e.message) })

http.createServer((req, res) => {
  const reply = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
  if (req.method !== 'POST' || req.url !== '/send') return reply(404, { error: 'not found' })
  if (req.headers.authorization !== `Bearer ${sendToken}`) return reply(401, { error: 'unauthorized' })
  const key = req.headers['idempotency-key']
  if (!key) return reply(400, { error: 'Idempotency-Key required' })
  let raw = ''
  req.on('data', c => { raw += c; if (raw.length > 20_000) req.destroy() })
  req.on('end', async () => {
    if (sent.has(key)) return reply(200, { providerId: sent.get(key) })
    try {
      const { to, text } = JSON.parse(raw)
      if (!to || !text) return reply(400, { error: 'to and text required' })
      await sdk.send(to, text)
      sent.set(key, `imessage-${key}`)
      console.log(`[bridge] sent reply to ${to}`)
      reply(200, { providerId: sent.get(key) })
    } catch (e) { console.error('[bridge] send failed:', e.message); reply(502, { error: 'send failed' }) }
  })
}).listen(PORT, '127.0.0.1', () => console.log(`[bridge] watching Messages; send adapter on http://127.0.0.1:${PORT}/send`))
process.on('SIGINT', () => { sdk.stopWatching(); void sdk.close(); process.exit(0) })
