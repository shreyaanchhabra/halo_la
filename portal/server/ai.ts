import fs from 'node:fs'
import path from 'node:path'
import { extractText, getDocumentProxy } from 'unpdf'

const GROQ = 'https://api.groq.com/openai/v1'
const READER_MODEL = 'qwen/qwen3.8-27b'
const STT_MODEL = 'whisper-large-v3-turbo'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
}

const PROMPT = `You read medical prescriptions for a care app. Extract exactly what is written; never guess or add anything.
Return only JSON in this shape:
{
  "medicines": [{
    "name": "Donepezil",
    "strength": "5 mg",
    "form": "tablet",
    "instructions": "Take 1 tablet by mouth once daily at bedtime",
    "times": ["21:00"],
    "quantity": 30,
    "refills": 2
  }],
  "appointments": [{ "title": "Follow-up with Dr. Patel", "date": "2026-11-14", "time": "10:30" }],
  "notes": ["Low-sodium diet"]
}
Rules:
- "times" are 24-hour HH:MM dose times. Use times written on the prescription. If only a part of day is given, use morning 08:00, noon 12:00, evening 18:00, bedtime 21:00. "Twice daily" with no times is ["08:00", "20:00"].
- "quantity" and "refills" are numbers, or null if not written.
- "appointments" are follow-ups or visits with a date. "date" is YYYY-MM-DD; "time" is HH:MM or null.
- "notes" are care plan instructions such as diet, fluids, exercise or warning signs. Do not repeat medicines there.`

