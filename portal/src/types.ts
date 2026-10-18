export type Person = {
  id: string
  name: string
  relation: string
  blurb: string
  voiceFile: string
  transcript?: string
  createdAt: string
}

export type Medicine = {
  name: string
  strength: string
  form: string
  instructions: string
  times: string[] // 24-hour "HH:MM"
  quantity: number | null
  refills: number | null
  stopped?: boolean // no longer taken: hidden from the schedule and refills, but the numbering of the others stays
}

export type Appointment = {
  title: string
  date: string // "YYYY-MM-DD"
  time: string | null // "HH:MM"
}

export type PrescriptionReading = {
  medicines: Medicine[]
  appointments: Appointment[]
  notes: string[]
  readAt: string
}

export type Prescription = {
  id: string
  file: string // '' when the family typed the medicine in by hand
  originalName: string
  doctor: string
  date: string
  notes: string
  uploadedAt: string
  reading?: PrescriptionReading
  readError?: string
}

// Pills on hand as counted by the family, at a point in time
export type Stock = { count: number; at: string }

export type HaloData = {
  patient: { name: string; zip?: string }
  people: Person[]
  prescriptions: Prescription[]
  // Keyed by medicine key ("<prescription id>:<index>")
  stock?: Record<string, Stock>
}

export type DoseSource = 'imessage' | 'glasses'

export type DoseLog = { medKey: string; slot: string; at: string; by?: DoseSource } // slot: "YYYY-MM-DD HH:MM"

export type PriceQuote = { pharmacy: string; price: number; priceType: string }

export type PriceCheck = {
  status: 'checking' | 'done' | 'failed'
  zip: string
  startedAt?: string
  checkedAt?: string
  url?: string
  quantity?: number | null
  quotes?: PriceQuote[]
  note?: string
  error?: string
}

export type TranscriptLine = { text: string; at: string; id?: string; speaker?: string }

// Plans HALO picks up from conversation (see shared/calendar.ts)
export type { GlassesState, Plan, PlanStatus } from '../../shared/calendar.ts'

export type TextAlertKind = 'missed' | 'refill' | 'prices'

export type TextMessage = {
  at: string
  direction: 'in' | 'out'
  handle: string // masked, e.g. "(•••) •••-0123"
  text: string
  alert?: TextAlertKind
  glassesId?: string
  glassesSeenAt?: string
}

// A caregiver's message waiting on, or already seen on, the patient's glasses
export type GlassesMessage = { id: string; text: string; handle: string; sentAt: string; seenAt?: string }

// What the glasses app shows: a family message first, then a dose that's due, then home
export type GlassesView = {
  patientName: string
  message: { id: string; text: string } | null
  due: { medKey: string; slot: string; title: string; time: string; detail: string } | null
  next: { title: string; time: string; kind: 'medicine' | 'appointment' | 'plan' } | null
  appointment: { title: string; date: string; time: string | null } | null
}

export type ImessageStatus = {
  configured: boolean
  agentNumber: string
  glassesOnline?: boolean
  error?: string
  caregivers: { handle: string; linkedAt: string; paused: boolean }[]
  messages: TextMessage[]
  // Latest alert texted about each medicine, keyed by medicine key
  alerts: Record<string, { kind: TextAlertKind; at: string }>
}
