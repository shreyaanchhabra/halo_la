import { checkGoodRx, type GoodRxResult } from './goodrx.ts'
import type { PriceOption, Quote } from '../../shared/refill-types.ts'

// The errands agent finds where to get a refill and what it costs, and stops. HALO never buys anything:
// GoodRx is a price and coupon site, so the family approves a price and picks the medicine up themselves.
//
// It uses Browser Use: an AI agent in a real browser opens GoodRx, sets the patient's ZIP code, and reads
// the cheapest coupon prices at nearby pharmacies.

export type Errand = {
  medicine: string // "Donepezil 5 mg"
  quantity: number
  med?: { name: string; strength: string; form: string }
  zip?: string
}

export type Prepared = Omit<Quote, 'expiresAt'>

export interface PriceFinder {
  name: string
  quoteTtlMs: number // how long a price stays good
  prepare(errand: Errand): Promise<Prepared>
}

const SIX_HOURS = 6 * 60 * 60_000 // GoodRx prices change daily, not by the minute
const SHOWN = 5 // how many of the cheapest prices the family sees

export type GoodRxLookup = (apiKey: string, med: { name: string; strength: string; form: string; quantity: number | null }, zip: string) => Promise<GoodRxResult>

export function goodrxFinder(o: { apiKey: string; lookup?: GoodRxLookup }): PriceFinder {
  const lookup = o.lookup ?? checkGoodRx
  return {
    name: 'GoodRx (Browser Use)',
    quoteTtlMs: SIX_HOURS,
    async prepare({ medicine, quantity, med, zip }) {
      if (!zip) throw new Error("Add the patient's ZIP code on the setup page so HALO can look up prices near them.")
      const found = await lookup(o.apiKey, { name: med?.name ?? medicine, strength: med?.strength ?? '', form: med?.form ?? '', quantity }, zip)
      const prices: PriceOption[] = found.quotes
        .filter(q => Number.isFinite(q.price) && q.price > 0 && q.pharmacy)
        .map(q => ({ pharmacy: q.pharmacy, priceCents: Math.round(q.price * 100), priceType: q.priceType }))
        .sort((a, b) => a.priceCents - b.priceCents)
        .slice(0, SHOWN)
      if (!prices.length) throw new Error(found.note ? `GoodRx had no price for ${medicine}: ${found.note}` : `GoodRx had no price for ${medicine}.`)
      const best = prices[0]
      return { pharmacy: best.pharmacy, priceCents: best.priceCents, priceType: best.priceType, quantity: found.quantity ?? quantity, prices, url: found.url }
    },
  }
}

// With no Browser Use key there is nothing to look prices up with. Say so plainly instead of showing made-up prices.
export const noKeyFinder: PriceFinder = {
  name: 'GoodRx (needs a Browser Use key)',
  quoteTtlMs: SIX_HOURS,
  async prepare() { throw new Error('BROWSER_USE_API_KEY is missing, so HALO cannot look up GoodRx prices. Add it to portal/.env and restart the portal.') },
}
