import { defineConfig, loadEnv, type Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPrescription, transcribe } from './server/ai'
import { createGlasses } from './server/glasses'
import { checkGoodRx } from './server/goodrx'
import { calendarRoutes } from './server/calendar-routes.ts'
import { refillRoutes } from './server/refill-routes.ts'
import { createImessage, formatNumber } from './server/photon'
import { finishRequest, initCareSentry, reportError, traceCareRequest, tracePriceLookup } from './server/sentry'
import type { DoseLog, DoseSource, HaloData, ImessageStatus, Medicine, PriceCheck } from './src/types'

const DATA_DIR = fileURLToPath(new URL('./data', import.meta.url))
const DATA_FILE = path.join(DATA_DIR, 'halo.json')
const UPLOADS = path.join(DATA_DIR, 'uploads')
const TRANSCRIPTS_FILE = path.join(DATA_DIR, 'transcripts.json')
const DOSES_FILE = path.join(DATA_DIR, 'doses.json')
const PRICES_FILE = path.join(DATA_DIR, 'prices.json')
const IMESSAGE_FILE = path.join(DATA_DIR, 'imessage.json')
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json')
const GLASSES_FILE = path.join(DATA_DIR, 'glasses.json')

const readJson = <T>(file: string, fallback: T): T =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2))

const MIME: Record<string, string> = {
  '.webm': 'audio/webm', '.mp4': 'audio/mp4', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.heic': 'image/heic',
}

