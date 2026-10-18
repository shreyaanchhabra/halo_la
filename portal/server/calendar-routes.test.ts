import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { calendarRoutes } from './calendar-routes.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-dose-answer-'))
let routes: ReturnType<typeof calendarRoutes>
let server: http.Server
let base = ''
let transcript = ''
let transcribedOptions: { prompt?: string } | undefined

before(async () => {
  routes = calendarRoutes({
    apiKey: 'offline-test-key',
    dataDir: dir,
    transcribe: async (_wav, _key, options) => { transcribedOptions = options; return transcript },
  })
  server = http.createServer(async (req, res) => {
    if (!(await routes.handle(req, res, new URL(req.url ?? '/', 'http://x')))) {
      res.statusCode = 404
      res.end('not found')
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

after(async () => {
  routes.stop()
  await new Promise<void>(resolve => server.close(() => resolve()))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('dose-answer audio recognizes yes and no without submitting them to calendar conversation', async () => {
  for (const [said, expected] of [
    ['Yes', 'yes'],
    ['Taken', 'yes'],
    ['Taken.', 'yes'],
    ['Take it', 'yes'],
    ['I took it', 'yes'],
    ['No', 'no'],
    ['Not taken', 'no'],
  ] as const) {
    transcript = said
    const response = await fetch(`${base}/api/audio/dose`, { method: 'POST', body: new Uint8Array([1, 2, 3]) })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { kind: 'dose-answer', text: said, answer: expected })
    assert.match(transcribedOptions?.prompt ?? '', /Do not turn "not taken" into "taken"/)
  }
  assert.deepEqual(routes.cal.plans(), [])
})

test('unclear or empty dose-answer audio never becomes a yes or no', async () => {
  for (const said of ['Maybe later', '']) {
    transcript = said
    const response = await fetch(`${base}/api/audio/dose`, { method: 'POST', body: new Uint8Array([1, 2, 3]) })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { kind: said ? 'dose-answer' : 'silence', text: said, answer: null })
  }
})
