import http from 'node:http'
import { messageRoutes } from './message-routes.ts'
import { hasKey, transcribe } from './groq.ts'
import { db, readCareData } from './store.ts'
import { toIcs } from './ics.ts'
import { addManual, deletePlan, editPlan, familyAction, glassesState, handleUtterance, setPresent, sweep } from './scheduler.ts'
import { planTitle, whenLabel } from '../shared/format.ts'
import { handleRefillRoute } from './refill-routes.ts'

const PORT = Number(process.env.HALO_PORT ?? 8787)
const MAX_BODY = 8 * 1024 * 1024

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const readJson = async (req: http.IncomingMessage) => JSON.parse((await readBody(req)).toString() || '{}')

function send(res: http.ServerResponse, body: unknown, status = 200) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

// What goes back to whoever sent the audio or text
function describe(out: Awaited<ReturnType<typeof handleUtterance>>) {
  const now = new Date()
  return {
    kind: out.kind,
    text: out.line.text,
    ...('answer' in out ? { answer: out.answer } : {}),
    ...('plan' in out ? { plan: out.plan, summary: `${planTitle(out.plan)} · ${whenLabel(out.plan, now)}` } : {}),
    ...('error' in out && out.error ? { error: out.error } : {}),
  }
}

// Test-only: HALO_DEBUG_INJECT=1 lets a script queue raw 16 kHz PCM for a glasses app opened with
// ?debug&mic=injected to pull in, so the whole audio path can be tested without a microphone.
const injected: string[] = []

// Mic levels reported by the glasses app, for tuning on real hardware: GET /api/audio/stats
let micStats: { receivedAt: string; [k: string]: unknown } | null = null

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const route = `${req.method} ${url.pathname}`
  try {
    if (await messageRoutes(req, res, url)) return
    if (await handleRefillRoute(req, res, url, readJson)) return
    if (route === 'GET /api/health') return send(res, { ok: true, groqKey: hasKey() })

    // Audio from the glasses: one finished utterance as a 16 kHz mono WAV
    if (route === 'POST /api/audio') {
      const wav = await readBody(req)
      const speaker = String(req.headers['x-speaker'] ?? 'unknown')
      const care = readCareData()
      const text = await transcribe(wav, { vocabulary: [...care.people.map(p => p.name), care.patient.split(' ')[0]] })
      if (!text) return send(res, { kind: 'silence', text: '' })
      return send(res, describe(await handleUtterance(text, speaker)))
    }

    // Same thing without audio: for the portal's test box and for the Listener agent later
    if (route === 'POST /api/transcript') {
      const { text, speaker } = await readJson(req)
      if (typeof text !== 'string' || !text.trim()) return send(res, { error: 'text is required' }, 400)
      return send(res, describe(await handleUtterance(text, speaker || 'unknown')))
    }
    if (route === 'GET /api/transcript') return send(res, db.transcript.slice(-100))

    if (route === 'GET /api/plans') { sweep(); return send(res, db.plans) }
    if (route === 'POST /api/plans') {
      const b = await readJson(req)
      if (!b.activity || !b.start || Number.isNaN(Date.parse(b.start))) return send(res, { error: 'activity and a valid start are required' }, 400)
      return send(res, addManual(b), 201)
    }

    const m = /^\/api\/plans\/([\w-]+)(?:\/(approve|reject))?$/.exec(url.pathname)
    if (m) {
      const [, id, action] = m
      if (req.method === 'POST' && action) {
        const plan = familyAction(id, action as 'approve' | 'reject')
        return plan ? send(res, plan) : send(res, { error: 'not found' }, 404)
      }
      if (req.method === 'PATCH' && !action) {
        const plan = editPlan(id, await readJson(req))
        return plan ? send(res, plan) : send(res, { error: 'not found' }, 404)
      }
      if (req.method === 'DELETE' && !action) return deletePlan(id) ? send(res, { ok: true }) : send(res, { error: 'not found' }, 404)
    }

    if (route === 'POST /api/audio/stats') { micStats = { receivedAt: new Date().toISOString(), ...(await readJson(req)) }; return send(res, { ok: true }) }
    if (route === 'GET /api/audio/stats') return send(res, micStats ?? { receivedAt: null })

    if (route === 'GET /api/present') return send(res, db.present)
    if (route === 'PUT /api/present') {
      const { here } = await readJson(req)
      if (!Array.isArray(here)) return send(res, { error: 'here must be a list of names' }, 400)
      return send(res, setPresent(here.map(String)))
    }

    if (route === 'GET /api/calendar.ics') {
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
      res.setHeader('Content-Disposition', 'inline; filename="halo.ics"')
      return res.end(toIcs(db.plans, readCareData().patient))
    }

    if (process.env.HALO_DEBUG_INJECT && url.pathname === '/api/debug/inject') {
      if (req.method === 'POST') { injected.push((await readBody(req)).toString('base64')); return send(res, { queued: injected.length }) }
      if (req.method === 'GET') return send(res, { clips: injected.splice(0) })
    }

    if (route === 'GET /api/glasses/state') return send(res, glassesState())

    send(res, { error: 'not found' }, 404)
  } catch (err) {
    console.error(`[server] ${route}:`, err)
    send(res, { error: String(err) }, 500)
  }
})

setInterval(() => sweep(), 1000).unref()

server.listen(PORT, () => {
  console.log(`HALO calendar server on http://localhost:${PORT}  (Groq key: ${hasKey() ? 'found' : 'MISSING, add GROQ_API_KEY to .env.local'})`)
})
