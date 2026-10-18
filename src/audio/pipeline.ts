import { UtteranceSegmenter, type SegmenterOptions, type SegmenterStats } from './segmenter.ts'
import { boostQuiet, pcmToWav } from './wav.ts'

export type PipelineStats = SegmenterStats & {
  chunks: number // audio events received
  queued: number // clips waiting to upload
  sent: number
  failed: number
  droppedBacklog: number
}

type Options = {
  send: (wav: Uint8Array) => Promise<void>
  onPartial?: (wav: Uint8Array) => void // 1.2 s of speech, so the glasses can ask who before the sentence ends
  segmenter?: Partial<SegmenterOptions>
  maxQueue?: number
  retryDelaysMs?: number[] // waits before each retry of a failed upload
  onError?: (err: unknown) => void
}

// Mic audio in -> utterances -> uploads, one at a time and in the order they were spoken,
// so "I'll come Saturday at 2" always reaches the server before the "yes" that follows it.
export class AudioPipeline {
  private readonly segmenter: UtteranceSegmenter
  private readonly send: Options['send']
  private readonly maxQueue: number
  private readonly retryDelaysMs: number[]
  private readonly onError: (err: unknown) => void
  private queue: Uint8Array[] = []
  private busy = false
  private chunks = 0
  private sent = 0
  private failed = 0
  private droppedBacklog = 0
  private idle: (() => void)[] = []

  constructor(o: Options) {
    this.send = o.send
    this.maxQueue = o.maxQueue ?? 5
    this.retryDelaysMs = o.retryDelaysMs ?? [1500, 3000]
    this.onError = o.onError ?? (() => {})
    this.segmenter = new UtteranceSegmenter(pcm => this.enqueue(pcm), {
      ...o.segmenter,
      partialAfterMs: o.onPartial ? 800 : 0,
      onPartial: o.onPartial ? pcm => o.onPartial!(pcmToWav(boostQuiet(pcm))) : undefined,
    })
  }

  push(pcm: Uint8Array) {
    this.chunks++
    this.segmenter.push(pcm)
  }

  // Listening stopped: finish any utterance in progress
  flush() {
    this.segmenter.flush()
  }

  stats(): PipelineStats {
    return { ...this.segmenter.stats(), chunks: this.chunks, queued: this.queue.length, sent: this.sent, failed: this.failed, droppedBacklog: this.droppedBacklog }
  }

  // Resolves when everything queued so far has been sent (or failed)
  drained(): Promise<void> {
    return this.busy || this.queue.length ? new Promise(r => this.idle.push(r)) : Promise.resolve()
  }

  private enqueue(pcm: Uint8Array) {
    this.queue.push(pcmToWav(boostQuiet(pcm)))
    // If the server is unreachable for a long time, keep the newest clips, not a stale pile
    while (this.queue.length > this.maxQueue) { this.queue.shift(); this.droppedBacklog++ }
    void this.pump()
  }

  private async pump() {
    if (this.busy) return
    this.busy = true
    try {
      for (let wav = this.queue.shift(); wav; wav = this.queue.shift()) {
        // A busy server or a brief network drop shouldn't lose what was said: try again before giving up
        for (let attempt = 0; ; attempt++) {
          try {
            await this.send(wav)
            this.sent++
            break
          } catch (err) {
            if (attempt < this.retryDelaysMs.length) { await new Promise(r => setTimeout(r, this.retryDelaysMs[attempt])); continue }
            this.failed++
            this.onError(err)
            break
          }
        }
      }
    } finally {
      this.busy = false
      for (const r of this.idle.splice(0)) r()
    }
  }
}
