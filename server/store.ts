import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plan, TranscriptLine } from '../shared/calendar.ts'

type Db = { transcript: TranscriptLine[]; plans: Plan[]; present: string[] }

const FILE = process.env.HALO_CALENDAR_FILE ?? fileURLToPath(new URL('./data/calendar.json', import.meta.url))
const IN_MEMORY = FILE === ':memory:'
const MAX_LINES = 500

function load(): Db {
  if (IN_MEMORY || !fs.existsSync(FILE)) return { transcript: [], plans: [], present: [] }
  return { transcript: [], plans: [], present: [], ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }
}

export const db: Db = load()

export function save() {
  if (db.transcript.length > MAX_LINES) db.transcript.splice(0, db.transcript.length - MAX_LINES)
  if (IN_MEMORY) return
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2))
}

// People and patient come from the care portal's store (read-only here)
const PORTAL_DATA = fileURLToPath(new URL('../portal/data/halo.json', import.meta.url))

type CareData = { patient: string; people: { name: string; relation: string }[] }
let careOverride: CareData | undefined

// For tests, so they don't depend on what is saved in the portal
export function setCareData(c: CareData | undefined) { careOverride = c }

export function readCareData(): CareData {
  if (careOverride) return careOverride
  try {
    const d = JSON.parse(fs.readFileSync(PORTAL_DATA, 'utf8'))
    return { patient: d.patient?.name ?? '', people: d.people ?? [] }
  } catch {
    return { patient: '', people: [] }
  }
}
