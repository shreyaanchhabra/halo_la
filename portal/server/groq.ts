// Groq calls for the calendar: speech clips from the glasses, and deciding whether a sentence is a plan.
// (Reading prescriptions and transcribing uploaded voice samples are in ai.ts.)

const GROQ = 'https://api.groq.com/openai/v1'
const LLM_MODEL = 'openai/gpt-oss-120b'
// Groq gives each model its own daily token allowance; this one takes over when the main model's is used up
export const FALLBACK_MODEL = 'openai/gpt-oss-20b'
export const STT_MODEL = 'whisper-large-v3'
const MAX_ATTEMPTS = 3
const MAX_WAIT_MS = 15_000

// Whisper invents these on silence and background noise
const HALLUCINATIONS = new Set(['thank you', 'thanks for watching', 'you', 'bye', 'thank you for watching', ''])
const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').trim()

// How long a 429 asks us to wait ("try again in 1.5s", "250ms", "4m44.688s"), plus a margin. null when
// that's longer than is worth holding someone's sentence for, like the daily token limit: fail now instead.
export function retryWaitMs(body: string): number | null {
  const m = /try again in (?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?/.exec(body)
  const ms = m && m.slice(1).some(Boolean)
    ? Number(m[1] ?? 0) * 3_600_000 + Number(m[2] ?? 0) * 60_000 + Number(m[3] ?? 0) * 1000 + Number(m[4] ?? 0)
    : 3000
  return ms + 500 > MAX_WAIT_MS ? null : ms + 500
}

const retried = async (res: Response, attempt: number) => {
  if (res.status !== 429 || attempt >= MAX_ATTEMPTS) return false
  const body = await res.text()
  const ms = retryWaitMs(body)
  if (ms == null) throw new Error(`Groq error 429: ${body.slice(0, 300)}`)
  await new Promise(r => setTimeout(r, ms))
  return true
}

// Whisper is guided by a short piece of text that reads like the start of the conversation
export function sttPrompt(vocabulary: string[] = []): string {
  const names = [...new Set(vocabulary.map(v => v.trim()).filter(Boolean))]
  return `A family conversation. ${names.length ? `People: ${names.join(', ')}. ` : ''}Calendar commands sound like "Set an event for soccer tomorrow at 4 PM", "Set an event at 4 PM for soccer", or "Set an event for the dentist Tuesday at 9:30 in the morning".`
}

export type SttOptions = {
  model?: string
  vocabulary?: string[] // names Whisper should expect, so "Maya" isn't heard as "Maija"
  prompt?: string // replaces the generated prompt; '' sends none
}

// One finished utterance as a 16 kHz mono WAV. The free tier allows 20 requests a minute; on a 429, wait and retry.
export async function transcribeWav(wav: Uint8Array, apiKey: string, opts: SttOptions = {}): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const form = new FormData()
    form.set('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'speech.wav')
    form.set('model', opts.model ?? STT_MODEL)
    form.set('language', 'en')
    form.set('temperature', '0')
    form.set('response_format', 'verbose_json')
    const prompt = opts.prompt ?? sttPrompt(opts.vocabulary)
    if (prompt) form.set('prompt', prompt)
    const res = await fetch(`${GROQ}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(20_000) })
    if (await retried(res, attempt)) continue
    if (!res.ok) throw new Error(`Groq error ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const j = (await res.json()) as { text: string; segments?: { no_speech_prob: number }[] }
    if (j.segments?.length && j.segments.every(s => s.no_speech_prob > 0.6)) return ''
    const text = j.text.trim()
    return HALLUCINATIONS.has(norm(text)) ? '' : text
  }
}

// A JSON answer that must match a schema. The free tier is limited to 8000 tokens a minute; on a 429, wait and retry.
export async function chatJson<T>(apiKey: string, system: string, user: string, name: string, schema: object, model = LLM_MODEL): Promise<T> {
  try {
    return await chatOnce<T>(apiKey, system, user, name, schema, model)
  } catch (err) {
    if (model === FALLBACK_MODEL || !String(err).includes('Groq error 429')) throw err
    return chatOnce<T>(apiKey, system, user, name, schema, FALLBACK_MODEL)
  }
}

async function chatOnce<T>(apiKey: string, system: string, user: string, name: string, schema: object, model: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${GROQ}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        reasoning_effort: 'low',
        max_completion_tokens: 1500,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (await retried(res, attempt)) continue
    if (!res.ok) throw new Error(`Groq error ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const j = (await res.json()) as { choices: { message: { content: string } }[] }
    return JSON.parse(j.choices[0].message.content) as T
  }
}
