// Types for refills (Flow E): pill count -> GoodRx prices -> family approval -> pickup reminder on the calendar.
// HALO never places an order. It finds the price, and the family picks the medicine up.

export type RefillStatus =
  | 'preparing' // the errands agent is looking up GoodRx prices
  | 'awaiting_approval' // prices are ready and shown; nothing has been bought
  | 'approved' // the family approved a price; a pickup reminder is on the calendar
  | 'received' // the family has the medicine and the pill count was updated
  | 'rejected' // the family said not now; no automatic retry
  | 'needs_review' // the lookup failed; a person has to look
  | 'cancelled' // the pill count was updated, so the refill isn't due any more

export type PriceOption = { pharmacy: string; priceCents: number; priceType: string }

export type Quote = {
  pharmacy: string // the cheapest
  priceCents: number
  priceType?: string // e.g. "GoodRx coupon"
  quantity: number // the price is for this many tablets
  prices: PriceOption[] // the cheapest few, cheapest first, for the family to see
  url?: string // the GoodRx page the prices came from
  expiresAt: string // ISO
}

export type Refill = {
  id: string
  medKey: string // "<prescription id>:<index>"
  medicine: string // "Donepezil 5 mg"
  quantity: number
  status: RefillStatus
  createdAt: string
  quote?: Quote
  approvedBy?: string
  approvedAt?: string
  pickupAt?: string // when the family plans to pick it up (on the calendar)
  calendarPlanId?: string
  error?: string
}

export type ActivityEntry = { at: string; refillId?: string; text: string }

export type RefillState = {
  settings: { spendingLimitCents: number }
  refills: Refill[]
  activity: ActivityEntry[]
  driver: string // where prices come from, for the page to say
}

export const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`
