import type { RefillState } from '../../shared/refill-types.ts'
import type { DoseLog, GlassesState, HaloData, Medicine, Plan, PriceCheck, PrescriptionReading, TranscriptLine } from './types'

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
  return body
}

export async function loadData(): Promise<HaloData> {
  const saved = await call<Partial<HaloData>>('/api/data')
  return { patient: { name: '' }, people: [], prescriptions: [], ...saved }
}

export const saveData = (data: HaloData) =>
  call('/api/data', { method: 'PUT', body: JSON.stringify(data) })

export const uploadFile = async (blob: Blob, name: string) =>
  (await call<{ file: string }>(`/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob })).file

export const removeFile = (file: string) =>
  call(`/api/files/${encodeURIComponent(file)}`, { method: 'DELETE' })

export const fileUrl = (file: string) => `/api/files/${encodeURIComponent(file)}`

export const readPrescription = (file: string) =>
  call<PrescriptionReading>(`/api/read-prescription?file=${encodeURIComponent(file)}`, { method: 'POST' })

export const transcribe = async (file: string) =>
  (await call<{ text: string }>(`/api/transcribe?file=${encodeURIComponent(file)}`, { method: 'POST' })).text

export const loadTranscripts = () => call<TranscriptLine[]>('/api/transcripts')

export const addTranscript = (text: string, speaker = 'unknown') =>
  call<{ kind: string; summary?: string }>('/api/transcripts', { method: 'POST', body: JSON.stringify({ text, speaker }) })

// ---- Plans from conversation ----
const json = (method: string, body?: unknown): RequestInit =>
  ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

export const loadPlans = () => call<Plan[]>('/api/plans')
export const loadAsk = () => call<GlassesState>('/api/glasses/state')
export const addPlan = (plan: { activity: string; who: string[]; start: string; allDay: boolean }) => call<Plan>('/api/plans', json('POST', plan))
export const editPlan = (id: string, patch: Partial<Pick<Plan, 'activity' | 'who' | 'start' | 'allDay'>>) => call<Plan>(`/api/plans/${id}`, json('PATCH', patch))
export const deletePlan = (id: string) => call(`/api/plans/${id}`, json('DELETE'))
// Family: approve or reject a plan the patient didn't answer. Patient: answer the question with a button.
export const planAction = (id: string, action: 'approve' | 'reject' | 'yes' | 'no') => call<Plan>(`/api/plans/${id}/${action}`, json('POST'))
export const loadPresent = () => call<string[]>('/api/present')
export const setPresent = (here: string[]) => call<string[]>('/api/present', json('PUT', { here }))

export const loadDoses = () => call<DoseLog[]>('/api/doses')

export const setDose = (medKey: string, slot: string, taken: boolean) =>
  call('/api/doses', { method: 'POST', body: JSON.stringify({ medKey, slot, taken }) })

export const clearPrices = (key: string) => call(`/api/prices?key=${encodeURIComponent(key)}`, { method: 'DELETE' })
export const loadPrices = () => call<Record<string, PriceCheck>>('/api/prices')

// Starts a Browser Use lookup on GoodRx; the result arrives later through onDataChanged
export const checkPrices = (key: string, med: Medicine, zip: string) =>
  call('/api/prices', { method: 'POST', body: JSON.stringify({ key, med, zip }) })

// Calls back whenever the other page (or this one) saves data
export function onDataChanged(cb: () => void) {
  import.meta.hot?.on('halo:update', cb)
}

export const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

// ---- Refills ----
export const loadRefills = () => call<RefillState>('/api/refills')
export const refillAction = (id: string, op: 'approve' | 'reject' | 'requote' | 'received', body: object = {}) =>
  call(`/api/refills/${id}/${op}`, { method: 'POST', body: JSON.stringify(body) })
export const setRefillLimit = (spendingLimitCents: number) =>
  call('/api/refills/settings', { method: 'PUT', body: JSON.stringify({ spendingLimitCents }) })
