// Reads a spoken answer to "Add this? Say yes or no". Only short utterances count, so a
// sentence of ordinary conversation is never mistaken for an answer.

const MAX_WORDS = 5

const NO = new Set(['no', 'nope', 'nah', 'dont', 'not', 'cancel', 'never', 'stop', 'wrong', 'incorrect'])
const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'okay', 'ok', 'please', 'correct', 'right', 'definitely', 'absolutely', 'fine'])
const YES_PHRASES = ['add it', 'go ahead', 'do it', 'sounds good', 'that is right', 'no problem']

export type Answer = 'yes' | 'no' | null

export function parseAnswer(text: string): Answer {
  const clean = text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  const words = clean.split(' ')
  if (words.length > MAX_WORDS) return null
  if (YES_PHRASES.some(p => clean.includes(p))) return 'yes'
  if (words.some(w => NO.has(w))) return 'no'
  if (words.some(w => YES.has(w))) return 'yes'
  return null
}
