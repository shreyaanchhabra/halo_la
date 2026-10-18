import type { Refill } from '../../../../shared/refills.ts'
import { $, esc } from '../../lib/dom'
import { money } from './format'
import type { State } from './types'

const labels: Record<Refill['status'], string> = {
  preparing: 'Preparing quote', awaiting_approval: 'Needs family approval', ordering: 'Placing approved order',
  ordered: 'Ready for pickup', received: 'Received', rejected: 'Rejected by family', needs_review: 'Needs manual review',
}

function refillHtml(r: Refill, state: State) {
  const expired = !!r.quoteExpiresAt && Date.parse(r.quoteExpiresAt) <= Date.now()
  const blocked = r.totalCents === undefined || r.totalCents > state.settings.spendingLimitCents || expired
  return `<li><div><div class="refill-title"><strong>${esc(r.medicationName)}</strong>${r.totalCents === undefined ? '' : `<span class="refill-price">${money(r.totalCents)}</span>`}</div><span class="tag ${r.status === 'awaiting_approval' ? 'warn' : ''}">${labels[r.status]}</span>
    <p>${r.quantity} tablets · Test pharmacy</p>
    ${r.status === 'awaiting_approval' ? `<p class="quote-note">${expired ? 'Quote expired. Refresh to check the current price before approving.' : `Quote valid until ${esc(new Date(r.quoteExpiresAt!).toLocaleTimeString())}`}</p>
      ${r.totalCents! > state.settings.spendingLimitCents ? '<p>Above your spending limit. Review family approval settings.</p>' : ''}
      <div class="actions"><button class="${expired ? 'secondary' : ''}" data-action="approve" data-id="${r.id}" ${blocked ? 'disabled' : ''}>Approve ${money(r.totalCents!)}</button>
        <button class="secondary" data-action="reject" data-id="${r.id}">Decline</button><button class="${expired ? '' : 'secondary'}" data-action="requote" data-id="${r.id}">${expired ? 'Refresh expired quote' : 'Refresh quote'}</button></div>` : ''}
    ${r.status === 'rejected' ? `<button data-action="requote" data-id="${r.id}">Request a new quote</button>` : ''}
    ${r.orderId ? `<p>Order ${esc(r.orderId)}</p><p>Pickup ${esc(new Date(r.pickupAt!).toLocaleString())}</p><p>Added to the shared calendar.</p>` : ''}
    ${r.approvedBy ? `<p>Approved by ${esc(r.approvedBy)}</p>` : ''}
    ${r.error ? `<details class="medicine-details"><summary>There was a problem with this refill</summary><p>${esc(r.error)}</p></details>` : ''}
    ${r.status === 'ordered' ? `<button data-action="received" data-id="${r.id}">Confirm medicine received</button><p>Stock increases only after receipt.</p>` : ''}
    <a class="pharmacy-link" href="/test-pharmacy/refills/${r.id}" target="_blank" rel="noopener">View test pharmacy</a>
    </div></li>`
}

export function renderSummary(state: State) {
  $('driver').textContent = `${state.driver} · Limit ${money(state.settings.spendingLimitCents)} per order`
  $('med-count').textContent = String(state.medications.length)
  $('med-count-label').textContent = state.medications.length === 1 ? 'medication' : 'medications'
  $('approval-count').textContent = String(state.refills.filter(r => r.status === 'awaiting_approval').length)
  $('low-count').textContent = String(state.medications.filter(m => m.tabletsRemaining / m.tabletsPerDay <= 7).length)
}

export function renderMedications(state: State) {
  const expanded = new Set(Array.from(document.querySelectorAll<HTMLDetailsElement>('#medications details[open]')).map(el => el.dataset.medication))
  $('medications').innerHTML = state.medications.map(m => {
    const days = m.tabletsRemaining / m.tabletsPerDay
    const low = days <= 7
    const stockPercent = Math.min(100, Math.max(0, m.tabletsRemaining / m.refillQuantity * 100))
    return `<li><div class="medication-entry"><div class="medication-info">
      <div class="medicine-title"><strong>${esc(m.name)}</strong><span class="tag ${low ? 'warn' : ''}">${low ? 'Running low' : 'In stock'}</span></div>
      <p class="medicine-subtitle">${m.tabletsPerDay} ${m.tabletsPerDay === 1 ? 'tablet' : 'tablets'} per day · ${esc(m.doctor)}</p>
      <div class="stock-bar ${low ? 'low' : ''}" aria-hidden="true"><span style="width:${stockPercent}%"></span></div>
      <div class="stock-meta"><span>${m.tabletsRemaining} tablets remaining</span><span>About <b>${Number(days.toFixed(1))} ${days === 1 ? 'day' : 'days'}</b> left</span></div>
      <div class="medicine-bottom"><button data-dose="${m.id}" ${m.tabletsRemaining < 1 ? 'disabled' : ''}>Confirm 1 tablet taken</button><span>Records one tablet</span></div>
      <details class="medicine-details" data-medication="${m.id}" ${expanded.has(m.id) ? 'open' : ''}><summary>Prescription details</summary><p>Reference: ${esc(m.prescriptionId)}<br>Confirmed ${esc(new Date(m.confirmedAt).toLocaleDateString())}</p></details>
    </div></div></li>`
  }).join('') || '<li class="empty-state"><strong>No medications tracked yet.</strong><span>Add a confirmed prescription below to track stock and refills.</span></li>'
}

export function renderRefills(state: State) {
  $('refill-list').innerHTML = [...state.refills].reverse().map(r => refillHtml(r, state)).join('') || '<li class="empty-state"><strong>No refills awaiting approval.</strong><span>When a medicine reaches 7 days remaining, its refill will appear here.</span></li>'
}

export function renderActivity(state: State) {
  $('refill-log').innerHTML = state.activity.slice(-30).reverse().map(a => `<li><div><small>${esc(new Date(a.at).toLocaleString())}</small><p>${esc(a.text)}</p></div></li>`).join('') || '<li>No activity yet.</li>'
}
