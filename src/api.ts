import type { GlassesState } from '../shared/calendar.ts'
import type { GlassesMenu, GlassesView } from '../portal/src/types.ts'

// Empty in development: the dev server proxies /api to the HALO server. Set VITE_HALO_API
// (e.g. http://192.168.1.20:8787) when building the packaged app.
export const API: string = import.meta.env.VITE_HALO_API ?? ''

async function json<T>(path: string, init: RequestInit = {}, timeoutMs = 4000): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return (await res.json()) as T
}

export const getState = () => json<GlassesState>('/api/glasses/state')

// Family messages from iMessage and doses that are due (portal/server/glasses.ts)
export const getCare = () => json<GlassesView>('/api/glasses')

// Appointments over the next 3 days, medicines and the family, for the menu (portal/server/glasses-menu.ts)
export const getMenu = () => json<GlassesMenu>('/api/glasses/menu')

const post = (path: string, body: object) =>
  json<unknown>(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })

export const markSeen = (id: string) => post('/api/glasses/seen', { id })
export const markTaken = (medKey: string, slot: string) => post('/api/doses', { medKey, slot, taken: true, by: 'glasses' })
export const markNotTaken = (medKey: string, slot: string) => post('/api/doses', { medKey, slot, taken: false, by: 'glasses' })

export type AudioReply = { kind: string; text: string; answer?: string; summary?: string; error?: string }

export const postAudio = (wav: Uint8Array) =>
  json<AudioReply>('/api/audio', { method: 'POST', body: wav as BodyInit, headers: { 'Content-Type': 'audio/wav' } }, 25_000)

export const postDoseAnswer = (wav: Uint8Array) =>
  json<AudioReply>('/api/audio/dose', { method: 'POST', body: wav as BodyInit, headers: { 'Content-Type': 'audio/wav' } }, 25_000)

export const postWho = (wav: Uint8Array) =>
  json<AudioReply>('/api/audio/who', { method: 'POST', body: wav as BodyInit, headers: { 'Content-Type': 'audio/wav' } }, 4_000)

export const postStats = (stats: object) =>
  json<unknown>('/api/audio/stats', { method: 'POST', body: JSON.stringify(stats), headers: { 'Content-Type': 'application/json' } })
