import { AudioPipeline } from '../../src/audio/pipeline.ts'
import { Downsampler } from '../../src/audio/resample.ts'
import { postAudio, postWho } from './api'
import type { HeardClip } from './types'

// The browser's microphone, handled like the glasses mic: cut into utterances at pauses, each sent
// to /api/audio as a 16 kHz WAV, where it is transcribed and matched against the saved voice samples.

// Runs on the audio thread and hands each block of samples to the page
const TAP = `
class HaloTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('halo-tap', HaloTap)`

export type LiveAudio = { stop: () => Promise<void> }

export async function startWhoAudio(o: {
  onHeard: (clip: HeardClip) => void
  onError?: (err: unknown) => void
}): Promise<LiveAudio> {
  return startLiveAudio({
    ...o,
    send: wav => postWho(wav),
  })
}

export async function startLiveAudio(o: {
  onHeard: (clip: HeardClip) => void
  onSending?: () => void
  onError?: (err: unknown) => void
  send?: (wav: Uint8Array) => Promise<HeardClip>
}): Promise<LiveAudio> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
  const ctx = new AudioContext()
  const url = URL.createObjectURL(new Blob([TAP], { type: 'application/javascript' }))
  await ctx.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)

  const pipeline = new AudioPipeline({
    send: async wav => {
      o.onSending?.()
      const clip = await (o.send ?? postAudio)(wav)
      if (clip.kind !== 'silence') o.onHeard(clip)
    },
    onError: o.onError,
  })

  const source = ctx.createMediaStreamSource(stream)
  const tap = new AudioWorkletNode(ctx, 'halo-tap')
  const mute = ctx.createGain()
  mute.gain.value = 0
  const down = new Downsampler(ctx.sampleRate)
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => pipeline.push(down.push(e.data))
  // The tap only runs while connected to the speakers; the gain of 0 keeps it silent
  source.connect(tap).connect(mute).connect(ctx.destination)

  return {
    async stop() {
      source.disconnect()
      tap.disconnect()
      stream.getTracks().forEach(t => t.stop())
      pipeline.flush()
      await ctx.close()
      await pipeline.drained()
    },
  }
}

// "Maya · match 82%", or "Unknown voice"
export function matchLabel(clip: HeardClip): string {
  const m = clip.match
  if (!m || m.kind === 'unknown' || !m.kind || m.kind === 'guest') return m?.short ? 'Too short to tell' : 'Unknown voice'
  const pct = (s?: number) => (s == null ? '' : ` ${Math.round(s * 100)}%`)
  if (m.short) return `${m.speaker} (short, same speaker as before)`
  return `${m.speaker}${m.kind === 'patient' ? ' (patient)' : ''} · match${pct(m.score)}`
}
