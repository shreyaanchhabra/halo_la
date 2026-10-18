// The care setup data (patient, people, prescriptions) kept by the portal's dev store.
export type Person = { id: string; name: string; relation: string; blurb: string; voiceFile: string; createdAt: string }
export type Prescription = { id: string; file: string; originalName: string; doctor: string; date: string; notes: string; uploadedAt: string }
export type CareData = { patient: { name: string }; people: Person[]; prescriptions: Prescription[] }

export const emptyCareData = (): CareData => ({ patient: { name: '' }, people: [], prescriptions: [] })

export async function loadCareData(): Promise<CareData> {
  const saved = await (await fetch('/api/data')).json()
  return { ...emptyCareData(), ...saved }
}

export async function saveCareData(data: CareData) {
  await fetch('/api/data', { method: 'PUT', body: JSON.stringify(data) })
}

export async function uploadFile(blob: Blob, name: string): Promise<string> {
  const res = await fetch(`/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob })
  return (await res.json()).file
}

export async function removeFile(file: string) {
  await fetch(`/api/files/${encodeURIComponent(file)}`, { method: 'DELETE' })
}

export const fileUrl = (file: string) => `/api/files/${encodeURIComponent(file)}`
