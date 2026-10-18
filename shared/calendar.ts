// Types shared by the HALO server, the care portal and the glasses app (Flow C: plans -> calendar)

export type TranscriptLine = {
  id: string
  ts: string // ISO
  speaker: string // person name, or 'unknown' until voice recognition exists
  text: string
}

// asked:          on the glasses, waiting for the patient to say yes or no
// queued:         another proposal is on screen; this one is next
// confirmed:      on the calendar (patient said yes, or family approved/added it)
// declined:       patient said no
// needs_approval: patient didn't answer in time; waiting for the family in the portal
// rejected:       family said no
export type PlanStatus = 'asked' | 'queued' | 'confirmed' | 'declined' | 'needs_approval' | 'rejected'

export type Plan = {
  id: string
  activity: string // short, e.g. "park"
  who: string[]
  start: string // ISO
  allDay: boolean // true when only a date was said
  status: PlanStatus
  createdAt: string
  askedAt?: string
  resolvedAt?: string
  confirmedBy?: 'patient' | 'family'
  source?: { lineId: string; quote: string } // absent for events the family adds by hand
  conflictWith?: string // plan id that overlaps in time
}

export type GlassesState = {
  now: string
  prompt: { id: string; lines: string[]; expiresAt: string } | null
  resolved: { id: string; status: PlanStatus; text: string } | null // answered in the last few seconds
  heard: { text: string; note: string } | null // the last thing HALO heard, for a few seconds, so the wearer can see it understood
  today: Plan[] // confirmed, starting today, soonest first
  upcoming: Plan[] // confirmed, starting within the next hour (for reminders)
}
