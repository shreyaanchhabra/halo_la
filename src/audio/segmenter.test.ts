import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { UtteranceSegmenter } from './segmenter.ts'
import { boostQuiet, pcmToWav } from './wav.ts'

const RATE = 16000

// A tone stands in for speech; deterministic noise stands in for the room
function tone(ms: number, amp = 4000): Uint8Array {
  const n = (RATE * ms) / 1000
  const out = new Uint8Array(n * 2)
  const v = new DataView(out.buffer)
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / RATE)), true)
  return out
}
function quiet(ms: number, amp = 40): Uint8Array {
  const n = (RATE * ms) / 1000
  const out = new Uint8Array(n * 2)
  const v = new DataView(out.buffer)
  let seed = 12345
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    v.setInt16(i * 2, Math.round(((seed / 0x7fffffff) * 2 - 1) * amp), true)
  }
  return out
}
const join = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0))
  let at = 0
  for (const x of p) { out.set(x, at); at += x.length }
  return out
}
const ms = (pcm: Uint8Array) => (pcm.length / 2 / RATE) * 1000

function run(stream: Uint8Array, chunkBytes = 3200, opts = {}) {
  const got: Uint8Array[] = []
  const seg = new UtteranceSegmenter(u => got.push(u), opts)
  for (let i = 0; i < stream.length; i += chunkBytes) seg.push(stream.subarray(i, i + chunkBytes))
  seg.flush()
  return got
}

describe('utterance segmenter', () => {
  test('two sentences with a pause between them become two utterances', () => {
    const got = run(join(quiet(1000), tone(1500), quiet(1500), tone(1000), quiet(1500)))
    assert.equal(got.length, 2)
    assert.ok(Math.abs(ms(got[0]) - 2000) < 700, `first is about 1.5s speech plus padding, got ${ms(got[0])}ms`)
  })

  test('a short breath inside a sentence does not split it', () => {
    const got = run(join(quiet(500), tone(800), quiet(400), tone(800), quiet(1500)))
    assert.equal(got.length, 1)
  })

  test('a longer pause ends the utterance', () => {
    const got = run(join(quiet(500), tone(800), quiet(800), tone(800), quiet(1500)))
    assert.equal(got.length, 2)
  })

  test('background noise alone produces nothing', () => {
    assert.equal(run(quiet(10000, 120)).length, 0)
  })

  test('a cough or a click is dropped', () => {
    assert.equal(run(join(quiet(1000), tone(100), quiet(2000))).length, 0)
  })

  test('the first syllable is not clipped', () => {
    const got = run(join(quiet(1000), tone(1000), quiet(1500)))
    assert.ok(ms(got[0]) >= 1000 + 200, `clip is ${ms(got[0])}ms, expected speech plus lead-in`)
  })

  test('trailing silence is trimmed, not sent', () => {
    const got = run(join(quiet(500), tone(1000), quiet(3000)))
    assert.ok(ms(got[0]) < 1000 + 300 + 300 + 100, `clip is ${ms(got[0])}ms`)
  })

  test('result does not depend on how the stream is chunked', () => {
    const stream = join(quiet(1000), tone(1500), quiet(1500), tone(1000), quiet(1500))
    const a = run(stream, 3200)
    for (const size of [1, 37, 641, 1000, 8000]) {
      const b = run(stream, size)
      assert.equal(b.length, a.length, `chunk ${size}`)
      assert.deepEqual(b.map(x => x.length), a.map(x => x.length), `chunk ${size}`)
    }
  })

  test('someone talking non-stop is cut at the maximum length', () => {
    const got = run(join(quiet(500), tone(40000), quiet(1500)))
    assert.ok(got.length >= 3)
    for (const u of got) assert.ok(ms(u) <= 15200, `${ms(u)}ms`)
  })

  test('a noisy room still separates speech from background', () => {
    const got = run(join(quiet(1500, 700), tone(1500, 6000), quiet(2000, 700), tone(1000, 6000), quiet(1500, 700)))
    assert.equal(got.length, 2)
  })

  test('flush emits an utterance that was still in progress', () => {
    const got = run(join(quiet(500), tone(1000)))
    assert.equal(got.length, 1)
  })
})

