import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'
import { createCalendar, type Care, type Outcome } from './calendar.ts'
import { transcribeWav } from './groq.ts'
import { identifySpeakerWav } from './voiceid.ts'
import { buildIcs } from '../src/schedule.ts'
import { planTitle, whenLabel } from '../../shared/format.ts'

// The calendar's endpoints, for the portal's dev server (see vite.config.ts). They sit next to the
// /api/data, /api/upload and /api/transcripts routes there and follow the same conventions.

const MAX_BODY = 8 * 1024 * 1024

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('Request too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

export type RoutesOptions = {
  apiKey: string
  dataDir: string
  notify?: () => void
  answerWindowMs?: number
}

export function calendarRoutes(o: RoutesOptions) {
  const haloFile = path.join(o.dataDir, 'halo.json')
  const readHalo = () => { try { return JSON.parse(fs.readFileSync(haloFile, 'utf8')) } catch { return {} } }
  const care = (): Care => { const d = readHalo(); return { patient: d.patient?.name ?? '', people: d.people ?? [] } }
  const needKey = () => { if (!o.apiKey) throw new Error('GROQ_API_KEY is missing. Add it to portal/.env and restart the portal.') }

  const cal = createCalendar({ apiKey: o.apiKey, dataDir: o.dataDir, care, notify: o.notify, answerWindowMs: o.answerWindowMs })
  // Questions the patient doesn't answer move to the family on their own, so check every second
  const timer = setInterval(() => cal.sweep(), 1000)

  // Test only: HALO_DEBUG_INJECT=1 lets a script queue raw 16 kHz PCM for a glasses app opened with ?debug&mic=injected
  const injected: string[] = []
  // Mic levels reported by the glasses app, for tuning on real hardware: GET /api/audio/stats
  let micStats: Record<string, unknown> | null = null

  const describe = (out: Outcome) => ({
    kind: out.kind,
    text: out.line.text,
    ...('answer' in out ? { answer: out.answer } : {}),
    ...('plan' in out ? { plan: out.plan, summary: `${planTitle(out.plan)} · ${whenLabel(out.plan, new Date())}` } : {}),
    ...('error' in out && out.error ? { error: out.error } : {}),
  })

  // Returns true when the request was one of ours
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const route = `${req.method} ${url.pathname}`
    const body = async () => JSON.parse((await readBody(req)).toString() || '{}')

    // Speech from the glasses: one finished utterance as a 16 kHz mono WAV
    if (route === 'POST /api/audio') {
      needKey()
      const c = care()
      const wav = await readBody(req)
      // Speaker identification is local and optional. Transcription and calendar behavior remain intact
      // if the VoiceID sidecar is not running or cannot decide from this utterance.
      const [text, voice] = await Promise.all([
        transcribeWav(wav, o.apiKey, { vocabulary: [...c.people.map(p => p.name), c.patient.split(' ')[0]] }),
        identifySpeakerWav(wav),
      ])
      if (!text) { json(res, { kind: 'silence', text: '' }); return true }
      // VoiceID is the sole speaker-identification source. Do not trust an external
      // x-speaker header as a substitute; non-matches stay explicitly unknown.
      const speaker = voice?.status === 'MATCH' && voice.speaker_name
        ? voice.speaker_name
        : 'unknown'
      json(res, { ...describe(await cal.hear(text, speaker)), speaker, speakerIdentity: voice })
      return true
    }

    // Text that was already transcribed: the patient page's live transcript, or the care portal's test box
    if (route === 'POST /api/transcripts') {
      const { text, speaker } = await body()
      if (typeof text !== 'string' || !text.trim()) { json(res, { error: 'text is required' }, 400); return true }
      json(res, describe(await cal.hear(text, speaker || 'unknown')))
      return true
    }

    if (route === 'GET /api/plans') { json(res, cal.plans()); return true }
    if (route === 'POST /api/plans') {
      const b = await body()
      if (!b.activity || !b.start || Number.isNaN(Date.parse(b.start))) { json(res, { error: 'activity and a valid start are required' }, 400); return true }
      json(res, cal.addManual(b), 201)
      return true
    }
    const m = /^\/api\/plans\/([\w-]+)(?:\/(approve|reject|yes|no))?$/.exec(url.pathname)
    if (m) {
      const [, id, action] = m
      let plan
      if (req.method === 'POST' && (action === 'approve' || action === 'reject')) plan = cal.familyAction(id, action)
      else if (req.method === 'POST' && (action === 'yes' || action === 'no')) plan = cal.patientAnswer(id, action)
      else if (req.method === 'PATCH' && !action) plan = cal.editPlan(id, await body())
      else if (req.method === 'DELETE' && !action) { const ok = cal.deletePlan(id); json(res, ok ? { ok: true } : { error: 'Not found' }, ok ? 200 : 404); return true }
      else return false
      json(res, plan ?? { error: 'Not found' }, plan ? 200 : 404)
      return true
    }

    if (route === 'GET /api/present') { json(res, cal.present()); return true }
    if (route === 'PUT /api/present') {
      const { here } = await body()
      if (!Array.isArray(here)) { json(res, { error: 'here must be a list of names' }, 400); return true }
      json(res, cal.setPresent(here.map(String)))
      return true
    }

    if (route === 'GET /api/glasses/state') { json(res, cal.glassesState()); return true }

    if (route === 'POST /api/audio/stats') { micStats = { receivedAt: new Date().toISOString(), ...(await body()) }; json(res, { ok: true }); return true }
    if (route === 'GET /api/audio/stats') { json(res, micStats ?? { receivedAt: null }); return true }

    // Subscribe to this from Apple Calendar, Google Calendar or Outlook: medicines, appointments and plans
    if (route === 'GET /api/calendar.ics') {
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
      res.setHeader('Content-Disposition', 'inline; filename="halo.ics"')
      res.end(buildIcs({ patient: { name: '' }, people: [], prescriptions: [], ...readHalo() }, cal.plans()))
      return true
    }

    if (process.env.HALO_DEBUG_INJECT && url.pathname === '/api/debug/inject') {
      if (req.method === 'POST') { injected.push((await readBody(req)).toString('base64')); json(res, { queued: injected.length }); return true }
      if (req.method === 'GET') { json(res, { clips: injected.splice(0) }); return true }
    }
    return false
  }

  return { cal, handle, stop: () => clearInterval(timer) }
}
