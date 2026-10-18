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

export type HaloData = {
  patient: { name: string }
  people: Person[]
  prescriptions: Prescription[]
}

export type TranscriptLine = { text: string; at: string }
