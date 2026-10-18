import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { chatJson } from './groq.ts'
import type { HaloData, Person, VoiceCard, VoiceGuest, VoiceStatus } from '../src/types.ts'
import type { Plan, TranscriptLine } from '../../shared/calendar.ts'

// Who is speaking, from voiceprints (speaker embeddings) of the people the family recorded in the
// care portal. Runs on this machine with sherpa-onnx and NVIDIA's TitaNet-Large model; no audio leaves it.

// Calibrated on real recordings: clips of 2 s or more matched the right person every time at 0.45,
// and no other voice scored above 0.37. One second is enough for a who-prefix on the glasses.
const MATCH = 0.32 // prefer a saved voice over "unknown" when it is the closest; 0.45 left too many enrolled people unlabeled
const LEARN_ABOVE = 0.6 // confident matches teach the voiceprint how this person sounds on the glasses mic
const MIN_SECONDS = 1
const CARRY_MS = 10_000 // a short "yes" right after someone spoke is theirs
const CARD_MS = 8_000
const CARD_AGAIN_MS = 60_000
const CARD_WAIT_MS = 60_000 // after this the moment has passed; skip the card
const MAX_LEARNED = 20
const ENROLL_WINDOW_S = 3
const FACT_DELAY_MS = 20_000
const RATE = 16_000

type Print = number[]
type Voice = { file: string; prints: Print[]; learned: Print[] }
type Guest = {
  id: string; label: string; prints: Print[]; firstHeard: string; lastHeard: string
  seconds: number; lines: number; clips: string[]; asked?: boolean
}
type Store = {
  people: Record<string, Voice>
  patient?: Voice
  guests: Guest[]
  nextGuest: number
  facts: Record<string, { text: string; at: string }>
}

export type Heard = {
  speaker: string // a person's name, the patient's name, or "unknown"
  kind: 'person' | 'patient' | 'unknown'
  personId?: string
  guestId?: string
  score?: number
  closest?: { speaker: string; score: number } // for a voice that matched no one: the nearest saved voice
  short?: boolean // too short to recognize; credited to whoever just spoke
}

export type Clip = { print: Print | null; seconds: number; wav: Buffer }

export type VoicesOptions = {
  modelPath: string
  dataDir: string
  uploadsDir: string
  groqKey: string
  readData: () => HaloData
  saveData: (data: HaloData) => void
  lines: () => TranscriptLine[]
  plans: () => Plan[]
  renameSpeaker: (from: string, to: string) => void
  notify: () => void
  onGuestReady?: (guest: VoiceGuest) => void
  embed?: (samples: Float32Array) => number[] // tests: stands in for the model
}

type Extractor = {
  dim: number
  createStream(): { acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void }
  compute(stream: unknown): Float32Array
}

// 16-bit PCM WAV, as the glasses app sends it
export function wavSamples(buf: Buffer): Float32Array {
  let off = 12
  let rate = RATE, bits = 16, channels = 1
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10)
      rate = buf.readUInt32LE(off + 12)
      bits = buf.readUInt16LE(off + 22)
    } else if (id === 'data') {
      if (bits !== 16 || rate !== RATE) throw new Error(`Expected 16 kHz 16-bit audio, got ${rate} Hz ${bits}-bit`)
      const end = Math.min(buf.length, off + 8 + size)
      const n = Math.floor((end - off - 8) / 2 / channels)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2 * channels) / 32768
      return out
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('No audio in the WAV file')
}

