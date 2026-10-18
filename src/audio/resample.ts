// Browser microphones run at 44.1 or 48 kHz; HALO's audio path is 16 kHz, 16-bit mono PCM.
// Feed blocks in order: the position inside the next block carries over between calls.

export const PCM_RATE = 16000

export class Downsampler {
  private pos = 0
  private readonly fromRate: number
  constructor(fromRate: number) { this.fromRate = fromRate }

  // Averages each run of input samples down to one output sample
  push(input: Float32Array): Uint8Array {
    const step = this.fromRate / PCM_RATE
    const out: number[] = []
    let pos = this.pos
    while (pos + step <= input.length) {
      const from = Math.max(0, Math.floor(pos))
      const to = Math.max(from + 1, Math.floor(pos + step))
      let sum = 0
      for (let i = from; i < to; i++) sum += input[i]
      out.push(sum / (to - from))
      pos += step
    }
    this.pos = pos - input.length
    const bytes = new Uint8Array(out.length * 2)
    const view = new DataView(bytes.buffer)
    out.forEach((s, i) => view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(s * 32767))), true))
    return bytes
  }
}
