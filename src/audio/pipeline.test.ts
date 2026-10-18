import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { AudioPipeline } from './pipeline.ts'

const RATE = 16000
const tone = (ms: number, amp = 5000) => {
  const n = (RATE * ms) / 1000
  const out = new Uint8Array(n * 2)
  const v = new DataView(out.buffer)
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / RATE)), true)
  return out
}
const hiss = (ms: number, amp = 60) => {
  const n = (RATE * ms) / 1000
  const out = new Uint8Array(n * 2)
  const v = new DataView(out.buffer)
  let seed = 99
  for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; v.setInt16(i * 2, Math.round(((seed / 0x7fffffff) * 2 - 1) * amp), true) }
  return out
}
const feed = (p: AudioPipeline, ...parts: Uint8Array[]) => {
  for (const part of parts) for (let i = 0; i < part.length; i += 3200) p.push(part.subarray(i, i + 3200)) // 100 ms events, like the glasses
}
const dataLen = (wav: Uint8Array) => new DataView(wav.buffer, wav.byteOffset).getUint32(40, true)

describe('audio pipeline', () => {
  test('speech goes out as WAV files, silence does not', async () => {
    const sent: Uint8Array[] = []
    const p = new AudioPipeline({ send: async w => { sent.push(w) } })
    feed(p, hiss(2000), tone(1500), hiss(1500), tone(900), hiss(1500))
    await p.drained()
    assert.equal(sent.length, 2)
    assert.equal(String.fromCharCode(...sent[0].subarray(0, 4)), 'RIFF')
    assert.equal(p.stats().sent, 2)
  })

  test('clips are sent one at a time, in the order they were spoken', async () => {
    const order: number[] = []
    let inFlight = 0
    let overlapped = false
    const p = new AudioPipeline({
      send: async w => {
        inFlight++
        if (inFlight > 1) overlapped = true
        order.push(dataLen(w))
        await new Promise(r => setTimeout(r, 30))
        inFlight--
      },
    })
    feed(p, hiss(2000), tone(2000), hiss(1500), tone(800), hiss(1500), tone(1200), hiss(1500))
    await p.drained()
    assert.equal(overlapped, false)
    assert.ok(order[0] > order[1] && order[2] > order[1], `lengths ${order}`)
  })

  test('one failed upload does not stop the next', async () => {
    let n = 0
    const errors: unknown[] = []
    const p = new AudioPipeline({ retryDelaysMs: [], send: async () => { if (n++ === 0) throw new Error('offline') }, onError: e => errors.push(e) })
    feed(p, hiss(2000), tone(1200), hiss(1500), tone(1200), hiss(1500))
    await p.drained()
    assert.equal(p.stats().failed, 1)
    assert.equal(p.stats().sent, 1)
    assert.equal(errors.length, 1)
  })

  test('a failed upload is retried, so a busy server does not lose what was said', async () => {
    let tries = 0
    const p = new AudioPipeline({ retryDelaysMs: [0, 0], send: async () => { if (++tries < 3) throw new Error('429') } })
    feed(p, hiss(2000), tone(1200), hiss(1500))
    await p.drained()
    assert.equal(tries, 3)
    assert.equal(p.stats().sent, 1)
    assert.equal(p.stats().failed, 0)
  })

  test('it gives up after the retries and says so', async () => {
    let tries = 0
    const errors: unknown[] = []
    const p = new AudioPipeline({ retryDelaysMs: [0, 0], send: async () => { tries++; throw new Error('down') }, onError: e => errors.push(e) })
    feed(p, hiss(2000), tone(1200), hiss(1500))
    await p.drained()
    assert.equal(tries, 3)
    assert.equal(p.stats().failed, 1)
    assert.equal(errors.length, 1)
  })

  test('a long outage keeps only the newest clips', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const sent: number[] = []
    const p = new AudioPipeline({ maxQueue: 2, retryDelaysMs: [], send: async w => { await gate; sent.push(dataLen(w)) } })
    feed(p, hiss(1000))
    for (let i = 0; i < 6; i++) feed(p, tone(600 + i * 100), hiss(1000))
    release()
    await p.drained()
    assert.ok(p.stats().droppedBacklog >= 3, `dropped ${p.stats().droppedBacklog}`)
    assert.ok(sent.length <= 3)
  })

  test('very quiet speech is lifted before it is sent', async () => {
    const sent: Uint8Array[] = []
    const p = new AudioPipeline({ send: async w => { sent.push(w) } })
    feed(p, hiss(2000, 8), tone(1500, 600), hiss(1500, 8))
    await p.drained()
    assert.equal(sent.length, 1)
    const v = new DataView(sent[0].buffer, sent[0].byteOffset)
    let peak = 0
    for (let i = 44; i < sent[0].length; i += 2) peak = Math.max(peak, Math.abs(v.getInt16(i, true)))
    assert.ok(peak > 3000, `peak ${peak}`)
  })

  test('a who-prefix goes out once after 0.8 s of speech, then the full clip at the end', async () => {
    const partials: number[] = []
    const sent: number[] = []
    const p = new AudioPipeline({
      send: async w => { sent.push(dataLen(w)) },
      onPartial: w => { partials.push(dataLen(w)) },
    })
    feed(p, hiss(2000), tone(300))
    assert.equal(partials.length, 0)
    feed(p, tone(400))
    assert.equal(partials.length, 1)
    feed(p, tone(200))
    assert.equal(partials.length, 1)
    feed(p, hiss(1500))
    await p.drained()
    assert.equal(sent.length, 1)
    assert.ok(sent[0] > partials[0], `full ${sent[0]} vs prefix ${partials[0]}`)
  })

  test('flush sends an utterance that was still being spoken', async () => {
    const sent: Uint8Array[] = []
    const p = new AudioPipeline({ send: async w => { sent.push(w) } })
    feed(p, hiss(2000), tone(1000))
    p.flush()
    await p.drained()
    assert.equal(sent.length, 1)
  })
})
