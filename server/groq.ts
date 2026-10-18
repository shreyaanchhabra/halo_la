import fs from 'node:fs'

try { process.loadEnvFile(new URL('../.env.local', import.meta.url)) } catch { /* no .env.local: GROQ_API_KEY must come from the environment */ }

const BASE = 'https://api.groq.com/openai/v1'
const MAX_ATTEMPTS = 3
const MAX_WAIT_MS = 15_000
export const STT_MODEL = process.env.HALO_STT_MODEL ?? 'whisper-large-v3'
export const LLM_MODEL = 'openai/gpt-oss-120b'

function key(): string {
  const k = process.env.GROQ_API_KEY
  if (!k) throw new Error('GROQ_API_KEY is not set (put it in .env.local)')
  return k
}

export const hasKey = () => Boolean(process.env.GROQ_API_KEY)

// Whisper invents these on silence and background noise
const HALLUCINATIONS = new Set(['thank you', 'thanks for watching', 'you', 'bye', 'thank you for watching', ''])
const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').trim()

export type SttOptions = {
  model?: string
  // Words Whisper should expect: names, places. Biases it towards spelling them right.
  vocabulary?: string[]
  prompt?: string // replaces the generated prompt; '' sends none
}

// Whisper is guided by a short piece of text that reads like the start of the conversation
export function sttPrompt(vocabulary: string[] = []): string {
  const names = [...new Set(vocabulary.map(v => v.trim()).filter(Boolean))]
  return `A family conversation about plans. ${names.length ? `People: ${names.join(', ')}. ` : ''}Visits, appointments, dates and times, like "Saturday at 2 PM" or "tomorrow at 9:30 in the morning".`
}

export async function transcribe(wav: Uint8Array, opts: SttOptions = {}): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const form = new FormData()
    form.set('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'speech.wav')
    form.set('model', opts.model ?? STT_MODEL)
    form.set('language', 'en')
    form.set('temperature', '0')
    form.set('response_format', 'verbose_json')
    const prompt = opts.prompt ?? sttPrompt(opts.vocabulary)
    if (prompt) form.set('prompt', prompt)
    const res = await fetch(`${BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    })
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      const secs = Number(/try again in ([\d.]+)s/.exec(await res.text())?.[1] ?? 3)
      await new Promise(r => setTimeout(r, Math.min(secs * 1000 + 500, MAX_WAIT_MS)))
      continue
    }
    if (!res.ok) throw new Error(`Groq transcription ${res.status}: ${await res.text()}`)
    const j = (await res.json()) as { text: string; segments?: { no_speech_prob: number }[] }
    if (j.segments?.length && j.segments.every(s => s.no_speech_prob > 0.6)) return ''
    const text = j.text.trim()
    return HALLUCINATIONS.has(norm(text)) ? '' : text
  }
}

export async function transcribeFile(path: string, opts?: SttOptions): Promise<string> {
  return transcribe(fs.readFileSync(path), opts)
}

// The free tier is limited to 8000 tokens a minute. On a 429, wait the time Groq asks for and retry.
export async function chatJson<T>(system: string, user: string, name: string, schema: object): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0,
        reasoning_effort: 'low',
        max_completion_tokens: 1500,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      const body = await res.text()
      const secs = Number(/try again in ([\d.]+)s/.exec(body)?.[1] ?? 3)
      await new Promise(r => setTimeout(r, Math.min(secs * 1000 + 500, MAX_WAIT_MS)))
      continue
    }
    if (!res.ok) throw new Error(`Groq chat ${res.status}: ${await res.text()}`)
    const j = (await res.json()) as { choices: { message: { content: string } }[] }
    return JSON.parse(j.choices[0].message.content) as T
  }
}
