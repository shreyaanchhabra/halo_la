import { appointments, formatTime, scheduleFor, ymd } from '../src/schedule.ts'
import type { DoseLog, HaloData, Plan } from '../src/types'

export function doseUpdateText(patient: string, medicine: string, slot: string, taken: boolean): string {
  const name = patient.trim().split(/\s+/)[0] || 'your family member'
  const time = formatTime(slot.slice(11))
  return taken
    ? `Good news: ${name} marked ${medicine} as taken for the ${time} dose.`
    : `Dose update: ${name}'s ${medicine} ${time} dose was marked not taken.`
}

export function careSummaryText(data: HaloData, doses: DoseLog[], plans: Plan[], now: Date): string {
  const patient = data.patient.name.trim().split(/\s+/)[0] || 'your family member'
  const date = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
  const lines = [`Care summary for ${patient} - ${date}.`, "Today's medication doses:"]
  const today = scheduleFor(data, now, plans).filter(item => item.kind === 'medicine')
  if (today.length) {
    lines.push(...today.slice(0, 5).map(item => {
      const taken = doses.find(dose => dose.medKey === item.medKey && dose.slot === item.slot)
      return `- ${item.title} at ${formatTime(item.time!)}: ${taken ? `taken at ${new Date(taken.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : 'not yet marked taken'}`
    }))
    if (today.length > 5) lines.push(`- and ${today.length - 5} more scheduled doses`)
  } else {
    lines.push('- none scheduled today')
  }

  const upcoming = appointments(data, plans).filter(item => item.date >= ymd(now)).slice(0, 3)
  lines.push('Upcoming appointments:')
  if (upcoming.length) {
    lines.push(...upcoming.map(item => {
      const day = new Date(`${item.date}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      return `- ${item.title}, ${day}${item.time ? ` at ${formatTime(item.time)}` : ''}`
    }))
  } else {
    lines.push('- none scheduled')
  }
  return lines.join('\n')
}
