import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chatJson, FALLBACK_MODEL, retryWaitMs } from './groq.ts'

const limited = (wait: string) => JSON.stringify({ error: { message: `Rate limit reached for model \`openai/gpt-oss-120b\`. Please try again in ${wait}. Need more tokens?` } })

describe('waiting out a Groq rate limit', () => {
  test('a short wait is waited out, with a little margin', () => {
    assert.equal(retryWaitMs(limited('1.5s')), 2000)
    assert.equal(retryWaitMs(limited('250ms')), 750)
  })

  test('a wait in minutes is read as minutes, and is too long to hold a sentence for', () => {
    assert.equal(retryWaitMs(limited('4m44.688s')), null)
    assert.equal(retryWaitMs(limited('2m')), null)
  })

  test('a wait longer than the cap is not worth retrying', () => {
    assert.equal(retryWaitMs(limited('20s')), null)
  })

  test('with no wait in the message, a short default', () => {
    assert.equal(retryWaitMs('{"error":{"message":"Rate limit reached"}}'), 3500)
  })
})

describe('when the main model has used its daily allowance', () => {
  const answering = (replies: Response[]) => {
    const models: string[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      models.push(JSON.parse(String(init?.body)).model)
      return replies.shift()!
    }) as typeof fetch
    return { models, restore: () => { globalThis.fetch = real } }
  }
  const ok = (content: object) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }))

  test('the question is asked of the smaller model, which has its own allowance', async () => {
    const f = answering([new Response(limited('4m44.688s'), { status: 429 }), ok({ yes: true })])
    try {
      assert.deepEqual(await chatJson('key', 'system', 'user', 'answer', {}), { yes: true })
      assert.equal(f.models.length, 2)
      assert.equal(f.models[1], FALLBACK_MODEL)
    } finally { f.restore() }
  })

  test('other failures are not retried on another model', async () => {
    const f = answering([new Response('bad key', { status: 401 })])
    try {
      await assert.rejects(chatJson('key', 'system', 'user', 'answer', {}), /Groq error 401/)
      assert.equal(f.models.length, 1)
    } finally { f.restore() }
  })
})
