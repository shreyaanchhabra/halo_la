import type { Plan } from '../../../../shared/calendar.ts'
import { dateLabel, dayDiff, planTitle } from '../../../../shared/format.ts'
import { $, esc } from '../../lib/dom'
import { approvalItem, eventItem, heard, whenLabel } from './events'
import { state, view } from './state'

export function renderCalendar() {
  const { plans, patient, online } = state
  const now = new Date()
  const name = patient || 'the patient'

  view.set('cal-status', online ? '' : '<div class="banner">Can’t reach the HALO server. Start it with <code>npm run server</code>.</div>')

  const needs = plans.filter(p => p.status === 'needs_approval').sort((a, b) => a.start.localeCompare(b.start))
  const asking = plans.filter(p => p.status === 'asked' || p.status === 'queued')
  view.set('cal-waiting', [
    needs.length ? `<h3>Needs your approval (${needs.length})</h3><p class="hint">${esc(name)} didn’t answer on the glasses.</p><ul class="list">${needs.map(approvalItem).join('')}</ul>` : '',
    asking.length ? `<h3>Asking ${esc(name)} now</h3><ul class="list">${asking.map(p => `<li class="ev"><div><p>${esc(planTitle(p))} <span class="muted">${whenLabel(p)}</span></p>${heard(p)}<p class="hint">${p.status === 'queued' ? 'Next in line.' : 'Waiting for a spoken yes or no.'}</p></div></li>`).join('')}</ul>` : '',
  ].join(''))

  const upcoming = plans.filter(p => p.status === 'confirmed' && dayDiff(new Date(p.start), now) >= 0).sort((a, b) => a.start.localeCompare(b.start))
  const days = new Map<string, Plan[]>()
  for (const p of upcoming) {
    const d = new Date(p.start)
    const n = dayDiff(d, now)
    const key = `${n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : ''}${n <= 1 ? ' · ' : ''}${dateLabel(d)}`
    days.set(key, [...(days.get(key) ?? []), p])
  }
  view.set('cal-upcoming', days.size
    ? [...days].map(([day, list]) => `<h3>${esc(day)}</h3><ul class="list">${list.map(p => eventItem(p, now)).join('')}</ul>`).join('')
    : '<p class="empty">Nothing on the calendar yet. Plans HALO hears and the patient confirms will appear here.</p>')

  const skipped = plans.filter(p => p.status === 'declined' || p.status === 'rejected').sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))
  $('cal-skipped').hidden = !skipped.length
  view.set('cal-skipped-list', skipped.map(p => `<li class="ev past"><div><p>${esc(planTitle(p))} <span class="muted">${whenLabel(p)}</span></p><p class="tags"><span class="tag">${p.status === 'declined' ? `${esc(name)} said no` : 'Family said no'}</span></p></div></li>`).join(''))
  $('cal-skipped-count').textContent = String(skipped.length)
}
