import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCareSummaryRequest, shouldAnswerCaregiver } from './photon-text.ts'

test('caregiver questions and actions get HALO replies, while family-to-patient updates do not', () => {
  for (const text of [
    'How many pills are left?',
    'Can you tell me the next appointment?',
    'Approve the refill',
    'Pause alerts',
    'Mark the 9 pm dose as taken',
    'He took his medicine at 8',
    'Tell him I will be there soon',
    'Send me a care summary',
  ]) assert.equal(shouldAnswerCaregiver(text), true, text)

  for (const text of [
    'Running 10 minutes late!',
    'I am outside',
    'Love you, see you this weekend',
  ]) assert.equal(shouldAnswerCaregiver(text), false, text)
})

test('care summary requests are explicit and do not capture ordinary use of the word summary', () => {
  for (const text of ['summary', 'daily summary please', 'Send me a care summary', 'Can I get a summary?']) {
    assert.equal(isCareSummaryRequest(text), true, text)
  }
  for (const text of ['What is the summary of her prescription?', 'I will send a summary later', 'How many pills are left?']) {
    assert.equal(isCareSummaryRequest(text), false, text)
  }
})
