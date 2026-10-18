// Cuts a continuous 16 kHz, 16-bit, mono PCM stream (the G2 microphone) into utterances:
// one per stretch of speech, ended by a pause. Silence is never emitted.
//
// The mic's level isn't known ahead of time, so nothing here is tied to an absolute loudness.
// The background noise level is measured continuously (a low percentile of the last few
// seconds), and speech is whatever is clearly louder than that.

export type SegmenterOptions = {
  sampleRate: number
  frameMs: number // analysis window
  minRms: number // never treat anything quieter than this as speech (int16 scale, full scale 32768)
  startRatio: number // to start an utterance, a frame must be this many times louder than the background
  sustainRatio: number // once talking, a frame this much louder than the background counts as still talking
  startFrames: number // consecutive loud frames that count as speech starting
  calibrationMs: number // listen to the room this long before the first utterance can start
  noiseWindowMs: number // how far back the background level is measured
  noisePercentile: number // 0-1: the background is the level that this share of recent frames sit below
  endSilenceMs: number // pause that ends an utterance
  keepTailMs: number // how much of that pause to keep at the end of the clip
  preRollMs: number // audio kept from before speech was noticed, so the first syllable isn't clipped
  minSpeechMs: number // shorter than this is a cough or a click, and is dropped
  maxUtteranceMs: number // cut a monologue here
  partialAfterMs: number // fire onPartial once when speech has lasted this long; 0 means never
}

export const DEFAULT_OPTIONS: SegmenterOptions = {
  sampleRate: 16000,
  frameMs: 20,
  minRms: 100,
  startRatio: 3,
  sustainRatio: 2,
  startFrames: 3,
  calibrationMs: 500,
  noiseWindowMs: 4000,
  noisePercentile: 0.25,
  endSilenceMs: 650,
  keepTailMs: 200,
  preRollMs: 300,
  minSpeechMs: 250,
  maxUtteranceMs: 15000,
  partialAfterMs: 0,
}

export type SegmenterStats = {
  noiseFloor: number // background level, RMS
  startThreshold: number // a frame louder than this can start speech
  lastRms: number
  peakRms: number // loudest frame since the last stats read
  calibrating: boolean
  utterances: number
  dropped: number // too short to be speech
}

const NOISE_FLOOR_MIN = 10

function frameRms(frame: Uint8Array): number {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const n = Math.floor(frame.byteLength / 2)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true)
    sum += s * s
  }
  return Math.sqrt(sum / n)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}

export class UtteranceSegmenter {
  private readonly o: SegmenterOptions
  private readonly frameBytes: number
  private readonly onUtterance: (pcm: Uint8Array) => void
  private readonly onPartial?: (pcm: Uint8Array) => void
  private partialSent = false

  private leftover: Uint8Array = new Uint8Array(0)
  private recent: number[] = [] // RMS of recent frames outside utterances
  private framesSeen = 0
  private noiseFloor = NOISE_FLOOR_MIN
  private preRoll: Uint8Array[] = []
  private current: Uint8Array[] | null = null
  private voicedRun = 0
  private voicedMs = 0
  private silenceMs = 0
  private lastRms = 0
  private peakRms = 0
  private utterances = 0
  private dropped = 0

  constructor(onUtterance: (pcm: Uint8Array) => void, options: Partial<SegmenterOptions> & { onPartial?: (pcm: Uint8Array) => void } = {}) {
    this.o = { ...DEFAULT_OPTIONS, ...options }
    this.onUtterance = onUtterance
    this.onPartial = options.onPartial
    this.frameBytes = Math.round((this.o.sampleRate * this.o.frameMs) / 1000) * 2
  }

  // Feed audio as it arrives, in chunks of any size
  push(chunk: Uint8Array) {
    let data = this.leftover.byteLength ? concat([this.leftover, chunk]) : chunk
    while (data.byteLength >= this.frameBytes) {
      this.frame(data.slice(0, this.frameBytes))
      data = data.subarray(this.frameBytes)
    }
    this.leftover = data.slice()
  }

  // Call when listening stops, so an utterance in progress isn't lost
  flush() {
    if (this.current) this.finish()
    this.leftover = new Uint8Array(0)
    this.preRoll = []
    this.voicedRun = 0
  }

  stats(): SegmenterStats {
    const s: SegmenterStats = {
      noiseFloor: Math.round(this.noiseFloor),
      startThreshold: Math.round(this.startThreshold()),
      lastRms: Math.round(this.lastRms),
      peakRms: Math.round(this.peakRms),
      calibrating: this.calibrating(),
      utterances: this.utterances,
      dropped: this.dropped,
    }
    this.peakRms = 0
    return s
  }

  private calibrating() { return this.framesSeen * this.o.frameMs < this.o.calibrationMs }
  private startThreshold() { return Math.max(this.o.minRms, this.noiseFloor * this.o.startRatio) }
  private sustainThreshold() { return Math.max(this.o.minRms, this.noiseFloor * this.o.sustainRatio) }

  private updateNoiseFloor(rms: number) {
    this.recent.push(rms)
    const max = Math.round(this.o.noiseWindowMs / this.o.frameMs)
    if (this.recent.length > max) this.recent.shift()
    // Re-measure a few times a second, not on every frame
    if (this.framesSeen % 5 === 0) {
      const sorted = [...this.recent].sort((a, b) => a - b)
      this.noiseFloor = Math.max(NOISE_FLOOR_MIN, sorted[Math.floor((sorted.length - 1) * this.o.noisePercentile)])
    }
  }

  private frame(frame: Uint8Array) {
    const o = this.o
    const rms = frameRms(frame)
    this.framesSeen++
    this.lastRms = rms
    this.peakRms = Math.max(this.peakRms, rms)

    if (!this.current) {
      this.updateNoiseFloor(rms)
      this.preRoll.push(frame)
      const keep = Math.ceil(o.preRollMs / o.frameMs) + o.startFrames
      if (this.preRoll.length > keep) this.preRoll.shift()
      if (this.calibrating()) return
      this.voicedRun = rms > this.startThreshold() ? this.voicedRun + 1 : 0
      if (this.voicedRun >= o.startFrames) {
        this.current = this.preRoll
        this.preRoll = []
        this.voicedMs = this.voicedRun * o.frameMs
        this.silenceMs = 0
      }
      return
    }

    // The background level is held while someone is talking, so speech can't raise it
    this.current.push(frame)
    if (rms > this.sustainThreshold()) { this.voicedMs += o.frameMs; this.silenceMs = 0 } else this.silenceMs += o.frameMs
    if (!this.partialSent && o.partialAfterMs > 0 && this.current.length * o.frameMs >= o.partialAfterMs) {
      this.partialSent = true
      this.onPartial?.(concat(this.current))
    }
    if (this.silenceMs >= o.endSilenceMs || this.current.length * o.frameMs >= o.maxUtteranceMs) this.finish()
  }

  private finish() {
    const o = this.o
    const frames = this.current!
    const trim = Math.max(0, Math.floor((this.silenceMs - o.keepTailMs) / o.frameMs))
    const kept = trim ? frames.slice(0, frames.length - trim) : frames
    if (this.voicedMs >= o.minSpeechMs) { this.utterances++; this.onUtterance(concat(kept)) } else this.dropped++
    this.current = null
    this.voicedRun = 0
    this.voicedMs = 0
    this.silenceMs = 0
    this.partialSent = false
  }
}
