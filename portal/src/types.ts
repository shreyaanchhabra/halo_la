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
  file: string
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

export type DoseLog = { medKey: string; slot: string; at: string } // slot: "YYYY-MM-DD HH:MM"

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
