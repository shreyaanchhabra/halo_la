export type Medication = {
  id: string
  name: string
  prescriptionId: string
  doctor: string
  tabletsPerDay: number
  tabletsRemaining: number
  refillQuantity: number
  sku: string
  confirmedAt: string
}

export type RefillStatus = 'preparing' | 'awaiting_approval' | 'ordering' | 'ordered' | 'received' | 'rejected' | 'needs_review'
export type Refill = {
  id: string
  medicationId: string
  medicationName: string
  status: RefillStatus
  createdAt: string
  quantity: number
  totalCents?: number
  quoteExpiresAt?: string
  approvedBy?: string
  approvedAt?: string
  orderId?: string
  pickupAt?: string
  calendarPlanId?: string
  error?: string
}

export type RefillData = {
  settings: { spendingLimitCents: number }
  medications: Medication[]
  refills: Refill[]
  doses: { eventId: string; medicationId: string; tablets: number; at: string }[]
  activity: { at: string; refillId?: string; text: string }[]
}

export const TEST_CATALOG = [
  { sku: 'donepezil-5mg-30', name: 'Donepezil 5 mg', quantity: 30, totalCents: 1240 },
  { sku: 'memantine-5mg-60', name: 'Memantine 5 mg', quantity: 60, totalCents: 2860 },
] as const
