export const toLocalInput = (iso: string) => {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export const fromLocalInput = (v: string, allDay: boolean) => (allDay ? new Date(v.slice(0, 10) + 'T00:00') : new Date(v)).toISOString()

export const splitNames = (s: string) => s.split(',').map(n => n.trim()).filter(Boolean)
