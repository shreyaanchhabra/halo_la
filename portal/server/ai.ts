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
