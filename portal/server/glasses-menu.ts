import { allMedicines, daysLeft, refillDue } from '../src/meds.ts'
import { appointments, ymd } from '../src/schedule.ts'
import type { DoseLog, GlassesMenu, HaloData, Plan } from '../src/types'

const APPOINTMENT_DAYS = 3 // today, then this many days ahead

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

export function glassesMenu(data: HaloData, doses: DoseLog[], plans: Plan[], now: Date): GlassesMenu {
  const today = ymd(now)
  const last = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + APPOINTMENT_DAYS))
  const time = hhmm(now)
  return {
    appointments: appointments(data, plans)
      .filter(a => a.date <= last && (a.date > today || (a.date === today && (!a.time || a.time >= time)))),
    medicines: allMedicines(data).map(e => ({
      title: `${e.med.name} ${e.med.strength}`.trim(),
      times: e.med.times,
      takenToday: doses.filter(d => d.medKey === e.key && d.slot.startsWith(`${today} `)).length,
      daysLeft: daysLeft(e, data, doses),
      low: refillDue(e, data, doses),
    })),
    family: data.people.map(p => ({ name: p.name, relation: p.relation })),
  }
}
