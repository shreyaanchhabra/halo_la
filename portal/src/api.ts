import * as Sentry from '@sentry/browser'
import { careOperation } from './operations'
import type { DoseLog, HaloData, ImessageStatus, Medicine, PriceCheck, PrescriptionReading, TranscriptLine } from './types'

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET'
  const path = new URL(url, 'http://localhost').pathname
  return Sentry.startSpan({
    name: careOperation(method, path),
    op: 'care.action',
    attributes: { 'http.request.method': method },
  }, async () => {
    let res: Response
    try {
      res = await fetch(url, init)
    } catch (err) {
      Sentry.captureException(err)
      throw err
    }
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
    return body
  })
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

export const addTranscript = (text: string) =>
  call('/api/transcripts', { method: 'POST', body: JSON.stringify({ text }) })

export const loadDoses = () => call<DoseLog[]>('/api/doses')

export const setDose = (medKey: string, slot: string, taken: boolean) =>
  call('/api/doses', { method: 'POST', body: JSON.stringify({ medKey, slot, taken }) })

export const loadPrices = () => call<Record<string, PriceCheck>>('/api/prices')

export const loadImessage = () => call<ImessageStatus>('/api/imessage')

// Starts a Browser Use lookup on GoodRx; the result arrives later through onDataChanged
export const checkPrices = (key: string, med: Medicine, zip: string) =>
  call('/api/prices', { method: 'POST', body: JSON.stringify({ key, med, zip }) })

// Calls back whenever the other page (or this one) saves data
export function onDataChanged(cb: () => void) {
  import.meta.hot?.on('halo:update', cb)
}

export const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
