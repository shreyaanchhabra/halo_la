import { timeLabel } from '../../../../shared/format.ts'
import { $, esc } from '../../lib/dom'
import { state, view, type Reply } from './state'

export function renderConversation() {
  const { people, patient, transcript } = state
  const speakers = ['unknown', ...people.map(p => p.name), ...(patient ? [patient] : [])]
  const sel = $<HTMLSelectElement>('say-speaker')
  const options = speakers.map(s => `<option value="${esc(s)}">${s === 'unknown' ? 'Unknown speaker' : esc(s)}</option>`).join('')
  if (view.shown['say-speaker'] !== options) {
    const keep = sel.value
    sel.innerHTML = options
    sel.value = speakers.includes(keep) ? keep : 'unknown'
    view.shown['say-speaker'] = options
  }
  view.set('transcript', transcript.length
    ? [...transcript].reverse().slice(0, 15).map(l => `<li id="line-${esc(l.id)}"><span class="muted">${timeLabel(new Date(l.ts))} · ${esc(l.speaker === 'unknown' ? 'Unknown' : l.speaker)}</span><br />${esc(l.text)}</li>`).join('')
    : '<li class="empty">Nothing heard yet.</li>')
}

export const RESULT: Record<string, (r: Reply) => string> = {
  proposed: r => `Asking on the glasses: ${r.summary}. Say “yes” or “no” to answer it.`,
  queued: r => `Queued behind another question: ${r.summary}.`,
  answer: r => `Heard “${r.answer}”: ${r.answer === 'yes' ? 'added to the calendar' : 'not added'} (${r.summary}).`,
  duplicate: () => 'Already on the calendar, or already answered.',
  ignored: r => (r.error ? `Couldn’t check this one: ${r.error}` : 'Not a calendar plan, so HALO ignored it.'),
  silence: () => 'No speech heard.',
}
