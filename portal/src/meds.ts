import { medKey } from './schedule.ts'
import type { DoseLog, HaloData, Medicine, Prescription } from './types'

export const REFILL_DAYS = 7

export type MedEntry = { key: string; rx: Prescription; med: Medicine }

export function allMedicines(data: HaloData): MedEntry[] {
  return data.prescriptions.flatMap(rx =>
    (rx.reading?.medicines ?? []).flatMap((med, i) => med.stopped ? [] : [{ key: medKey(rx.id, i), rx, med }]))
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

// "8 am, 9:30 PM" or "21:00" -> ["08:00", "09:30", "21:00"]; null when any part is not a time
export function parseTimes(text: string): string[] | null {
  const parts = text.split(/,|;|\band\b/i).map(p => p.trim()).filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i.exec(p)
    if (!m) return null
    let h = Number(m[1])
    const min = Number(m[2] ?? 0)
    const suffix = m[3]?.[0].toLowerCase()
    if (min > 59) return null
    if (suffix) {
      if (h < 1 || h > 12) return null
      h = h % 12 + (suffix === 'p' ? 12 : 0)
    } else if (h > 23) return null
    out.push(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`)
  }
  return out.length ? [...new Set(out)].sort() : null
}