describe('segmenter across microphones and rooms', () => {
  const sweep: [string, number, number, number][] = [
    // label, speech amplitude, room noise amplitude, utterances expected
    ['very quiet mic, quiet room', 400, 10, 2],
    ['quiet mic, normal room', 1500, 60, 2],
    ['normal mic, normal room', 6000, 120, 2],
    ['hot mic, normal room', 30000, 120, 2],
    ['normal mic, noisy room (noise ~ 1000)', 6000, 1700, 2],
    ['quiet mic, noisy room', 3000, 700, 2],
  ]
  for (const [label, speech, noise, expected] of sweep) {
    test(label, () => {
      const got = run(join(quiet(2000, noise), tone(1500, speech), quiet(1500, noise), tone(900, speech), quiet(1500, noise)))
      assert.equal(got.length, expected)
    })
  }

  test('a room that gets louder part-way through is tracked', () => {
    const got = run(join(quiet(2000, 50), tone(1200, 5000), quiet(1500, 50), quiet(6000, 900), tone(1200, 9000), quiet(1500, 900)))
    assert.equal(got.length, 2)
  })

  test('stats report the background level and what was found', () => {
    const seg = new UtteranceSegmenter(() => {})
    const s = join(quiet(2000, 100), tone(1000, 5000), quiet(1500, 100))
    for (let i = 0; i < s.length; i += 3200) seg.push(s.subarray(i, i + 3200))
    const st = seg.stats()
    assert.equal(st.utterances, 1)
    assert.ok(st.noiseFloor > 20 && st.noiseFloor < 150, `noise floor ${st.noiseFloor}`)
    assert.ok(st.peakRms > 2000)
    assert.equal(st.calibrating, false)
  })

  test('speech right at the start, before calibration ends, is not lost entirely', () => {
    const got = run(join(tone(1500, 5000), quiet(1500, 60), tone(1500, 5000), quiet(1500, 60)))
    assert.ok(got.length >= 1)
  })
})

describe('boostQuiet', () => {
  const peakOf = (p: Uint8Array) => { const v = new DataView(p.buffer, p.byteOffset, p.byteLength); let m = 0; for (let i = 0; i < p.length; i += 2) m = Math.max(m, Math.abs(v.getInt16(i, true))); return m }
  test('lifts a quiet clip', () => assert.ok(peakOf(boostQuiet(tone(500, 800))) > 5000))
  test('never boosts by more than 8x', () => assert.ok(peakOf(boostQuiet(tone(500, 100))) <= 800 + 1))
  test('leaves a healthy clip untouched', () => { const p = tone(500, 12000); assert.equal(boostQuiet(p), p) })
  test('leaves silence alone', () => { const p = new Uint8Array(3200); assert.equal(boostQuiet(p), p) })
})

describe('wav', () => {
  test('header describes 16 kHz mono 16-bit PCM and the data follows', () => {
    const pcm = tone(100)
    const wav = pcmToWav(pcm)
    const v = new DataView(wav.buffer)
    const text = (at: number, n: number) => String.fromCharCode(...wav.subarray(at, at + n))
    assert.equal(text(0, 4), 'RIFF')
    assert.equal(text(8, 4), 'WAVE')
    assert.equal(v.getUint32(24, true), 16000)
    assert.equal(v.getUint16(22, true), 1)
    assert.equal(v.getUint16(34, true), 16)
    assert.equal(v.getUint32(40, true), pcm.length)
    assert.equal(wav.length, 44 + pcm.length)
    assert.deepEqual(wav.subarray(44), pcm)
  })
})
