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

The NEW line contains an explicit command to set an event. It may be surrounded by other words, and the task and date/time may come in either order (for example, "set an event at 4 for soccer"). Classify it as one of:
- "commitment": a specific FUTURE event with a date and/or time: a visit, outing, appointment, call, gathering, trip. A social event that includes food (a barbecue, dinner out, a birthday lunch) IS a plan.
- "offer": the command is phrased as a question still waiting for an answer.
- "none": everything else, including:
- medicine, pills, tablets, injections, doctor-prescribed schedules
- logging or reminding about everyday meals ("I had toast at 8", "breakfast is at 8", "lunch at noon as usual")
- daily routine (waking up, bedtime, showers, walks as routine)
- anything that already happened (past tense)
- maybes, wishes and vague ideas ("sometime", "we should", "maybe", "one day")
- questions, requests for information, small talk, feelings
- trivial moments like "back in five minutes" or "one second"
- any sentence that is not actually setting an event, even if it contains a date

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

// Looks for one plan in the newest line. An explicit set-event command and a date/time must be
// present in that line; code finds the date/time (chrono), and the model decides the plan details.
// Everything it returns is checked against the line, so it can't make a plan up.
export function sameActivity(a: string, b: string): boolean {
  const na = lower(a.trim()), nb = lower(b.trim())
  if (!na || !nb) return false
  return na === nb || na.includes(nb) || nb.includes(na)
}

const WHEN_TAIL = /^(at\s+)?(\d{1,2}(:\d{2})?\s*(am|pm)?|noon|midnight|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
const EVENT_COMMAND = /\bset(?:\s+an?)?\s+event\s+(?:for|at)\b/i

export function isEventCommand(text: string): boolean {
  return EVENT_COMMAND.test(text)
}

// The glasses sometimes cut before the time ("lunch break at" / "11 AM today"). Join them.
export function planText(current: string, previous?: string): string {
  const cur = current.trim()
  const prev = previous?.trim()
  if (!prev || !WHEN_TAIL.test(cur)) return cur
  const joined = `${prev} ${cur}`
  return findWhen(joined, new Date()).length ? joined : cur
}

export async function extractPlan(
  line: TranscriptLine,
  context: TranscriptLine[],
  ref: Date,
  apiKey: string,
  care: { patient: string; people: { name: string; relation: string }[] },
  present: string[] = [],
): Promise<Extracted | null> {
  const text = planText(line.text, context.at(-1)?.text)
  if (!isEventCommand(text)) return null
  const whens = findWhen(text, ref)
  if (!whens.length) return null
  const source = text === line.text ? line : { ...line, text }

  const known = care.people.map(p => `${p.name} (${p.relation})`).join(', ') || 'none'
  const user = [
    `Now: ${ref.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
    `Patient: ${care.patient || 'unknown'}`,
    `Known people: ${known}`,
    context.length ? `Earlier lines (context only):\n${context.map(l => `[${l.speaker}] ${l.text}`).join('\n')}` : '',
    `People visiting the patient right now: ${present.length ? present.join(', ') : 'nobody listed'}`,
    `Speaker of the new line: ${source.speaker}`,
    `NEW line: ${source.text}`,
  ].filter(Boolean).join('\n')

  const a = await chatJson<LlmAnswer>(apiKey, SYSTEM, user, 'scheduler', SCHEMA)
  if (process.env.HALO_DEBUG) console.error('[scheduler] model said', JSON.stringify(a), 'for', JSON.stringify(line.text))
  if (a.kind === 'none') return null

  const spoken = lower(source.text)
  if (!a.quote || !spoken.includes(lower(a.quote))) return null
  const when = whens.find(w => lower(a.when_text).includes(lower(w.text)) || lower(w.text).includes(lower(a.when_text))) ?? whens[0]

  const known_names = new Map(care.people.map(p => [lower(p.name), p.name]))
  const who = withKnownSpeaker(
    [...new Set(a.who.map(n => known_names.get(lower(n.trim())) ?? n.trim()).filter(Boolean))]
      .filter(n => lower(n) !== lower(care.patient)),
    line.speaker,
    care,
  )
  return { kind: a.kind, activity: lower(a.activity.trim()), who, quote: a.quote, when }
}

const same = (a: string, b: string) => lower(a.trim()) === lower(b.trim())
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name

// The model often leaves the speaker off "who". A saved voice that said the line always belongs on the plan.
export function withKnownSpeaker(who: string[], speaker: string, care: { patient: string; people: { name: string; relation: string }[] }): string[] {
  if (!speaker || same(speaker, 'unknown') || same(speaker, care.patient) || same(first(speaker), first(care.patient))) return who
  const person = care.people.find(p => same(p.name, speaker) || same(first(p.name), first(speaker)))
  if (!person) return who
  if (who.some(w => same(w, person.name) || same(first(w), first(person.name)))) return who
  return [person.name, ...who]
}
