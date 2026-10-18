import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'

// A test pharmacy website. It is the place the errands agent shops: search, add to cart, review, and a
// "Place order" button that does nothing until the family has approved that exact cart. No real medicine
// is ordered and no money moves. Synthetic prices only.

export type Cart = {
  id: string
  medicine: string // "Donepezil 5 mg"
  quantity: number
  priceCents: number
  status: 'review' | 'approved' | 'ordered'
  approvedBy?: string
  approvedPriceCents?: number
  order?: { id: string; placedAt: string; readyAt: string; method: 'pickup'; priceCents: number }
}

const CATALOG = [
  { name: 'Donepezil', strength: '5 mg', quantity: 30, priceCents: 1240 },
  { name: 'Memantine', strength: '5 mg', quantity: 60, priceCents: 2860 },
]
const FLAT_CENTS_PER_TABLET = 45 // any other medicine is priced at a flat demo rate

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const usd = (c: number) => `$${(c / 100).toFixed(2)}`
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function priceFor(name: string, strength: string, quantity: number): number {
  const hit = CATALOG.find(c => norm(c.name) === norm(name) && (!strength || norm(c.strength) === norm(strength)))
  if (hit && quantity === hit.quantity) return hit.priceCents
  if (hit) return Math.round((hit.priceCents / hit.quantity) * quantity)
  return Math.max(500, quantity * FLAT_CENTS_PER_TABLET)
}

export type PharmacyOptions = { dataDir: string; now?: () => Date }

