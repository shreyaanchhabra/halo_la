import { $ } from '../../lib/dom'
import { fetchJson, jsonInit } from '../../lib/http'
import { fromLocalInput, splitNames } from './dates'
import { RESULT } from './conversation-view'
import { state, type Reply } from './state'

// Wires the forms and buttons. `refresh` reloads the page data after every change.
export function mountActions(refresh: () => Promise<void>) {
  const feed = `${location.origin}/api/calendar.ics`
  $<HTMLAnchorElement>('cal-webcal').href = feed.replace(/^https?:/, 'webcal:')
  $('cal-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(feed); $('cal-copied').textContent = 'Copied.' } catch { $('cal-copied').textContent = feed }
  })

  $<HTMLFormElement>('cal-add').addEventListener('submit', async e => {
    e.preventDefault()
    const f = e.target as HTMLFormElement
    const v = (n: string) => (f.elements.namedItem(n) as HTMLInputElement)
    const allDay = v('allDay').checked
    try {
      await fetchJson('/api/plans', jsonInit('POST', { activity: v('activity').value, who: splitNames(v('who').value), start: fromLocalInput(v('start').value, allDay), allDay }))
      f.reset()
      $('cal-add-error').textContent = ''
      await refresh()
    } catch (err) { $('cal-add-error').textContent = String(err) }
  })

  $<HTMLFormElement>('say-form').addEventListener('submit', async e => {
    e.preventDefault()
    const text = $<HTMLInputElement>('say-text')
    const btn = $<HTMLButtonElement>('say-btn')
    btn.disabled = true
    $('say-result').textContent = 'Listening…'
    try {
      const r = await fetchJson<Reply>('/api/transcript', jsonInit('POST', { text: text.value, speaker: $<HTMLSelectElement>('say-speaker').value }))
      $('say-result').textContent = (RESULT[r.kind] ?? (() => r.kind))(r)
      text.value = ''
      await refresh()
    } catch (err) { $('say-result').textContent = String(err) }
    btn.disabled = false
    text.focus()
  })

  // One listener for every button inside the cards
  document.addEventListener('click', async e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (!el) return
    const { act, id, line } = el.dataset
    try {
      if (act === 'approve' || act === 'reject') await fetchJson(`/api/plans/${id}/${act}`, jsonInit('POST'))
      else if (act === 'delete') { if (confirm('Remove this event from the calendar?')) await fetchJson(`/api/plans/${id}`, jsonInit('DELETE')) }
      else if (act === 'edit') state.editing = id!
      else if (act === 'cancel') state.editing = null
      else if (act === 'heard') {
        const li = document.getElementById(`line-${line}`)
        li?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        li?.classList.add('flash')
        setTimeout(() => li?.classList.remove('flash'), 1800)
      }
    } catch (err) { alert(String(err)) }
    await refresh()
  })

  document.addEventListener('submit', async e => {
    const f = e.target as HTMLFormElement
    if (!f.classList.contains('edit')) return
    e.preventDefault()
    const v = (n: string) => f.elements.namedItem(n) as HTMLInputElement
    const allDay = v('allDay').checked
    try {
      await fetchJson(`/api/plans/${f.dataset.id}`, jsonInit('PATCH', { activity: v('activity').value, who: splitNames(v('who').value), start: fromLocalInput(v('start').value, allDay), allDay }))
      state.editing = null
    } catch (err) { alert(String(err)) }
    await refresh()
  })
}
