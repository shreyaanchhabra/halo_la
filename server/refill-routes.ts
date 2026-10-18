import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RefillError, RefillService, emptyRefills } from './refills.ts'
import { TEST_CATALOG } from '../shared/refills.ts'
import { db, save } from './store.ts'

const file = process.env.HALO_REFILLS_FILE ?? fileURLToPath(new URL('./data/refills.json', import.meta.url))
const data = file !== ':memory:' && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : emptyRefills()
const service = new RefillService(data, () => {
  if (file === ':memory:') return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2))
  fs.renameSync(`${file}.tmp`, file)
})
const browserMode = process.env.HALO_REFILL_DRIVER === 'browser-use'
const busy = new Set<string>()
const run = promisify(execFile)
const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

// Restart during checkout is ambiguous. A person must review it rather than trigger another order.
for (const r of service.data.refills) if (r.status === 'ordering' && !r.orderId) service.fail(r.id, 'Server restarted during checkout. Review the test pharmacy before taking further action.')

function syncCalendar() {
  for (const r of service.data.refills) {
    if (!r.orderId || !r.pickupAt) continue
    const id = `refill-${r.id}`
    if (!db.plans.some(p => p.id === id)) {
      db.plans.push({ id, activity: `Pick up ${r.medicationName} (test pharmacy)`, who: [], start: r.pickupAt,
        allDay: false, status: 'confirmed', confirmedBy: 'family', createdAt: r.approvedAt!, resolvedAt: r.approvedAt! })
      save()
    }
    if (r.calendarPlanId !== id) { r.calendarPlanId = id; service.persist() }
  }
}

// The default adapter is deterministic. Browser Use clicks the same local test website.
async function drive(id: string, stage: 'prepare' | 'place') {
  const job = `${id}:${stage}`
  if (busy.has(job)) return
  busy.add(job)
  try {
    if (browserMode) {
      await run(process.env.HALO_BROWSER_PYTHON ?? 'python3', [fileURLToPath(new URL('./refill_browser.py', import.meta.url)), id, stage], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 })
      const r = service.get(id)
      if (stage === 'prepare' ? !['awaiting_approval', 'ordering', 'ordered', 'received', 'rejected'].includes(r.status) : !r.orderId) throw new Error('Browser finished without a confirmed pharmacy result')
    } else if (stage === 'prepare') service.prepare(id)
    else service.place(id)
    syncCalendar()
  } catch {
    // A persisted receipt wins over an ambiguous browser failure; never automatically reorder.
    service.fail(id, 'Test pharmacy automation did not complete. Review the pharmacy and activity log.')
    syncCalendar()
  } finally { busy.delete(job) }
}

function launchPrepared() {
  for (const r of service.data.refills) if (r.status === 'preparing') void drive(r.id, 'prepare')
}

function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function pharmacy(res: http.ServerResponse, id: string) {
  const r = service.get(id)
  const button = r.status === 'preparing' ? '<button name="action" value="prepare">Prepare refill quote</button>'
    : r.status === 'ordering' ? '<button name="action" value="place">Place approved test order</button>' : ''
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HALO Test Pharmacy</title>
    <body style="font:18px system-ui;max-width:600px;margin:60px auto;padding:20px"><h1>HALO Test Pharmacy</h1><p>Demo only. No real payment or medicine is involved.</p>
    <h2>${escape(r.medicationName)}</h2><p>${r.quantity} tablets · ${escape(r.status)}</p>
    <p>Total: ${r.totalCents === undefined ? 'Prepare a quote' : `$${(r.totalCents / 100).toFixed(2)} USD`}</p>
    <p>${r.orderId ? `Order: ${escape(r.orderId)}. Pickup: ${escape(r.pickupAt!)}` : 'Checkout is locked until the family approves this exact price.'}</p>
    <form method="POST" action="/test-pharmacy/refills/${r.id}">${button}</form></body></html>`)
}

export async function handleRefillRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, readJson: (req: http.IncomingMessage) => Promise<any>): Promise<boolean> {
  if (!url.pathname.startsWith('/api/refills') && !url.pathname.startsWith('/test-pharmacy/')) return false
  try {
    const p = /^\/test-pharmacy\/refills\/([\w-]+)$/.exec(url.pathname)
    if (p) {
      if (req.method === 'POST') {
        let raw = ''
        for await (const chunk of req) { raw += chunk.toString(); if (raw.length > 1000) throw new RefillError('Form too large') }
        const action = new URLSearchParams(raw).get('action')
        if (action === 'prepare') service.prepare(p[1])
        else if (action === 'place') { service.place(p[1]); syncCalendar() }
        else throw new RefillError('Unknown pharmacy action')
        res.writeHead(303, { Location: `/test-pharmacy/refills/${p[1]}` }); res.end()
      } else if (req.method === 'GET') pharmacy(res, p[1])
      else json(res, { error: 'Method not allowed' }, 405)
      return true
    }
    const route = `${req.method} ${url.pathname}`
    if (route === 'GET /api/refills') {
      syncCalendar()
      json(res, { ...service.data, catalog: TEST_CATALOG, driver: browserMode ? 'Browser Use · test pharmacy' : 'Local test pharmacy adapter', demo: true })
    } else if (route === 'PUT /api/refills/settings') {
      service.setLimit((await readJson(req)).spendingLimitCents); json(res, service.data.settings)
    } else if (route === 'POST /api/refills/medications') {
      const m = service.addMedication(await readJson(req)); launchPrepared(); json(res, m, 201)
    } else if (route === 'POST /api/refills/check') {
      service.check(); launchPrepared(); json(res, service.data.refills)
    } else {
      const dose = /^\/api\/refills\/medications\/([\w-]+)\/doses$/.exec(url.pathname)
      const action = /^\/api\/refills\/([\w-]+)\/(approve|reject|requote|received)$/.exec(url.pathname)
      if (dose && req.method === 'POST') {
        const m = service.dose(dose[1], await readJson(req)); launchPrepared(); json(res, m)
      } else if (action && req.method === 'POST') {
        const [, id, op] = action
        if (op === 'approve') { service.approve(id, await readJson(req)); void drive(id, 'place') }
        else if (op === 'reject') service.reject(id)
        else if (op === 'requote') { service.retry(id); launchPrepared() }
        else service.receive(id)
        syncCalendar(); json(res, service.get(id))
      } else json(res, { error: 'Refill route not found' }, 404)
    }
  } catch (err) {
    json(res, { error: err instanceof RefillError ? err.message : 'Refill request failed' }, err instanceof RefillError ? err.status : 500)
  }
  return true
}
