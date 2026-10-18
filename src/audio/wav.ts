const TARGET_PEAK = 16000
const MAX_GAIN = 8

// Whisper reads quiet recordings less accurately. Lift a quiet clip towards a healthy level;
// clips that are already loud are left alone.
export function boostQuiet(pcm: Uint8Array): Uint8Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2))
  let peak = 0
  for (let i = 0; i < view.byteLength; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)))
  if (peak === 0 || peak >= TARGET_PEAK / 2) return pcm
  const gain = Math.min(MAX_GAIN, TARGET_PEAK / peak)
  const out = new Uint8Array(pcm.byteLength)
  const o = new DataView(out.buffer)
  for (let i = 0; i < view.byteLength; i += 2) o.setInt16(i, Math.round(view.getInt16(i, true) * gain), true)
  return out
}

// Wraps raw 16-bit little-endian mono PCM in a WAV header so Groq can read it
export function pcmToWav(pcm: Uint8Array, sampleRate = 16000): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength)
  const v = new DataView(out.buffer)
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)) }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + pcm.byteLength, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true) // fmt chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // bytes per second
  v.setUint16(32, 2, true) // bytes per sample frame
  v.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  v.setUint32(40, pcm.byteLength, true)
  out.set(pcm, 44)
  return out
}
