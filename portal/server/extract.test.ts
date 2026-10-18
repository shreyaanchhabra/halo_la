import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEventCommand, planText, sameActivity, withKnownSpeaker } from './extract.ts'

const care = { patient: 'Neo', people: [{ name: 'Shreyaan C', relation: 'Mentor' }, { name: 'Aksh M', relation: 'Brother' }] }

test('a plan said by a saved person always lists them, even if the model forgot', () => {
  assert.deepEqual(withKnownSpeaker(['park'], 'Shreyaan C', care), ['Shreyaan C', 'park'])
  assert.deepEqual(withKnownSpeaker(['Shreyaan C'], 'Shreyaan C', care), ['Shreyaan C'])
  assert.deepEqual(withKnownSpeaker(['Aksh'], 'Aksh M', care), ['Aksh'])
})

test('unknown or the patient are not added to who', () => {
  assert.deepEqual(withKnownSpeaker(['Maya'], 'unknown', care), ['Maya'])
  assert.deepEqual(withKnownSpeaker([], 'Neo', care), [])
})

test('soccer and cricket are different plans even at the same time', () => {
  assert.equal(sameActivity('soccer match', 'cricket match'), false)
  assert.equal(sameActivity('dinner', 'dinner'), true)
  assert.equal(sameActivity('park', 'go to the park'), true)
})

test('a time that arrived in the next clip is joined to the sentence before it', () => {
  assert.equal(planText('11 AM today.', 'Set an event for lunch break at'), 'Set an event for lunch break at 11 AM today.')
  assert.equal(planText('Set an event for soccer tomorrow at 10 PM', 'Hello.'), 'Set an event for soccer tomorrow at 10 PM')
})

test('explicit set-an-event commands work with surrounding words and time before activity', () => {
  assert.equal(isEventCommand('Set an event for soccer tomorrow at 4 PM'), true)
  assert.equal(isEventCommand('please set an event for dinner tonight at 7'), true)
  assert.equal(isEventCommand('set event for the dentist Tuesday at 9:30'), true)
  assert.equal(isEventCommand('Set an event at 4 PM for soccer tomorrow'), true)
  assert.equal(isEventCommand('Hey, can you set an event at 4 for soccer tomorrow?'), true)
  assert.equal(isEventCommand('Set an event at 4 PM for soccer, and bring water'), true)
  assert.equal(isEventCommand("I'll come by Saturday at 2 and we'll go to the park"), false)
  assert.equal(isEventCommand('Do you want to meet today at 6?'), false)
  assert.equal(isEventCommand('Can I have a soccer match tomorrow at 10 PM?'), false)
})
