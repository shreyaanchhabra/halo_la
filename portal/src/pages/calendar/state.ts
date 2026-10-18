import type { Plan, TranscriptLine } from '../../../../shared/calendar.ts'
import { htmlCache } from '../../lib/dom'

export type Person = { name: string; relation: string }
export type CareInfo = { patient?: { name?: string }; people?: Person[] }
export type Reply = { kind: string; text: string; answer?: string; summary?: string; error?: string }

export const state = {
  plans: [] as Plan[],
  transcript: [] as TranscriptLine[],
  people: [] as Person[],
  patient: '',
  online: true,
  editing: null as string | null,
}

export const view = htmlCache()
