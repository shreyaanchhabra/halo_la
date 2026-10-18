import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Downsampler } from './resample.ts'

const samples = (bytes: Uint8Array) => {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 2 }, (_, i) => v.getInt16(i * 2, true))
}

test('48 kHz in 128-sample blocks comes out as 16 kHz with nothing lost between blocks', () => {
  const d = new Downsampler(48000)
  let out = 0
  for (let b = 0; b < 375; b++) out += d.push(new Float32Array(128).fill(0.5)).byteLength / 2 // 1 second
  assert.equal(out, 16000)
})

test('44.1 kHz comes out at 16 kHz, give or take a sample', () => {
  const d = new Downsampler(44100)
  let out = 0
  for (let b = 0; b < 44100 / 147; b++) out += d.push(new Float32Array(147).fill(0)).byteLength / 2
  assert.ok(Math.abs(out - 16000) <= 1)
})

test('levels survive, clipped to 16 bits', () => {
  const d = new Downsampler(48000)
  assert.deepEqual(samples(d.push(new Float32Array([0.5, 0.5, 0.5, -1, -1, -1, 2, 2, 2]))), [16384, -32767, 32767])
})
