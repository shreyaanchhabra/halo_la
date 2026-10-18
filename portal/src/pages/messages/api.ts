const UNAVAILABLE = 'HALO backend is unavailable. Start the project with npm run start:all.'

export async function api<T>(suffix: string, body?: object): Promise<T> {
  const res = await fetch(`/api/messages${suffix}`, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) })
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new Error(UNAVAILABLE)
  const raw = await res.text()
  let result
  try { result = JSON.parse(raw) } catch { throw new Error(UNAVAILABLE) }
  if (!res.ok) throw new Error(result.error ?? 'Request failed')
  return result
}
