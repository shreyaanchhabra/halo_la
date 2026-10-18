import { medKey } from './schedule.ts'
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

// How much of a medicine is left, in the words both pages use
export type Supply = { left: number; days: number | null; low: boolean }

export function supply(entry: MedEntry, data: HaloData, doses: DoseLog[]): Supply | null {
  const left = pillsLeft(entry, data, doses)
  if (left == null) return null
  return { left, days: daysLeft(entry, data, doses), low: refillDue(entry, data, doses) }
}

export const supplyText = (s: Supply) => `${s.left} ${s.left === 1 ? 'pill' : 'pills'} left${s.days != null ? ` (about ${s.days} ${s.days === 1 ? 'day' : 'days'})` : ''}`

// Every medicine that is running low, fewest days first
export function runningLow(data: HaloData, doses: DoseLog[]): { entry: MedEntry; supply: Supply }[] {
  return allMedicines(data)
    .map(entry => ({ entry, supply: supply(entry, data, doses) }))
    .filter((x): x is { entry: MedEntry; supply: Supply } => x.supply != null && x.supply.low)
    .sort((a, b) => (a.supply.days ?? 0) - (b.supply.days ?? 0))
}
