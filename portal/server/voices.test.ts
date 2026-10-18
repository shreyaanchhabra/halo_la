import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createVoices, pickSaved, scoreAgainst, wavSamples } from './voices.ts'
import type { HaloData, VoiceGuest } from '../src/types.ts'

// Each fake voice is a constant level; the fake model turns the level into a direction,
// so the same voice always matches itself and different voices never match.
const VOICES = { maya: 0.1, dhruv: 0.2, raj: 0.3, meena: 0.4 }
const fakeEmbed = (s: Float32Array) => {
  const v = new Array(8).fill(0)
  v[Math.round(Math.abs(s[0]) * 10)] = 1
  return v
}

function wav(level: number, seconds: number): Buffer {
  const n = Math.round(seconds * 16000)
  const out = Buffer.alloc(44 + n * 2)
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVE', 8)
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22)
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34)
  out.write('data', 36); out.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(level * 32767), 44 + i * 2)
  return out
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-voices-'))
  const uploads = path.join(dir, 'uploads')
  fs.mkdirSync(uploads)
  fs.writeFileSync(path.join(uploads, 'maya.wav'), wav(VOICES.maya, 6))
  fs.writeFileSync(path.join(uploads, 'dhruv.wav'), wav(VOICES.dhruv, 6))
  let data: HaloData = {
    patient: { name: 'Dhruv Sehgal', voiceFile: 'dhruv.wav' },
    people: [{ id: 'p1', name: 'Maya', relation: 'granddaughter', blurb: 'Studies art in Chicago. Visits on Sundays.', voiceFile: 'maya.wav', createdAt: '' }],
    prescriptions: [],
  }
  const renamed: [string, string][] = []
  const asked: VoiceGuest[] = []
  const voices = createVoices({
    modelPath: '', dataDir: dir, uploadsDir: uploads, groqKey: '',
    readData: () => data, saveData: d => { data = d },
    lines: () => [], plans: () => [],
    renameSpeaker: (from, to) => renamed.push([from, to]),
    notify: () => {},
    onGuestReady: g => asked.push(g),
    embed: fakeEmbed,
  })
  await voices.sync()
  const hear = (level: number, seconds: number, at: Date) => voices.assign(voices.prepare(wav(level, seconds)), at)
  return { dir, voices, hear, renamed, asked, data: () => data }
}

test('the closest saved voice wins only when it is clearly ahead of the others', () => {
  assert.equal(pickSaved([{ key: 'maya', score: 0.9 }, { key: 'dhruv', score: 0.2 }])?.key, 'maya')
  assert.equal(pickSaved([{ key: 'maya', score: 0.38 }, { key: 'dhruv', score: 0.1 }])?.key, 'maya')
  assert.equal(pickSaved([{ key: 'maya', score: 0.34 }, { key: 'dhruv', score: 0.33 }]), null)
  assert.equal(pickSaved([{ key: 'maya', score: 0.2 }]), null)
})

test('a print scores 1 against copies of itself, using the centroid as well as the best match', () => {
  const p = [1, 0, 0, 0]
  assert.equal(scoreAgainst(p, [p, p]), 1)
})

test('a 1.0 s clip of an enrolled voice is long enough to recognize', async () => {
  const { voices, hear } = await setup()
  const clip = voices.prepare(wav(VOICES.maya, 1))
  assert.ok(clip.print)
  const t = new Date('2026-10-17T15:00:00')
  assert.equal(hear(VOICES.maya, 1, t).speaker, 'Maya')
})

test('reads the WAV the glasses send', () => {
  const s = wavSamples(wav(0.5, 1))
  assert.equal(s.length, 16000)
  assert.ok(Math.abs(s[0] - 0.5) < 0.001)
})

test('recognizes enrolled people and the patient, and shows a card only for people', async () => {
  const { voices, hear } = await setup()
  const t = new Date('2026-10-17T15:00:00')
  assert.deepEqual(voices.status().enrolled, ['p1'])
  assert.equal(voices.status().patientEnrolled, true)

  const maya = hear(VOICES.maya, 3, t)
  assert.equal(maya.speaker, 'Maya')
  assert.equal(maya.kind, 'person')
  assert.deepEqual(voices.card(t.getTime() + 1000), { name: 'Maya', relation: 'granddaughter', fact: 'Studies art in Chicago' })
  assert.equal(voices.card(t.getTime() + 10_000), null)

  assert.equal(hear(VOICES.dhruv, 3, new Date(t.getTime() + 20_000)).speaker, 'Dhruv Sehgal')
  // Maya again within a minute: no second card
  hear(VOICES.maya, 3, new Date(t.getTime() + 40_000))
  assert.equal(voices.card(t.getTime() + 41_000), null)
  hear(VOICES.maya, 3, new Date(t.getTime() + 70_000))
  assert.equal(voices.card(t.getTime() + 71_000)?.name, 'Maya')
})

