import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { canListenForConversation, pressAction } from './buttons.ts'

describe('what a press on the glasses does', () => {
  test('on a menu page, any press goes back to the home screen', () => {
    for (const paused of [false, true]) {
      assert.equal(pressAction('click', { onPage: true, paused }), 'home')
      assert.equal(pressAction('double', { onPage: true, paused }), 'home')
    }
  })

  describe('when the glasses listen for conversation', () => {
    test('speaker identification and conversation listening are limited to Today while unpaused', () => {
      assert.equal(canListenForConversation({ onToday: true, paused: false }), true)
      assert.equal(canListenForConversation({ onToday: false, paused: false }), false)
      assert.equal(canListenForConversation({ onToday: true, paused: true }), false)
      assert.equal(canListenForConversation({ onToday: false, paused: true }), false)
    })
  })

  test('at home, a double press pauses or resumes listening', () => {
    assert.equal(pressAction('double', { onPage: false, paused: false }), 'toggle-pause')
    assert.equal(pressAction('double', { onPage: false, paused: true }), 'toggle-pause')
  })

  test('at home, a press acknowledges what is on screen, or resumes if listening was paused', () => {
    assert.equal(pressAction('click', { onPage: false, paused: false }), 'tap')
    assert.equal(pressAction('click', { onPage: false, paused: true }), 'toggle-pause')
  })
})
