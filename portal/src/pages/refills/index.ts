import '../../shell'
import '../../styles/base.css'
import './refills.css'
import { $, esc } from '../../lib/dom'
import { request } from './api'
import { value } from './format'
import { renderActivity, renderMedications, renderRefills, renderSummary } from './render'
import type { State } from './types'

let state: State
let initialized = false
let mutating = false

async function load() {
  state = await request()
  if (!initialized) {
    $<HTMLInputElement>('limit').value = (state.settings.spendingLimitCents / 100).toFixed(2)
    $('sku').innerHTML = state.catalog.map(p => `<option value="${p.sku}">${esc(p.name)} · ${p.quantity} tablets</option>`).join('')
    initialized = true
  }
  renderSummary(state)
  renderMedications(state)
  renderRefills(state)
  renderActivity(state)
}

async function mutate(action: () => Promise<unknown>) {
  if (mutating) return
  mutating = true
  $('notice').textContent = 'Saving…'
  try { await action(); await load(); $('notice').textContent = 'Saved.' }
  catch (e) { $('notice').textContent = e instanceof Error ? e.message : 'Could not save. Check the server.' }
  finally { mutating = false }
}

$('add-medication').addEventListener('click', () => {
  ($('add-prescription') as HTMLDetailsElement).open = true
  $('sku').focus()
})

$('settings-form').addEventListener('submit', e => {
  e.preventDefault()
  void mutate(() => request('/settings', 'PUT', { spendingLimitCents: Math.round(Number(value('limit')) * 100) }))
})
$('medication-form').addEventListener('submit', e => {
  e.preventDefault()
  void mutate(() => request('/medications', 'POST', { sku: value('sku'), doctor: value('doctor'), prescriptionId: value('prescription'),
    tabletsPerDay: Number(value('daily')), tabletsRemaining: Number(value('remaining')), doctorConfirmed: $<HTMLInputElement>('confirmed').checked }))
})
$('check').addEventListener('click', () => { void mutate(() => request('/check', 'POST')) })
document.addEventListener('click', e => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action],button[data-dose]')
  if (!button) return
  const { action, id, dose } = button.dataset
  if (dose) {
    const eventId = crypto.randomUUID()
    void mutate(() => request(`/medications/${dose}/doses`, 'POST', { eventId, tablets: 1 }))
  } else if (action && id) {
    if (action === 'approve' && !value('approver')) { $('notice').textContent = 'Enter the family member approving this order.'; ($('settings-panel') as HTMLDetailsElement).open = true; $('approver').focus(); return }
    const r = state.refills.find(r => r.id === id)!
    void mutate(() => request(`/${id}/${action}`, 'POST', action === 'approve' ? { approvedBy: value('approver'), expectedTotalCents: r.totalCents } : undefined))
  }
})

void load().catch(() => {
  $('notice').textContent = 'Medications are unavailable. Check that the HALO backend is running, then reload.'
  $('medications').innerHTML = '<li class="empty connection-error">Unable to load medications.</li>'
  $('refill-list').innerHTML = '<li class="empty connection-error">Unable to load refills.</li>'
})
setInterval(() => { if (!mutating && initialized) void load().catch(() => { $('notice').textContent = 'Connection interrupted. Reconnecting…' }) }, 4000)
