import { chatJson } from './groq.ts'
import { findWhen, type When } from './when.ts'
import type { TranscriptLine } from '../../shared/calendar.ts'

export type Extracted = {
  kind: 'commitment' | 'offer'
  activity: string
  who: string[]
  quote: string
  when: When
}

type LlmAnswer = { kind: 'commitment' | 'offer' | 'none'; activity: string; who: string[]; quote: string; when_text: string }

const SYSTEM = `You are the Scheduler agent in HALO, an assistant for a person with dementia. You only look for calendar plans.

Classify the NEW line as one of:
- "commitment": a specific FUTURE event that someone commits to or states as agreed, with a date and/or time: a visit, outing, appointment, call, gathering, trip. A social event that includes food (a barbecue, dinner out, a birthday lunch) IS a plan.
- "offer": a direct question or suggestion that proposes a specific event at a specific date and/or time and is waiting for an answer ("Do you want to meet today at 6?", "Shall we go on Saturday at 2?", "How about Friday at 11 for lunch?").
- "none": everything else, including:
- medicine, pills, tablets, injections, doctor-prescribed schedules
- logging or reminding about everyday meals ("I had toast at 8", "breakfast is at 8", "lunch at noon as usual")
- daily routine (waking up, bedtime, showers, walks as routine)
- anything that already happened (past tense)
- maybes, wishes and vague ideas ("sometime", "we should", "maybe", "one day")
- questions, requests for information, small talk, feelings
- trivial moments like "back in five minutes" or "one second"

If it is a commitment or an offer:
- activity: a short noun phrase for what will happen, lowercase, at most 4 words ("park", "dentist appointment", "birthday dinner"). If the plan is just a visit, use "visit".
- who: first names of the OTHER people involved (not the patient). "I" and "we" include the speaker of the line when the speaker is known. When the speaker is "unknown" and exactly one person is visiting right now, "I" and "we" mean that visitor (the patient is usually addressed as "you"); with several visitors or none, list only names that are actually said. Use names exactly as given in the known people list when they match.
- quote: the exact words from the NEW line that make the plan, copied character for character.
- when_text: the exact words from the NEW line that state the date or time, copied character for character.
For "none" return empty strings and an empty list.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'activity', 'who', 'quote', 'when_text'],
  properties: {
    kind: { type: 'string', enum: ['commitment', 'offer', 'none'] },
    activity: { type: 'string' },
    who: { type: 'array', items: { type: 'string' } },
    quote: { type: 'string' },
    when_text: { type: 'string' },
  },
}

const lower = (s: string) => s.toLowerCase()

// Looks for one plan in the newest line. The date and time must be in that line, found by
// code (chrono). The model only decides whether it is a real plan and who and what it involves.
// Everything it returns is checked against the line, so it can't make a plan up.
export async function extractPlan(
  line: TranscriptLine,
  context: TranscriptLine[],
  ref: Date,
  apiKey: string,
  care: { patient: string; people: { name: string; relation: string }[] },
  present: string[] = [],
): Promise<Extracted | null> {
  const whens = findWhen(line.text, ref)
  if (!whens.length) return null

  const known = care.people.map(p => `${p.name} (${p.relation})`).join(', ') || 'none'
  const user = [
    `Now: ${ref.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
    `Patient: ${care.patient || 'unknown'}`,
    `Known people: ${known}`,
    context.length ? `Earlier lines (context only):\n${context.map(l => `[${l.speaker}] ${l.text}`).join('\n')}` : '',
    `People visiting the patient right now: ${present.length ? present.join(', ') : 'nobody listed'}`,
    `Speaker of the new line: ${line.speaker}`,
    `NEW line: ${line.text}`,
  ].filter(Boolean).join('\n')

  const a = await chatJson<LlmAnswer>(apiKey, SYSTEM, user, 'scheduler', SCHEMA)
  if (process.env.HALO_DEBUG) console.error('[scheduler] model said', JSON.stringify(a), 'for', JSON.stringify(line.text))
  if (a.kind === 'none') return null

  const text = lower(line.text)
  if (!a.quote || !text.includes(lower(a.quote))) return null
  const when = whens.find(w => lower(a.when_text).includes(lower(w.text)) || lower(w.text).includes(lower(a.when_text))) ?? whens[0]

  const known_names = new Map(care.people.map(p => [lower(p.name), p.name]))
  const who = [...new Set(a.who.map(n => known_names.get(lower(n.trim())) ?? n.trim()).filter(Boolean))]
    .filter(n => lower(n) !== lower(care.patient))
  return { kind: a.kind, activity: lower(a.activity.trim()), who, quote: a.quote, when }
}
