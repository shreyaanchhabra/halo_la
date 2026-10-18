import { BrowserUse } from 'browser-use-sdk/v4'
import type { Pharmacy } from './pharmacy.ts'
import type { Quote } from '../../shared/refill-types.ts'

// The errands agent. It shops on a pharmacy website in two separate steps, and the family's approval sits
// between them:
//   prepare  search, add to cart, open the review page, STOP before paying. Returns the quote.
//   place    only after approval: press "Place order". Returns the order the pharmacy confirmed.

export type Errand = { medicine: string; quantity: number } // medicine: "Donepezil 5 mg"
export type Placed = { orderId: string; readyAt: string; method: 'pickup' | 'delivery'; priceCents: number }

export interface PharmacyDriver {
  name: string
  prepare(errand: Errand): Promise<Omit<Quote, 'expiresAt'>>
  place(cartId: string): Promise<Placed>
}

// Drives the built-in test pharmacy directly, so the flow works with no keys and no browser.
export function localDriver(pharmacy: Pharmacy): PharmacyDriver {
  return {
    name: 'Test pharmacy (built in)',
    async prepare({ medicine, quantity }) {
      const cart = pharmacy.addToCart(medicine, quantity)
      return { pharmacy: pharmacy.name, cartId: cart.id, priceCents: cart.priceCents, quantity: cart.quantity }
    },
    async place(cartId) {
      const o = pharmacy.placeOrder(cartId)
      return { orderId: o.id, readyAt: o.readyAt, method: o.method, priceCents: o.priceCents }
    },
  }
}

const MAX_COST_USD = 1
const TIMEOUT_MS = 8 * 60_000

const PREPARE_SCHEMA = {
  type: 'object',
  properties: {
    cartUrl: { type: 'string', description: 'URL of the cart review page' },
    priceUsd: { type: 'number', description: 'The total shown on the review page, in US dollars' },
    quantity: { type: 'number', description: 'Number of tablets in the cart' },
  },
  required: ['cartUrl', 'priceUsd', 'quantity'],
}

const PLACE_SCHEMA = {
  type: 'object',
  properties: {
    orderId: { type: 'string', description: 'The order number shown after checkout' },
    readyAtIso: { type: 'string', description: 'When the order is ready for pickup, as an ISO 8601 date and time' },
    priceUsd: { type: 'number' },
  },
  required: ['orderId', 'readyAtIso', 'priceUsd'],
}

// Drives a real browser with Browser Use Cloud. The cloud browser can only reach a PUBLIC address, so
// siteUrl must be where this portal's /test-pharmacy pages are reachable from the internet.
export function browserUseDriver(o: { apiKey: string; siteUrl: string; pharmacy: Pharmacy }): PharmacyDriver {
  const base = o.siteUrl.replace(/\/$/, '')
  const client = new BrowserUse({ apiKey: o.apiKey })
  const run = async (task: string, outputSchema: Record<string, unknown>) => {
    const created = await client.runs.create({ task, outputSchema, maxCostUsd: MAX_COST_USD })
    const done = await client.runs.waitForCompletion(created.id, { timeout: TIMEOUT_MS, interval: 3000 })
    if (done.status !== 'completed') throw new Error(done.error ?? `Browser Use run ${done.status}`)
    return (done.output ?? {}) as Record<string, unknown>
  }
  return {
    name: 'Browser Use',
    async prepare({ medicine, quantity }) {
      const out = await run(`Prepare a pharmacy order, and stop before paying.
1. Open ${base}/test-pharmacy
2. Search for "${medicine}" with ${quantity} tablets.
3. Click "Add to cart". You will land on a page titled "Review your order".
4. Do NOT click "Place order". Do not sign in or enter any personal details.
Return the URL of the review page, the total shown, and the number of tablets.`, PREPARE_SCHEMA)
      const id = /\/test-pharmacy\/cart\/([\w-]+)/.exec(String(out.cartUrl))?.[1]
      const cart = id && o.pharmacy.get(id)
      // Trust what the pharmacy's own records say about the cart, not only what the agent reported
      if (!cart) throw new Error('Browser Use finished, but no cart was found at the pharmacy')
      if (Math.abs(cart.priceCents - Math.round(Number(out.priceUsd) * 100)) > 1) throw new Error('The price Browser Use read does not match the cart')
      return { pharmacy: o.pharmacy.name, cartId: cart.id, priceCents: cart.priceCents, quantity: cart.quantity, url: `${base}/test-pharmacy/cart/${cart.id}` }
    },
    async place(cartId) {
      await run(`The family has approved this order. Open ${base}/test-pharmacy/cart/${cartId} and click "Place order" once. Do not click it again. Return the order number and the pickup time shown.`, PLACE_SCHEMA)
      const order = o.pharmacy.get(cartId)?.order
      if (!order) throw new Error('Browser Use finished, but the pharmacy has no order for this cart')
      return { orderId: order.id, readyAt: order.readyAt, method: order.method, priceCents: order.priceCents }
    },
  }
}
