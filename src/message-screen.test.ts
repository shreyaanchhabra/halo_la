import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messagePages, messageScreen } from './message-screen.ts'

const message = { id: '1', name: 'Maya', relation: 'granddaughter', text: 'Running 10 min late!', demo: false }
test('message display includes relationship and stays within five short lines', () => {
  const screen = messageScreen(message, message.text, 0)
  assert.match(screen, /Maya \(granddaughter\)/)
  assert.match(screen, /Running 10 min late!/)
  assert.match(screen, /Hold: reply/)
  assert.equal(screen.split('\n').length, 5)
  for (const l of screen.split('\n')) assert.ok(l.length <= 34)
})
test('every word of a long incoming message and reply can be reviewed without truncation', () => {
  const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
  const pages = messagePages(text)
  assert.equal(pages.flat().join(' '), text)
  assert.ok(pages.length > 1)
  assert.doesNotMatch(messageScreen(message, text, 0, true), /Tap: send/)
  assert.match(messageScreen(message, text, pages.length - 1, true), /Tap: send \| Hold: cancel/)
  for (let i = 0; i < pages.length; i++) {
    const lines = messageScreen(message, text, i, true).split('\n')
    assert.equal(lines.length, 5)
    for (const l of lines) assert.ok(l.length <= 34)
  }
})
test('unbroken long tokens are split without losing content', () => {
  const text = 'x'.repeat(400)
  assert.equal(messagePages(text).flat().join(''), text)
  for (const l of messagePages(text).flat()) assert.ok(l.length <= 34)
})
