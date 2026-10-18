import { medKey } from './schedule'
import type { DoseLog, HaloData, Medicine, Prescription } from './types'

export const REFILL_DAYS = 7

export type MedEntry = { key: string; rx: Prescription; med: Medicine }

export function allMedicines(data: HaloData): MedEntry[] {
  return data.prescriptions.flatMap(rx =>
    (rx.reading?.medicines ?? []).map((med, i) => ({ key: medKey(rx.id, i), rx, med })))
}

// Starts from the family's last count, or the prescribed quantity, minus doses taken since
export function pillsLeft(entry: MedEntry, data: HaloData, doses: DoseLog[]): number | null {
  const stock = data.stock?.[entry.key]
  const start = stock ? stock.count : entry.med.quantity
  if (start == null) return null
  const since = stock?.at ?? ''
  const taken = doses.filter(d => d.medKey === entry.key && d.at > since).length
  return Math.max(0, start - taken)
}

export function daysLeft(entry: MedEntry, data: HaloData, doses: DoseLog[]): number | null {
  const left = pillsLeft(entry, data, doses)
  if (left == null || !entry.med.times.length) return null
  return Math.floor(left / entry.med.times.length)
}

export function refillDue(entry: MedEntry, data: HaloData, doses: DoseLog[]): boolean {
  const days = daysLeft(entry, data, doses)
  return days != null && days <= REFILL_DAYS
}