type Content = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export async function readPrescription(filePath: string, apiKey: string) {
  const ext = path.extname(filePath).toLowerCase()
  const buf = fs.readFileSync(filePath)
  let content: Content[]

  if (ext === '.pdf') {
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true })
    if (!text.trim()) throw new Error('This PDF has no readable text, so it may be a scan. Upload a photo of it instead.')
    content = [{ type: 'text', text: `${PROMPT}\n\nPrescription text:\n${text}` }]
  } else if (IMAGE_MIME[ext]) {
    content = [
      { type: 'text', text: PROMPT },
      { type: 'image_url', image_url: { url: `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}` } },
    ]
  } else {
    throw new Error(`Can't read ${ext} files. Upload a PDF, PNG, JPG or WebP.`)
  }

  const res = await fetch(`${GROQ}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: READER_MODEL,
      temperature: 0,
      reasoning_effort: 'none',
      max_tokens: 1000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }],
    }),
  })
  if (!res.ok) throw new Error(`Groq error ${res.status}: ${(await res.text()).slice(0, 300)}`)

  const raw: string = (await res.json()).choices[0].message.content
  const json = raw.replace(/<think>[\s\S]*?<\/think>/g, '')
  const parsed = JSON.parse(json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1))

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const hhmm = (v: unknown) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null)

  return {
    medicines: (parsed.medicines ?? []).map((m: any) => ({
      name: String(m.name ?? ''),
      strength: String(m.strength ?? ''),
      form: String(m.form ?? ''),
      instructions: String(m.instructions ?? ''),
      times: (m.times ?? []).map(hhmm).filter(Boolean),
      quantity: num(m.quantity),
      refills: num(m.refills),
    })),
    appointments: (parsed.appointments ?? [])
      .filter((a: any) => /^\d{4}-\d{2}-\d{2}$/.test(a.date))
      .map((a: any) => ({ title: String(a.title ?? 'Appointment'), date: a.date, time: hhmm(a.time) })),
    notes: (parsed.notes ?? []).map(String),
    readAt: new Date().toISOString(),
  }
}

export type CaregiverAction =
  | { type: 'approve_refill'; medKey: string }
  | { type: 'check_prices'; medKey: string }
  | { type: 'pause_alerts' }
  | { type: 'resume_alerts' }
  | { type: 'mark_taken'; medKey: string | null; time: string | null }
  | { type: 'undo_taken' }
  | { type: 'send_to_glasses'; text: string }
  | { type: 'name_guest'; name: string; relation: string; guest: string | null }

const CAREGIVER_PROMPT = `You are HALO, a care assistant texting on iMessage with a family caregiver.
Answer only from the care record below. If the record doesn't say, say you don't know.
Write like a warm, upbeat text message: 1 to 3 short sentences, plain text, no markdown, no emojis. Sound encouraging without being overly familiar, repetitive, or making promises HALO cannot keep.
Never give medical advice beyond what is written. For dosing changes or symptoms, tell them to call the doctor, or 911 in an emergency.
Return only JSON: {"reply": "...", "action": null}
Set "action" only when the caregiver clearly asks for one of these, using a medicine key from the record:
{"type": "approve_refill", "medKey": "..."}
{"type": "check_prices", "medKey": "..."}
{"type": "pause_alerts"}
{"type": "resume_alerts"}
{"type": "mark_taken", "medKey": "..." or null, "time": "HH:MM" or null}
  When they say the patient took or was given medicine. Use the 24-hour time of the dose from today's schedule.
  Leave medKey null for "his 8pm pills"; leave both null for "he took his meds".
{"type": "undo_taken"}
  When they say a dose they just reported wasn't actually taken.
{"type": "send_to_glasses", "text": "..."}
  When they ask you to tell, remind, or pass something on to the patient. The patient reads it on their glasses.
  Rewrite it as one short, warm sentence spoken to the patient, under 120 characters. Never put medical changes in it.
  Call the sender "your family" unless they give their name.
{"type": "name_guest", "name": "...", "relation": "...", "guest": "Guest 2" or null}
  When they tell you who a new, unrecognized voice is ("That's Raj, his neighbor", "Guest 2 is Aunt Meena").
  name is the person's name as they gave it; relation is how they know the patient, lowercase ("neighbor", "aunt"), or "" if not said.
  guest is the label from "New voices waiting for a name" only if they say which one; otherwise null.`

export async function answerCaregiver(
  apiKey: string,
  record: string,
  history: { from: 'caregiver' | 'halo'; text: string }[],
  question: string,
): Promise<{ reply: string; action: CaregiverAction | null }> {
  const res = await fetch(`${GROQ}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: READER_MODEL,
      temperature: 0.2,
      reasoning_effort: 'none',
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${CAREGIVER_PROMPT}\n\nCare record:\n${record}` },
        // Past replies are shown in the JSON shape so the model keeps answering in it
        ...history.map(h => h.from === 'halo'
          ? { role: 'assistant', content: JSON.stringify({ reply: h.text, action: null }) }
          : { role: 'user', content: h.text }),
        { role: 'user', content: question },
      ],
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    // Groq rejects a plain-text answer in JSON mode but still returns it; that text is the reply
    const plain = (() => { try { return JSON.parse(body).error?.failed_generation } catch { return null } })()
    if (typeof plain === 'string' && plain.trim() && !plain.trim().startsWith('{')) return { reply: plain.trim(), action: null }
    throw new Error(`Groq error ${res.status}: ${body.slice(0, 300)}`)
  }

  const raw: string = (await res.json()).choices[0].message.content
  const json = raw.replace(/<think>[\s\S]*?<\/think>/g, '')
  if (!json.includes('{')) return { reply: json.trim(), action: null }
  const parsed = JSON.parse(json.slice(json.indexOf('{'), json.lastIndexOf('}') + 1))
  const a = parsed.action
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const action: CaregiverAction | null =
    a?.type === 'approve_refill' || a?.type === 'check_prices'
      ? (str(a.medKey) ? { type: a.type, medKey: str(a.medKey)! } : null)
      : a?.type === 'pause_alerts' || a?.type === 'resume_alerts' || a?.type === 'undo_taken' ? { type: a.type }
      : a?.type === 'mark_taken' ? { type: a.type, medKey: str(a.medKey), time: /^\d{2}:\d{2}$/.test(a.time ?? '') ? a.time : null }
      : a?.type === 'send_to_glasses' && str(a.text) ? { type: a.type, text: str(a.text)!.slice(0, 200) }
      : a?.type === 'name_guest' && str(a.name) ? { type: a.type, name: str(a.name)!.slice(0, 60), relation: (str(a.relation) ?? '').slice(0, 40), guest: str(a.guest) }
      : null
  return { reply: String(parsed.reply ?? '').trim(), action }
}

export async function transcribe(filePath: string, apiKey: string): Promise<string> {
  const form = new FormData()
  form.append('model', STT_MODEL)
  form.append('response_format', 'json')
  form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath))

  const res = await fetch(`${GROQ}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) throw new Error(`Groq error ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return ((await res.json()).text ?? '').trim()
}
