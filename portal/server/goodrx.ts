import { BrowserUse } from 'browser-use-sdk/v4'

export type PriceQuote = { pharmacy: string; price: number; priceType: string }

export type GoodRxResult = {
  url: string
  quantity: number | null
  quotes: PriceQuote[]
  note: string
}

// Cap what one lookup can spend on Browser Use Cloud
const MAX_COST_USD = 1
const TIMEOUT_MS = 8 * 60_000

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'GoodRx page the prices came from' },
    quantity: { type: ['number', 'null'], description: 'Quantity the prices are for' },
    quotes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pharmacy: { type: 'string' },
          price: { type: 'number', description: 'Price in US dollars' },
          priceType: { type: 'string', description: 'e.g. "GoodRx coupon" or "Retail"' },
        },
        required: ['pharmacy', 'price', 'priceType'],
      },
    },
    note: { type: 'string', description: 'Anything that differs from what was asked, or why no prices were found' },
  },
  required: ['url', 'quantity', 'quotes', 'note'],
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export async function checkGoodRx(
  apiKey: string,
  med: { name: string; strength: string; form: string; quantity: number | null },
  zip: string,
): Promise<GoodRxResult> {
  const quantity = med.quantity ? `quantity ${med.quantity}` : 'the most common quantity'
  const task = `Look up GoodRx prices for a prescription medicine.
1. Open https://www.goodrx.com/${slug(med.name)}
2. Set the location to ZIP code ${zip}.
3. Choose ${med.form || 'the usual form'}, ${med.strength || 'the usual strength'}, ${quantity}. If that exact option isn't offered, pick the closest one and say so in "note".
4. Read the list of pharmacy prices. Use the free GoodRx coupon price for each pharmacy. Ignore prices that need a paid membership (GoodRx Gold, Companion or similar); if a pharmacy only shows a membership price, look for its price without membership, and skip it if there isn't one.
Return up to 5 of the cheapest pharmacies by free coupon price, cheapest first. Report only prices you actually see on the page.
Do not sign in, create an account, or type any personal details. Close any pop-ups asking for them.
If GoodRx doesn't list this medicine, return an empty "quotes" list and explain why in "note".`

  const client = new BrowserUse({ apiKey })
  const created = await client.runs.create({ task, outputSchema: OUTPUT_SCHEMA, maxCostUsd: MAX_COST_USD })
  const run = await client.runs.waitForCompletion(created.id, { timeout: TIMEOUT_MS, interval: 3000 })
  if (run.status !== 'completed') throw new Error(run.error ?? `Browser Use run ${run.status}`)

  const out = (run.output ?? {}) as Partial<GoodRxResult>
  const quotes = (Array.isArray(out.quotes) ? out.quotes : [])
    .filter(q => q && typeof q.price === 'number' && Number.isFinite(q.price) && q.pharmacy)
    .map(q => ({ pharmacy: String(q.pharmacy), price: q.price, priceType: String(q.priceType ?? '') }))
    .sort((a, b) => a.price - b.price)

  return {
    url: typeof out.url === 'string' ? out.url : `https://www.goodrx.com/${slug(med.name)}`,
    quantity: typeof out.quantity === 'number' ? out.quantity : med.quantity,
    quotes,
    note: typeof out.note === 'string' ? out.note : (run.result ?? ''),
  }
}