function readBody(req: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Dev-only stand-in for a backend: saves everything to portal/data/
type Keys = {
  groq: string
  browserUse: string
  sentry: string
  environment: string
  photon: { projectId: string; apiKey: string; agentNumber: string }
}

function jsonStore(keys: Keys): Plugin {
  const groqKey = keys.groq
  return {
    name: 'halo-json-store',
    transformIndexHtml(html) {
      const tag = `<script>window.__HALO_SENTRY_DSN__=${JSON.stringify(keys.sentry)}</script>`
      return html.replace('</head>', `${tag}</head>`)
    },
    configureServer(server) {
      initCareSentry(keys.sentry, keys.environment)
      fs.mkdirSync(UPLOADS, { recursive: true })
      // Tell open pages (care portal and patient) to reload their data
      const notify = () => server.ws.send({ type: 'custom', event: 'halo:update' })
      const upload = (name: string | null) => path.join(UPLOADS, path.basename(name ?? ''))
      // Plans from conversation to calendar: /api/plans, /api/audio, /api/glasses/state, /api/transcripts (POST) and more
      const calendar = calendarRoutes({ apiKey: groqKey, dataDir: DATA_DIR, notify, answerWindowMs: Number(process.env.HALO_ANSWER_WINDOW_MS) || undefined })
      server.httpServer?.on('close', calendar.stop)
      // Refill before it runs out: pill count -> errands agent -> family approval -> order -> pickup on the calendar
      const refills = refillRoutes({ dataDir: DATA_DIR, notify, calendar: calendar.cal, browserUseKey: keys.browserUse })
      server.httpServer?.on('close', refills.stop)
      const needKey = () => {
        if (!groqKey) throw new Error('GROQ_API_KEY is missing. Add it to portal/.env and restart the portal.')
      }

      const setPrice = (key: string, value: PriceCheck) => {
        writeJson(PRICES_FILE, { ...readJson(PRICES_FILE, {}), [key]: value })
        notify()
      }
      // Runs in the background; open pages update when it finishes
      const startPriceCheck = (key: string, med: Medicine, zip: string) => {
        if (!keys.browserUse) throw new Error('BROWSER_USE_API_KEY is missing. Add it to portal/.env and restart the portal.')
        setPrice(key, { status: 'checking', startedAt: new Date().toISOString(), zip })
        tracePriceLookup(async () => {
          try {
            const result = await checkGoodRx(keys.browserUse, med, zip)
            setPrice(key, { status: 'done', checkedAt: new Date().toISOString(), zip, ...result })
          } catch (err) {
            setPrice(key, { status: 'failed', checkedAt: new Date().toISOString(), zip, error: err instanceof Error ? err.message : String(err) })
            throw err
          } finally {
            imessage?.checkAlerts()
          }
        })
      }

      const readData = () => readJson<HaloData>(DATA_FILE, { patient: { name: '' }, people: [], prescriptions: [] })
      const readDoses = () => readJson<DoseLog[]>(DOSES_FILE, [])
      // slot is "YYYY-MM-DD HH:MM"; taken: false undoes a dose
      const setDose = (medKey: string, slot: string, taken: boolean, by?: DoseSource) => {
        const doses = readDoses().filter(d => !(d.medKey === medKey && d.slot === slot))
        if (taken) doses.push({ medKey, slot, at: new Date().toISOString(), ...(by ? { by } : {}) })
        writeJson(DOSES_FILE, doses)
        refills.check() // a dose can take the pill count down to 7 days
        notify()
      }
      const glasses = createGlasses(GLASSES_FILE, notify)

      const { projectId, apiKey, agentNumber } = keys.photon
      const imessage = projectId && apiKey && agentNumber
        ? createImessage({
          projectId, apiKey, agentNumber,
          groqKey,
          stateFile: IMESSAGE_FILE,
          messagesFile: MESSAGES_FILE,
          readData,
          saveData: data => { writeJson(DATA_FILE, data); notify() },
          readDoses,
          readPrices: () => readJson<Record<string, PriceCheck>>(PRICES_FILE, {}),
          startPriceCheck,
          setDose,
          glasses,
          refills: refills.refills,
          notify,
        })
        : null
      imessage?.start()
      server.httpServer?.once('close', () => imessage?.stop())

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        if (!url.pathname.startsWith('/api/')) return next()
        await traceCareRequest(req, url.pathname, async () => {
        try {
          if (await calendar.handle(req, res, url)) return
          if (await refills.handle(req, res, url)) return
          if (url.pathname === '/api/data' && req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE) : '{}')
          } else if (url.pathname === '/api/data' && req.method === 'PUT') {
            const data = JSON.parse((await readBody(req)).toString())
            fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
            refills.check() // a new pill count or prescription can start or cancel a refill
            notify()
            res.end('{"ok":true}')
          } else if (url.pathname === '/api/upload' && req.method === 'POST') {
            const name = path.basename(url.searchParams.get('name') ?? 'file').replace(/[^\w.-]/g, '_')
            const file = `${Date.now()}-${name}`
            fs.writeFileSync(path.join(UPLOADS, file), await readBody(req))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ file }))
          } else if (url.pathname === '/api/read-prescription' && req.method === 'POST') {
            needKey()
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(await readPrescription(upload(url.searchParams.get('file')), groqKey)))
          } else if (url.pathname === '/api/transcribe' && req.method === 'POST') {
            needKey()
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ text: await transcribe(upload(url.searchParams.get('file')), groqKey) }))
          } else if (url.pathname === '/api/transcripts' && req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(fs.existsSync(TRANSCRIPTS_FILE) ? fs.readFileSync(TRANSCRIPTS_FILE) : '[]')
          } else if (url.pathname === '/api/doses' && req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(readJson(DOSES_FILE, [])))
          } else if (url.pathname === '/api/doses' && req.method === 'POST') {
            const { medKey, slot, taken, by } = JSON.parse((await readBody(req)).toString())
            setDose(String(medKey), String(slot), taken !== false, by === 'glasses' ? 'glasses' : undefined)
            res.end('{"ok":true}')
          } else if (url.pathname === '/api/glasses' && req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(glasses.view(readData(), readDoses())))
          } else if (url.pathname === '/api/glasses/seen' && req.method === 'POST') {
            const { id } = JSON.parse((await readBody(req)).toString())
            const seen = glasses.markSeen(String(id))
            if (seen) imessage?.glassesSeen(seen)
            res.end('{"ok":true}')
          } else if (url.pathname === '/api/prices' && req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(readJson(PRICES_FILE, {})))
          } else if (url.pathname === '/api/prices' && req.method === 'DELETE') {
            const all = readJson<Record<string, unknown>>(PRICES_FILE, {})
            delete all[url.searchParams.get('key') ?? '']
            writeJson(PRICES_FILE, all)
            notify()
            res.end('{"ok":true}')
          } else if (url.pathname === '/api/prices' && req.method === 'POST') {
            const { key, med, zip } = JSON.parse((await readBody(req)).toString())
            if (!/^\d{5}$/.test(zip ?? '')) throw new Error("Add the patient's 5-digit ZIP code first.")
            startPriceCheck(key, med, zip)
            res.end('{"ok":true}')
          } else if (url.pathname === '/api/imessage' && req.method === 'GET') {
            const status: ImessageStatus = imessage?.status() ?? {
              configured: false, agentNumber: formatNumber(agentNumber), caregivers: [], messages: [], alerts: {},
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(status))
          } else if (url.pathname.startsWith('/api/files/') && req.method === 'GET') {
            const file = path.join(UPLOADS, path.basename(decodeURIComponent(url.pathname)))
            if (!fs.existsSync(file)) { res.statusCode = 404; return res.end() }
            res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
            fs.createReadStream(file).pipe(res)
          } else if (url.pathname.startsWith('/api/files/') && req.method === 'DELETE') {
            fs.rmSync(path.join(UPLOADS, path.basename(decodeURIComponent(url.pathname))), { force: true })
            res.end('{"ok":true}')
          } else {
            res.statusCode = 404
            res.end()
          }
        } catch (err) {
          res.statusCode = 500
          reportError(err)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        } finally {
          finishRequest(res.statusCode || 200)
        }
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '')
  const sentryDsn = env.SENTRY_DSN || env.VITE_SENTRY_DSN || ''
  return {
    plugins: [jsonStore({
      groq: env.GROQ_API_KEY ?? '',
      browserUse: env.BROWSER_USE_API_KEY ?? '',
      sentry: sentryDsn,
      environment: mode,
      photon: {
        projectId: env.PHOTON_PROJECT_ID ?? '',
        apiKey: env.PHOTON_API_KEY ?? '',
        agentNumber: env.PHOTON_AGENT_NUMBER ?? '',
      },
    })],
    server: { port: 5174, watch: { ignored: ['**/data/**'] }, fs: { allow: ['..'] } }, // shared/ is imported from the repo root
  }
})