export function createPharmacy(o: PharmacyOptions) {
  const memory = o.dataDir === ':memory:'
  const file = path.join(o.dataDir, 'pharmacy.json')
  const now = o.now ?? (() => new Date())
  let carts: Cart[] = []
  try { if (!memory) carts = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first run */ }
  const save = () => {
    if (memory) return
    fs.mkdirSync(o.dataDir, { recursive: true })
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(carts, null, 2))
    fs.renameSync(`${file}.tmp`, file)
  }

  const get = (id: string) => carts.find(c => c.id === id)

  // Put a medicine in a cart and stop at the review page
  function addToCart(medicine: string, quantity: number): Cart {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw new Error('Quantity must be a whole number from 1 to 1000')
    const m = /^(.*?)(?:\s+(\d[\d.,]*\s*(?:mg|mcg|g|ml|iu|units?)))?$/i.exec(medicine.trim())
    const cart: Cart = { id: crypto.randomUUID(), medicine: medicine.trim(), quantity, priceCents: priceFor(m?.[1] ?? medicine, m?.[2] ?? '', quantity), status: 'review' }
    carts.push(cart)
    save()
    return cart
  }

  // The family approved this cart at this exact price
  function approve(id: string, by: string, priceCents: number): Cart {
    const c = get(id)
    if (!c) throw new Error('Cart not found')
    if (c.status === 'ordered') return c
    if (c.priceCents !== priceCents) throw new Error('The price on the cart changed. Review it again')
    c.status = 'approved'; c.approvedBy = by; c.approvedPriceCents = priceCents
    save()
    return c
  }

  // Refuses unless the cart was approved at its current price. Safe to call twice.
  function placeOrder(id: string): NonNullable<Cart['order']> {
    const c = get(id)
    if (!c) throw new Error('Cart not found')
    if (c.order) return c.order
    if (c.status !== 'approved' || c.approvedPriceCents !== c.priceCents) throw new Error('This cart has not been approved by the family')
    const placedAt = now()
    const readyAt = new Date(placedAt)
    readyAt.setDate(readyAt.getDate() + 1)
    readyAt.setHours(10, 0, 0, 0) // ready for pickup tomorrow at 10
    c.order = { id: `TEST-${c.id.slice(0, 8).toUpperCase()}`, placedAt: placedAt.toISOString(), readyAt: readyAt.toISOString(), method: 'pickup', priceCents: c.priceCents }
    c.status = 'ordered'
    save()
    return c.order
  }

  // ---- the website ----
  const page = (body: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HALO Test Pharmacy</title>
<body style="font:18px/1.5 system-ui;max-width:620px;margin:48px auto;padding:0 20px;color:#18242e">
<h1 style="margin:0">HALO Test Pharmacy</h1><p style="color:#586874">Demo only. No real medicine is ordered and no money moves.</p>${body}</body></html>`
  const redirect = (res: http.ServerResponse, to: string) => { res.writeHead(303, { Location: to }); res.end() }
  const html = (res: http.ServerResponse, body: string, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page(body)) }

  function cartPage(c: Cart): string {
    const locked = c.status === 'review'
    return `<h2>Review your order</h2>
<p><b>${esc(c.medicine)}</b> · ${c.quantity} tablets</p>
<p id="total">Total: <b>${usd(c.priceCents)}</b> · pickup tomorrow at 10:00 AM</p>
<p id="state">${c.order ? `Order ${esc(c.order.id)} confirmed. Ready ${esc(new Date(c.order.readyAt).toLocaleString())}.` : locked ? 'Waiting for the family to approve this order. Checkout is locked until they do.' : `Approved by ${esc(c.approvedBy ?? 'the family')} at ${usd(c.approvedPriceCents ?? c.priceCents)}.`}</p>
<form method="POST" action="/test-pharmacy/cart/${c.id}/order"><button id="place-order" ${locked || c.order ? 'disabled' : ''} style="font:inherit;padding:10px 18px">Place order</button></form>`
  }

  // Returns true when the request was for the pharmacy website
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/test-pharmacy')) return false
    const route = `${req.method} ${url.pathname}`
    try {
      if (route === 'GET /test-pharmacy' || route === 'GET /test-pharmacy/') {
        html(res, `<form method="GET" action="/test-pharmacy/search"><label>Medicine <input name="name" required placeholder="Donepezil 5 mg" style="font:inherit;padding:8px"></label>
<label>Tablets <input name="quantity" type="number" min="1" value="30" style="font:inherit;padding:8px;width:6em"></label> <button style="font:inherit;padding:8px 14px">Search</button></form>`)
      } else if (route === 'GET /test-pharmacy/search') {
        const name = url.searchParams.get('name') ?? ''
        const quantity = Number(url.searchParams.get('quantity') ?? 30)
        const m = /^(.*?)(?:\s+(\d[\d.,]*\s*(?:mg|mcg|g|ml|iu|units?)))?$/i.exec(name.trim())
        html(res, `<h2>Results</h2><p><b>${esc(name)}</b> · ${quantity} tablets · ${usd(priceFor(m?.[1] ?? name, m?.[2] ?? '', quantity))}</p>
<form method="POST" action="/test-pharmacy/cart"><input type="hidden" name="medicine" value="${esc(name)}"><input type="hidden" name="quantity" value="${quantity}"><button style="font:inherit;padding:10px 18px">Add to cart</button></form>`)
      } else if (route === 'POST /test-pharmacy/cart') {
        const form = new URLSearchParams(await readForm(req))
        redirect(res, `/test-pharmacy/cart/${addToCart(form.get('medicine') ?? '', Number(form.get('quantity'))).id}`)
      } else {
        const m = /^\/test-pharmacy\/cart\/([\w-]+)(\/order)?$/.exec(url.pathname)
        const c = m && get(m[1])
        if (!m || !c) html(res, '<p>Not found.</p>', 404)
        else if (req.method === 'GET' && !m[2]) html(res, cartPage(c))
        else if (req.method === 'POST' && m[2]) {
          try { placeOrder(c.id); redirect(res, `/test-pharmacy/cart/${c.id}`) } catch (e) { html(res, `<p>${esc((e as Error).message)}</p><p><a href="/test-pharmacy/cart/${c.id}">Back to the cart</a></p>`, 403) }
        } else html(res, '<p>Not found.</p>', 404)
      }
    } catch (e) { html(res, `<p>${esc((e as Error).message)}</p>`, 400) }
    return true
  }

  return { addToCart, approve, placeOrder, get, handle, carts: () => carts, name: 'Test Pharmacy' }
}

async function readForm(req: http.IncomingMessage): Promise<string> {
  let raw = ''
  for await (const chunk of req) { raw += chunk.toString(); if (raw.length > 2000) throw new Error('Form too large') }
  return raw
}

export type Pharmacy = ReturnType<typeof createPharmacy>
