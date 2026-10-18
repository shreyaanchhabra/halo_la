import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'
import { createRefills, RefillError } from './refills.ts'
import { createPharmacy } from './pharmacy.ts'
import { browserUseDriver, localDriver } from './errands.ts'
import type { Calendar } from './calendar.ts'
import type { DoseLog, HaloData } from '../src/types'

// Refill endpoints and the test pharmacy website, for the portal's dev server (see vite.config.ts).

export type RefillRoutesOptions = {
  dataDir: string
  notify?: () => void
  calendar: Pick<Calendar, 'addManual'>
  browserUseKey?: string // with siteUrl, the errands agent drives a real browser instead of the built-in shortcut
  siteUrl?: string // where this portal's /test-pharmacy pages are reachable from the internet
  checkEveryMs?: number
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => { size += c.length; if (size > 64_000) { reject(new Error('Request too large')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

export function refillRoutes(o: RefillRoutesOptions) {
  const haloFile = path.join(o.dataDir, 'halo.json')
  const dosesFile = path.join(o.dataDir, 'doses.json')
  const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
  const readData = (): HaloData => ({ patient: { name: '' }, people: [], prescriptions: [], ...readJson<Partial<HaloData>>(haloFile, {}) })

  const pharmacy = createPharmacy({ dataDir: o.dataDir })
  const driver = o.browserUseKey && o.siteUrl ? browserUseDriver({ apiKey: o.browserUseKey, siteUrl: o.siteUrl, pharmacy }) : localDriver(pharmacy)

  const refills = createRefills({
    dataDir: o.dataDir,
    driver,
    pharmacy,
    notify: o.notify,
    readData,
    readDoses: () => readJson<DoseLog[]>(dosesFile, []),
    // A new pill count: written the way the care portal writes it, so the page picks it up
    setStock(medKey, count, at) {
      const data = readData()
      data.stock = { ...data.stock, [medKey]: { count, at } }
      fs.writeFileSync(`${haloFile}.tmp`, JSON.stringify(data, null, 2))
      fs.renameSync(`${haloFile}.tmp`, haloFile)
    },
    addToCalendar: event => o.calendar.addManual(event),
  })

  // Pill counts change whenever a dose is logged or a count is typed in, and slowly with the clock
  const timer = setInterval(() => refills.check(), o.checkEveryMs ?? 60_000)
  queueMicrotask(() => refills.check())

  // Returns true when the request was one of ours
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (await pharmacy.handle(req, res, url)) return true
    if (!url.pathname.startsWith('/api/refills')) return false
    const route = `${req.method} ${url.pathname}`
    const body = async () => JSON.parse((await readBody(req)).toString() || '{}')
    try {
      if (route === 'GET /api/refills') { refills.check(); json(res, refills.state()); return true }
      if (route === 'PUT /api/refills/settings') { json(res, refills.setLimit((await body()).spendingLimitCents)); return true }
      if (route === 'POST /api/refills/check') { refills.check(); json(res, refills.state()); return true }
      const m = /^\/api\/refills\/([\w-]+)\/(approve|reject|requote|received)$/.exec(url.pathname)
      if (m && req.method === 'POST') {
        const [, id, op] = m
        json(res, op === 'approve' ? refills.approve(id, await body()) : refills[op as 'reject' | 'requote' | 'received'](id))
        return true
      }
      json(res, { error: 'Not found' }, 404)
    } catch (err) {
      if (err instanceof RefillError) json(res, { error: err.message }, err.status)
      else json(res, { error: err instanceof Error ? err.message : String(err) }, 500)
    }
    return true
  }

  return { refills, pharmacy, handle, check: () => refills.check(), stop: () => clearInterval(timer) }
}