test('the card waits while a calendar question is on screen, but not forever', async () => {
  const { voices, hear } = await setup()
  const t = new Date('2026-10-17T15:00:00')
  hear(VOICES.maya, 3, t)
  assert.equal(voices.card(t.getTime() + 1000, true), null)
  assert.equal(voices.card(t.getTime() + 20_000)?.name, 'Maya')
  assert.equal(voices.card(t.getTime() + 27_000)?.name, 'Maya')
  assert.equal(voices.card(t.getTime() + 29_000), null)

  const later = new Date(t.getTime() + 20 * 60_000)
  hear(VOICES.maya, 3, later)
  assert.equal(voices.card(later.getTime() + 61_000), null)
})

test('short clips inherit the last speaker for a few seconds, then are unknown', async () => {
  const { hear } = await setup()
  const t = new Date('2026-10-17T15:00:00')
  hear(VOICES.maya, 3, t)
  assert.equal(hear(VOICES.raj, 0.8, new Date(t.getTime() + 4000)).speaker, 'Maya')
  assert.equal(hear(VOICES.raj, 0.8, new Date(t.getTime() + 30_000)).speaker, 'unknown')
})

test('a voice that matches no one is always unknown, never a numbered guest', async () => {
  const { voices, hear } = await setup()
  const t = new Date('2026-10-17T15:00:00')
  const first = hear(VOICES.raj, 3, t)
  assert.equal(first.speaker, 'unknown')
  assert.equal(first.kind, 'unknown')
  assert.equal(first.closest?.speaker, 'Dhruv Sehgal')
  assert.equal(hear(VOICES.meena, 3, new Date(t.getTime() + 10_000)).speaker, 'unknown')
  assert.equal(hear(VOICES.raj, 3, new Date(t.getTime() + 20_000)).speaker, 'unknown')
  assert.equal(voices.guests().length, 0)
  assert.equal(voices.card(t.getTime() + 1000), null)
})

test('a weaker clip still matches the closest saved voice, rather than staying unknown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-voices-'))
  const uploads = path.join(dir, 'uploads')
  fs.mkdirSync(uploads)
  fs.writeFileSync(path.join(uploads, 'maya.wav'), wav(VOICES.maya, 6))
  let data: HaloData = {
    patient: { name: 'Joe' },
    people: [{ id: 'p1', name: 'Maya', relation: 'granddaughter', blurb: '', voiceFile: 'maya.wav', createdAt: '' }],
    prescriptions: [],
  }
  const voices = createVoices({
    modelPath: '', dataDir: dir, uploadsDir: uploads, groqKey: '',
    readData: () => data, saveData: d => { data = d },
    lines: () => [], plans: () => [],
    renameSpeaker: () => {}, notify: () => {},
    embed: s => Math.abs(s[0] - VOICES.maya) < 0.01 ? [1, 0, 0, 0] : [0.38, 0.92, 0, 0],
  })
  await voices.sync()
  const heard = voices.assign(voices.prepare(wav(0.5, 2)), new Date('2026-10-17T15:00:00'))
  assert.equal(heard.speaker, 'Maya')
  assert.ok((heard.score ?? 0) < 0.45)
  assert.ok((heard.score ?? 0) >= 0.32)
})

test('a new voice file on the same person is folded into the voiceprint after sync', async () => {
  const { voices, hear, data, dir } = await setup()
  const t = new Date('2026-10-17T15:00:00')
  fs.writeFileSync(path.join(dir, 'uploads', 'maya2.wav'), wav(VOICES.raj, 6))
  const people = data().people
  people[0] = { ...people[0], voiceFile: 'maya2.wav' }
  await voices.sync()
  assert.equal(hear(VOICES.raj, 3, t).speaker, 'Maya')
  assert.equal(hear(VOICES.maya, 3, new Date(t.getTime() + 20_000)).speaker, 'Maya')
})
