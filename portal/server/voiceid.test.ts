import { test } from 'node:test'
import assert from 'node:assert/strict'
import { identifySpeakerWav } from './voiceid.ts'

test('returns null when the optional sidecar is unavailable', async () => {
  const result = await identifySpeakerWav(new Uint8Array([1, 2, 3]), {
    endpoint: 'http://127.0.0.1:1',
    timeoutMs: 100,
  })
  assert.equal(result, null)
})

test('returns null for a sidecar response that is not a VoiceID decision', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'MAYBE' }), { status: 200 })) as typeof fetch
  try {
    const result = await identifySpeakerWav(new Uint8Array([1]), { endpoint: 'http://voiceid.test' })
    assert.equal(result, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})