// Any recording the browser made (webm, mp4) as 16 kHz mono samples
function decode(file: string): Promise<Float32Array> {
  if (file.endsWith('.wav')) return Promise.resolve().then(() => wavSamples(fs.readFileSync(file)))
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-v', 'error', '-i', file, '-ar', String(RATE), '-ac', '1', '-f', 'f32le', '-'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`ffmpeg couldn't read ${path.basename(file)}: ${err.message}`))
        const b = stdout as Buffer
        resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)).slice())
      })
  })
}

const dot = (a: Print, b: Print) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d }
const best = (p: Print, prints: Print[]) => prints.reduce((m, q) => Math.max(m, dot(p, q)), -1)
const centroid = (prints: Print[]): Print => {
  const n = prints[0]?.length ?? 0
  const sum = new Array(n).fill(0)
  for (const q of prints) for (let i = 0; i < n; i++) sum[i] += q[i]
  const mag = Math.hypot(...sum) || 1
  return sum.map(x => x / mag)
}
// The better of the closest saved print and the centre of that voice — more stable when the glasses mic differs from the laptop sample
export function scoreAgainst(print: Print, prints: Print[]): number {
  if (!prints.length) return -1
  return Math.max(best(print, prints), dot(print, centroid(prints)))
}

const MARGIN = 0.08 // two saved voices this close means we don't know which, so stay unknown
export function pickSaved<T extends { key: string; score: number }>(candidates: T[]): T | null {
  const [top, next] = candidates
  if (!top || top.score < MATCH) return null
  if (next && top.score - next.score < MARGIN) return null
  return top
}
const firstName = (name: string) => name.split(' ')[0]

export function createVoices(o: VoicesOptions) {
  const file = path.join(o.dataDir, 'voices.json')
  const clipsDir = path.join(o.dataDir, 'voice-clips')
  try { fs.rmSync(clipsDir, { recursive: true, force: true }) } catch { /* leftover guest clips */ }
  let store: Store = (() => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Store
      return { people: raw.people ?? {}, patient: raw.patient, guests: [], nextGuest: 1, facts: raw.facts ?? {} }
    } catch { return { people: {}, guests: [], nextGuest: 1, facts: {} } }
  })()
  let saveSoon: ReturnType<typeof setImmediate> | undefined
  const save = () => {
    if (saveSoon) return
    saveSoon = setImmediate(() => { saveSoon = undefined; fs.writeFileSync(file, JSON.stringify(store)) })
  }
  save() // drop any leftover guest list from disk

  let extractor: ((samples: Float32Array) => number[]) | null = o.embed ?? null
  let problem: string | undefined
  if (!extractor) {
    try {
      if (!fs.existsSync(o.modelPath)) throw new Error('The voice model is missing. Run "npm run voice-model", then restart the portal.')
      const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
      const model = new sherpa.SpeakerEmbeddingExtractor({ model: o.modelPath, numThreads: 2 }) as Extractor
      extractor = samples => {
        const s = model.createStream()
        s.acceptWaveform({ samples, sampleRate: RATE })
        return Array.from(model.compute(s))
      }
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err)
    }
  }

  function embed(samples: Float32Array): Print {
    const v = extractor!(samples)
    const n = Math.hypot(...v) || 1
    return v.map(x => x / n)
  }

  // The whole sample, plus 3-second pieces so short sentences have something close to match
  function enrollPrints(samples: Float32Array): Print[] {
    const n = ENROLL_WINDOW_S * RATE
    const prints = [embed(samples)]
    for (let at = 0; at + n <= samples.length; at += n) prints.push(embed(samples.subarray(at, at + n)))
    return prints
  }

  // ---- voiceprints for the people in the care portal ----

  let syncing: Promise<void> | null = null
  function sync(): Promise<void> {
    if (!extractor) return Promise.resolve()
    syncing ??= (async () => {
      const data = o.readData()
      const voiced = [
        ...data.people.map(p => ({ key: p.id, voiceFile: p.voiceFile })),
        ...(data.patient.voiceFile ? [{ key: 'patient', voiceFile: data.patient.voiceFile }] : []),
      ]
      let changed = false
      for (const { key, voiceFile } of voiced) {
        const current = key === 'patient' ? store.patient : store.people[key]
        if (!voiceFile || current?.file === voiceFile) continue
        try {
          const prints = enrollPrints(await decode(path.join(o.uploadsDir, path.basename(voiceFile))))
          const voice = { file: voiceFile, prints: [...(current && current.file !== voiceFile ? current.prints : []), ...prints].slice(0, 40), learned: current?.learned ?? [] }
          if (key === 'patient') store.patient = voice
          else store.people[key] = voice
          changed = true
        } catch (err) {
          console.error('[voices]', err instanceof Error ? err.message : err)
        }
      }
      const ids = new Set(data.people.map(p => p.id))
      for (const id of Object.keys(store.people)) if (!ids.has(id)) { delete store.people[id]; delete store.facts[id]; changed = true }
      if (!data.patient.voiceFile && store.patient) { delete store.patient; changed = true }
      if (changed) { save(); o.notify() }
    })().finally(() => { syncing = null })
    return syncing
  }

  // ---- one clip from the glasses ----

  // Runs alongside transcription; nothing is decided until the clip turns out to contain words
  function prepare(wav: Buffer): Clip {
    if (!extractor) return { print: null, seconds: 0, wav }
    const samples = wavSamples(wav)
    const seconds = samples.length / RATE
    return { print: seconds >= MIN_SECONDS ? embed(samples) : null, seconds, wav }
  }

  let last: { heard: Heard; at: number } | null = null
  // shownAt is set when the glasses first get the card with nothing more important on screen
  let card: { personId: string; heardAt: number; shownAt?: number } | null = null
  const cardShown: Record<string, number> = {}

  function assign(clip: Clip, now = new Date()): Heard {
    if (!extractor) return { speaker: 'unknown', kind: 'unknown' }
    const data = o.readData()
    let heard: Heard

    if (!clip.print) {
      heard = last && now.getTime() - last.at < CARRY_MS ? { ...last.heard, short: true } : { speaker: 'unknown', kind: 'unknown', short: true }
    } else {
      const p = clip.print
      const candidates = [
        ...(store.patient ? [{ key: 'patient', score: scoreAgainst(p, [...store.patient.prints, ...store.patient.learned]) }] : []),
        ...Object.entries(store.people).map(([key, v]) => ({ key, score: scoreAgainst(p, [...v.prints, ...v.learned]) })),
      ].sort((a, b) => b.score - a.score)
      const top = pickSaved(candidates)
      const nearest = candidates[0]
      const person = top && data.people.find(x => x.id === top.key)

      if (top && (top.key === 'patient' || person)) {
        const voice = top.key === 'patient' ? store.patient! : store.people[top.key]
        if (top.score >= LEARN_ABOVE) voice.learned = [...voice.learned, p].slice(-MAX_LEARNED)
        heard = top.key === 'patient'
          ? { speaker: data.patient.name || 'patient', kind: 'patient', score: top.score }
          : { speaker: person!.name, kind: 'person', personId: person!.id, score: top.score }
      } else {
        const closestName = nearest && (nearest.key === 'patient' ? data.patient.name : data.people.find(x => x.id === nearest.key)?.name)
        heard = { speaker: 'unknown', kind: 'unknown', ...(nearest && closestName ? { closest: { speaker: closestName, score: nearest.score } } : {}) }
      }
      save()
    }

    if (heard.kind === 'person' && heard.personId) {
      const shown = cardShown[heard.personId] ?? 0
      if (now.getTime() - shown > CARD_AGAIN_MS) {
        card = { personId: heard.personId, heardAt: now.getTime() }
        cardShown[heard.personId] = now.getTime()
      }
      scheduleFact(heard.personId)
    }
    last = { heard, at: now.getTime() }
    return heard
  }

  function nameGuest(_guestId: string, _details: { name: string; relation: string; blurb?: string }): Person {
    throw new Error('There are no guest voices. Add the person in the care portal with a voice sample.')
  }

  function forgetGuest(_guestId: string) {}

  // ---- one recent fact for the glasses card ----

  const factTimers: Record<string, NodeJS.Timeout> = {}
  function scheduleFact(personId: string, delay = FACT_DELAY_MS) {
    if (!o.groqKey) return
    clearTimeout(factTimers[personId])
    factTimers[personId] = setTimeout(() => {
      delete factTimers[personId]
      refreshFact(personId).catch(err => console.error('[voices] recent fact failed:', String(err)))
    }, store.facts[personId] ? delay : 0)
  }

  async function refreshFact(personId: string) {
    const person = o.readData().people.find(p => p.id === personId)
    if (!person) return
    const since = Date.now() - 14 * 86_400_000
    const said = o.lines().filter(l => l.speaker === person.name && Date.parse(l.at) > since).slice(-15)
    const plans = o.plans()
      .filter(p => p.status === 'confirmed' && p.who.some(w => firstName(w).toLowerCase() === firstName(person.name).toLowerCase()) && Date.parse(p.start) > Date.now() - 86_400_000)
      .slice(0, 3)
    if (!said.length && !plans.length) return
    const { fact } = await chatJson<{ fact: string }>(o.groqKey, FACT_PROMPT, [
      `Person: ${person.name} (${person.relation})`,
      `About them, from the family: ${person.blurb || 'nothing'}`,
      `Plans with them: ${plans.length ? plans.map(p => `${p.activity} on ${new Date(p.start).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' })}`).join('; ') : 'none'}`,
      `What they said recently:\n${said.map(l => `- ${l.text}`).join('\n') || '- nothing'}`,
    ].join('\n'), 'recent_fact', FACT_SCHEMA)
    const text = fact.trim().replace(/\.$/, '')
    if (!text) return
    store.facts[personId] = { text: text.slice(0, 70), at: new Date().toISOString() }
    save()
  }

  // blocked: a calendar question or answer is on the glasses, so the card waits its turn
  function cardFor(now = Date.now(), blocked = false): VoiceCard | null {
    if (!card) return null
    if (!card.shownAt) {
      if (now - card.heardAt > CARD_WAIT_MS) { card = null; return null }
      if (blocked) return null
      card.shownAt = now
    }
    if (now - card.shownAt > CARD_MS) return null
    const person = o.readData().people.find(p => p.id === card!.personId)
    if (!person) return null
    const fact = store.facts[person.id]?.text || person.blurb.split(/(?<=[.!?])\s/)[0]?.replace(/\.$/, '') || ''
    return { name: person.name, relation: person.relation, fact }
  }

  function status(): VoiceStatus {
    const data = o.readData()
    return {
      ready: Boolean(extractor),
      ...(problem ? { problem } : {}),
      patientEnrolled: Boolean(store.patient),
      enrolled: data.people.filter(p => store.people[p.id]).map(p => p.id),
      guests: [],
    }
  }

  const clipFile = (_guestId: string) => null

  return { ready: () => Boolean(extractor), sync, prepare, assign, nameGuest, forgetGuest, card: cardFor, status, clipFile, guests: () => [] }
}

export type Voices = ReturnType<typeof createVoices>

const FACT_PROMPT = `You pick one short fact to show on a person with memory loss's glasses when a family member or friend starts talking to them, so they remember what is going on in that person's life.
Use only what is given: their recent words, plans with them, and the family's note. Prefer something recent and concrete ("Coming to the park Saturday", "Just started a new job").
Write it as a short phrase about them, under 40 characters, no names, no quotes. If nothing recent is worth showing, return an empty string.
Never mention health, medicine or anything worrying.`

const FACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fact'],
  properties: { fact: { type: 'string' } },
}