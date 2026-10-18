import { defineConfig, loadEnv, type Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPrescription, transcribe } from './server/ai'
import { checkGoodRx } from './server/goodrx'

const DATA_DIR = fileURLToPath(new URL('./data', import.meta.url))
const DATA_FILE = path.join(DATA_DIR, 'halo.json')
const UPLOADS = path.join(DATA_DIR, 'uploads')
const TRANSCRIPTS_FILE = path.join(DATA_DIR, 'transcripts.json')
const MAX_TRANSCRIPT_LINES = 500
const DOSES_FILE = path.join(DATA_DIR, 'doses.json')
const PRICES_FILE = path.join(DATA_DIR, 'prices.json')

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
function jsonStore(keys: { groq: string; browserUse: string }): Plugin {
  const groqKey = keys.groq
  return {
    name: 'halo-json-store',
    configureServer(server) {
      fs.mkdirSync(UPLOADS, { recursive: true })
      // Tell open pages (care portal and patient) to reload their data
      const notify = () => server.ws.send({ type: 'custom', event: 'halo:update' })
      const upload = (name: string | null) => path.join(UPLOADS, path.basename(name ?? ''))
      const needKey = () => {
        if (!groqKey) throw new Error('GROQ_API_KEY is missing. Add it to portal/.env and restart the portal.')
      }
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        try {
          if (url.pathname === '/api/data' && req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE) : '{}')
          } else if (url.pathname === '/api/data' && req.method === 'PUT') {
            const data = JSON.parse((await readBody(req)).toString())
            fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
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
          } else if (url.pathname === '/api/transcripts' && req.method === 'POST') {
            const { text } = JSON.parse((await readBody(req)).toString())
            const lines = readJson<unknown[]>(TRANSCRIPTS_FILE, [])
            lines.push({ text: String(text), at: new Date().toISOString() })
            writeJson(TRANSCRIPTS_FILE, lines.slice(-MAX_TRANSCRIPT_LINES))
            notify()
            res.end('{"ok":true}')
          } else if (url.pathname === '/api/doses' && req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(readJson(DOSES_FILE, [])))
          } else if (url.pathname === '/api/doses' && req.method === 'POST') {
            // { medKey, slot, taken }: slot is "YYYY-MM-DD HH:MM"; taken: false undoes a tap
            const { medKey, slot, taken } = JSON.parse((await readBody(req)).toString())
            const doses = readJson<{ medKey: string; slot: string; at: string }[]>(DOSES_FILE, [])
              .filter(d => !(d.medKey === medKey && d.slot === slot))
            if (taken !== false) doses.push({ medKey: String(medKey), slot: String(slot), at: new Date().toISOString() })
            writeJson(DOSES_FILE, doses)
            notify()
            res.end('{"ok":true}')
          } else if (url.pathname === '/api/prices' && req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(readJson(PRICES_FILE, {})))
          } else if (url.pathname === '/api/prices' && req.method === 'POST') {
            if (!keys.browserUse) throw new Error('BROWSER_USE_API_KEY is missing. Add it to portal/.env and restart the portal.')
            const { key, med, zip } = JSON.parse((await readBody(req)).toString())
            if (!/^\d{5}$/.test(zip ?? '')) throw new Error("Add the patient's 5-digit ZIP code first.")
            const setPrice = (value: unknown) => {
              writeJson(PRICES_FILE, { ...readJson(PRICES_FILE, {}), [key]: value })
              notify()
            }
            const startedAt = new Date().toISOString()
            setPrice({ status: 'checking', startedAt, zip })
            // Runs in the background; open pages update when it finishes
            checkGoodRx(keys.browserUse, med, zip)
              .then(result => setPrice({ status: 'done', checkedAt: new Date().toISOString(), zip, ...result }))
              .catch(err => setPrice({ status: 'failed', checkedAt: new Date().toISOString(), zip, error: err instanceof Error ? err.message : String(err) }))
            res.end('{"ok":true}')
          } else if (url.pathname.startsWith('/api/files/') && req.method === 'GET') {
            const file = path.join(UPLOADS, path.basename(decodeURIComponent(url.pathname)))
            if (!fs.existsSync(file)) { res.statusCode = 404; return res.end() }
            res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
            fs.createReadStream(file).pipe(res)
          } else if (url.pathname.startsWith('/api/files/') && req.method === 'DELETE') {
            fs.rmSync(path.join(UPLOADS, path.basename(decodeURIComponent(url.pathname))), { force: true })
            res.end('{"ok":true}')
          } else {
            next()
          }
        } catch (err) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '')
  return {
    plugins: [jsonStore({ groq: env.GROQ_API_KEY ?? '', browserUse: env.BROWSER_USE_API_KEY ?? '' })],
    server: { port: 5174, watch: { ignored: ['**/data/**'] } },
  }
})
