// Types for refills (Flow E): pill count -> quote -> family approval -> order -> pickup on the calendar

export type RefillStatus =
  | 'preparing' // the errands agent is on the pharmacy website
  | 'awaiting_approval' // a quote is ready; nothing has been paid for
  | 'ordering' // the family approved; the order is being placed
  | 'ordered' // the pharmacy confirmed the order
  | 'received' // the family has the medicine and the pill count was updated
  | 'rejected' // the family said not now; no automatic retry
  | 'needs_review' // something failed or is uncertain; a person has to look
  | 'cancelled' // the pill count was updated, so the refill isn't due any more

export type Quote = {
  pharmacy: string
  cartId: string
  priceCents: number
  quantity: number
  expiresAt: string // ISO
  url?: string // the cart page on the pharmacy website
}

export type Order = {
  id: string
  placedAt: string
  readyAt: string // pickup or delivery time, ISO
  method: 'pickup' | 'delivery'
  priceCents: number
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
  order?: Order
  calendarPlanId?: string
  error?: string
}

export type ActivityEntry = { at: string; refillId?: string; text: string }

export type RefillState = {
  settings: { spendingLimitCents: number }
  refills: Refill[]
  activity: ActivityEntry[]
  driver: string // which errands driver is in use, for the page to say
}

export const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`
