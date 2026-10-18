import './style.css'
import { initSentry } from './sentry'

initSentry('care')
import {
  checkPrices, clearPrices, esc, fileUrl, forgetGuest, guestClipUrl, loadData, loadDoses, loadImessage, loadPlans, loadPrices, loadRefills,
  loadVoices, nameGuest, onDataChanged, readPrescription, refillAction,
  planAction, removeFile, saveData, setDose, setRefillLimit, transcribe, uploadFile,
} from './api'
import { allMedicines, daysLeft, parseTimes, pillsLeft, refillDue, runningLow, supplyText, type MedEntry } from './meds'
import { downloadIcs, formatTime, ymd } from './schedule'
import { formatCents, type RefillState } from '../../shared/refill-types.ts'
import { dateLabel, planTitle, startOfDay, timeLabel } from '../../shared/format.ts'
import { matchLabel, startLiveAudio, startWhoAudio, type LiveAudio } from './live-audio'
import type { DoseLog, HaloData, HeardClip, ImessageStatus, Person, Plan, PriceCheck, Prescription, TextAlertKind, VoiceStatus } from './types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let data: HaloData = { patient: { name: '' }, people: [], prescriptions: [] }
let doses: DoseLog[] = []
let prices: Record<string, PriceCheck> = {}
let refillState: RefillState | null = null
let plans: Plan[] = []
const APPROVER_KEY = 'halo.approver'
const approver = () => { try { return localStorage.getItem(APPROVER_KEY) ?? '' } catch { return '' } }
let imessage: ImessageStatus | null = null
let voices: VoiceStatus | null = null
// The unrecognized voice whose "Name this person" form is open
let naming: string | null = null
// Prescriptions and people with a request to Groq in progress
const busy = new Set<string>()
// The medicine ("<rx>:<n>") or prescription being edited in place
let editing: string | null = null

const editMedForm = (e: MedEntry) => `
  <form class="edit-form" data-edit-med="${esc(e.key)}">
    <div class="row">
      <label>Medicine <input name="name" value="${esc(e.med.name)}" required /></label>
      <label>Strength <input name="strength" value="${esc(e.med.strength)}" /></label>
    </div>
    <label>Times each day <input name="times" value="${esc(e.med.times.map(formatTime).join(', '))}" placeholder="8:00 AM, 9:00 PM" required /></label>
    <label>Instructions <input name="instructions" value="${esc(e.med.instructions)}" /></label>
    <label>Pills in one refill <input name="quantity" type="number" min="1" step="1" value="${e.med.quantity ?? ''}" /></label>
    <p class="hint" data-edit-error role="alert" hidden></p>
    <div class="row"><button type="submit">Save</button><button type="button" class="secondary" data-cancel-edit>Cancel</button></div>
  </form>`

const editRxForm = (r: Prescription) => `
  <form class="edit-form" data-edit-rx="${esc(r.id)}">
    <div class="row">
      <label>Prescribed by <input name="doctor" value="${esc(r.doctor)}" /></label>
      <label>Date <input name="date" type="date" value="${esc(r.date)}" /></label>
    </div>
    <label>Notes <input name="notes" value="${esc(r.notes)}" /></label>
    <div class="row"><button type="submit">Save</button><button type="button" class="secondary" data-cancel-edit>Cancel</button></div>
  </form>`

async function load() {
  ;[data, doses, prices, refillState, plans, imessage, voices] = await Promise.all([
    loadData(), loadDoses(), loadPrices(), loadRefills().catch(() => null), loadPlans().catch(() => [] as Plan[]),
    loadImessage().catch(() => null), loadVoices().catch(() => null),
  ])
  for (const [id, value] of [['patient-name', data.patient.name], ['patient-zip', data.patient.zip ?? '']]) {
    const input = $<HTMLInputElement>(id)
    if (document.activeElement !== input) input.value = value
  }
  render()
}

const money = (n: number) => `$${n.toFixed(2)}`
const shortDate = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function renderPrices(e: MedEntry) {
  const p = prices[e.key]
  if (!p) return `<p class="status">No GoodRx prices yet.</p>`
  if (p.status === 'checking') return `<p class="status">Checking GoodRx with Browser Use… <b data-elapsed="${esc(p.startedAt ?? '')}"></b> It usually takes 3 to 4 minutes. You can leave this page.</p>`
  if (p.status === 'failed') return `<p class="status error">GoodRx lookup failed: ${esc(p.error ?? 'unknown error')}</p>`
  const quotes = p.quotes ?? []
  return `
    <div class="reading">
      <h4>GoodRx prices near ${esc(p.zip)}${p.quantity ? ` · qty ${p.quantity}` : ''}</h4>
      ${quotes.length ? `<div class="table-scroll"><table>${quotes.map(q => `
        <tr><td>${esc(q.pharmacy)}</td><td>${money(q.price)}</td><td>${esc(q.priceType)}</td></tr>`).join('')}</table></div>`
        : '<p class="status">No prices found.</p>'}
      ${p.note ? `<p class="status">${esc(p.note)}</p>` : ''}
      <p class="status">Checked ${p.checkedAt ? shortDate(p.checkedAt) : ''}${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">Open on GoodRx</a>` : ''} · <button class="link" data-hide-prices="${e.key}">Hide</button></p>
    </div>`
}

const TEXTED: Record<TextAlertKind, string> = {
  missed: 'Texted family about a missed dose',
  taken: 'Texted family that this dose was taken',
  dose_update: 'Texted family about a dose update',
  refill: 'Texted family about this refill',
  prices: 'Texted family the GoodRx prices',
  appointment: 'Texted family an appointment reminder',
  checkin: 'Sent the daily family check-in',
}

function renderTexted(e: MedEntry) {
  const alert = imessage?.alerts[e.key]
  return alert ? `<p class="texted">${TEXTED[alert.kind]} · ${shortDate(alert.at)}</p>` : ''
}

const clockTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const MARKED_BY = { imessage: 'by text', glasses: 'on the glasses' } as const

// Today's doses that were marked away from this page
function renderMarked(e: MedEntry) {
  const today = ymd(new Date())
  return doses
    .filter(d => d.medKey === e.key && d.by && d.slot.startsWith(today))
    .map(d => `<p class="texted">${formatTime(d.slot.slice(11))} dose marked taken ${MARKED_BY[d.by!]} · ${clockTime(d.at)}</p>`)
    .join('')
}

// Plans HALO heard in conversation, and what is coming up. The full calendar is on its own page.
function renderPlans() {
  const when = (p: Plan) => `${p.allDay ? '' : `${timeLabel(new Date(p.start))}, `}${dateLabel(new Date(p.start))}`
  const heard = (p: Plan) => (p.source ? `<p>Heard: “${esc(p.source.quote)}”</p>` : '')
  const name = data.patient.name.split(' ')[0] || 'the patient'
  const needs = plans.filter(p => p.status === 'needs_approval')
  const asking = plans.filter(p => p.status === 'asked' || p.status === 'queued')
  const upcoming = plans
    .filter(p => p.status === 'confirmed' && new Date(p.start).getTime() >= startOfDay(new Date()).getTime())
    .sort((a, b) => a.start.localeCompare(b.start))
  const coming = upcoming.slice(0, 6)
  $('plans-card').innerHTML = `
    <h2>Calendar</h2>
    <p class="hint">Plans HALO hears in conversation, once ${esc(name)} says yes, and refill pickups. <a href="/calendar.html">Open the full calendar</a></p>
    ${needs.length ? `<h3 class="sub">Needs your approval (${needs.length})</h3><p class="hint">${esc(name)} didn’t answer, so nothing was added.</p>
      <ul class="list">${needs.map(p => `<li><div><p><b>${esc(planTitle(p))}</b> · ${esc(when(p))}</p>${heard(p)}</div>
        <div class="actions"><button data-plan-approve="${esc(p.id)}">Add to calendar</button><button class="link" data-plan-reject="${esc(p.id)}">Don’t add</button></div></li>`).join('')}</ul>` : ''}
    ${asking.length ? `<h3 class="sub">Asking ${esc(name)} now</h3>
      <ul class="list">${asking.map(p => `<li><div><p><b>${esc(planTitle(p))}</b> · ${esc(when(p))}</p>${heard(p)}<p>Waiting for a spoken yes or no.</p></div></li>`).join('')}</ul>` : ''}
    <h3 class="sub">Coming up</h3>
    ${coming.length ? `<ul class="list">${coming.map(p => `<li><div><p><b>${esc(planTitle(p))}</b> · ${esc(when(p))}</p>${heard(p)}</div>
      <div class="actions">${p.confirmedBy === 'patient' ? '<span class="tag">Confirmed by voice</span>' : p.source ? '<span class="tag">Approved by family</span>' : '<span class="tag">Added by family</span>'}</div></li>`).join('')}</ul>`
      : '<p class="hint">Nothing on the calendar yet. Plans HALO hears and refill pickups will appear here.</p>'}
    ${upcoming.length > coming.length ? `<p class="hint">and ${upcoming.length - coming.length} more. <a href="/calendar.html">Open the full calendar</a></p>` : ''}`
}

// Refill before it runs out: the GoodRx prices the errands agent found, and what the family can do about it
function renderRefill(e: MedEntry) {
  const days = daysLeft(e, data, doses)
  const r = refillState?.refills.find(x => x.medKey === e.key && x.status !== 'cancelled' && x.status !== 'received')
  if (!r) return refillDue(e, data, doses) ? `<p class="refill due"><b>Refill needed:</b> about ${days} days of pills left. HALO is getting ready to look up prices.</p>` : ''

  const goodrx = r.quote?.url ? ` <a href="${esc(r.quote.url)}" target="_blank" rel="noopener">Open on GoodRx</a>` : ''
  switch (r.status) {
    case 'preparing':
      return `<p class="refill due"><b>Refill needed:</b> about ${days} days of pills left. HALO is looking up GoodRx prices with Browser Use. This usually takes 1 to 3 minutes. Nothing will be bought.</p>`
    case 'awaiting_approval': {
      const q = r.quote!
      const limit = refillState!.settings.spendingLimitCents
      const over = q.priceCents > limit
      const expired = Date.parse(q.expiresAt) <= Date.now()
      return `
        <div class="refill due">
          <p><b>Refill ${esc(r.medicine)}: ${formatCents(q.priceCents)} at ${esc(q.pharmacy)}${q.priceType ? ` (${esc(q.priceType)})` : ''}, approve?</b></p>
          <p>${q.quantity} tablets. About ${days} days of pills left. <b>Nothing has been bought.</b> Prices checked on GoodRx until ${esc(shortDate(q.expiresAt))}.${goodrx}</p>
          ${q.prices.length > 1 ? `<div class="table-scroll"><table>${q.prices.map((p, i) => `<tr><td>${esc(p.pharmacy)}${i === 0 ? ' <span class="tag low">Cheapest</span>' : ''}</td><td>${formatCents(p.priceCents)}</td><td>${esc(p.priceType)}</td></tr>`).join('')}</table></div>` : ''}
          ${over ? `<p class="warn">This is over your limit of ${formatCents(limit)}. Raise the limit above to approve it.</p>` : ''}
          ${expired ? '<p class="warn">These prices are out of date. Get fresh prices.</p>' : ''}
          <div class="refill-actions">
            <button data-refill-approve="${esc(r.id)}" data-price="${q.priceCents}" ${over || expired ? 'disabled' : ''}>Approve ${formatCents(q.priceCents)}</button>
            <button class="link" data-refill-reject="${esc(r.id)}">Not now</button>
            ${expired ? `<button class="link" data-refill-requote="${esc(r.id)}">Get fresh prices</button>` : ''}
          </div>
        </div>`
    }
    case 'approved':
      return `
        <div class="refill ok">
          <p><b>Approved by ${esc(r.approvedBy ?? 'the family')}:</b> get ${r.quantity} tablets at ${esc(r.quote?.pharmacy ?? 'the pharmacy')} for ${formatCents(r.quote?.priceCents ?? 0)} with the GoodRx coupon.${goodrx}</p>
          <p>Pickup reminder: <b>${esc(shortDate(r.pickupAt!))}</b>. It is on the <a href="/calendar.html">calendar</a>; move it if you go another time. HALO does not buy anything for you.</p>
          <div class="refill-actions"><button data-refill-received="${esc(r.id)}">I have it</button></div>
        </div>`
    case 'rejected':
      return `
        <div class="refill due">
          <p><b>Refill not requested.</b> About ${days} days of pills left. HALO will not look again until you ask.</p>
          <div class="refill-actions"><button class="secondary" data-refill-requote="${esc(r.id)}">Look up prices</button></div>
        </div>`
    default: // needs_review
      return `
        <div class="refill bad">
          <p><b>HALO could not get prices.</b> ${esc(r.error ?? '')}</p>
          <div class="refill-actions"><button class="secondary" data-refill-requote="${esc(r.id)}">Try again</button></div>
        </div>`
  }
}

// The family's spending limit, and who is approving. Left alone while someone is typing in it.
function renderRefillSettings() {
  const box = $('refill-settings')
  if (box.contains(document.activeElement) && box.innerHTML) return
  box.innerHTML = refillState ? `
    <form id="refill-settings-form" class="refill-settings">
      <label>Most the family will pay per refill ($)
        <input name="limit" type="number" min="0" step="0.01" value="${(refillState.settings.spendingLimitCents / 100).toFixed(2)}" required /></label>
      <label>Your name, for approvals
        <input name="approver" value="${esc(approver())}" placeholder="Maya" maxlength="100" /></label>
      <button type="submit" class="secondary">Save</button>
      <p class="hint">Prices from: ${esc(refillState.driver)}. HALO never buys anything: you approve a price and pick it up.</p>
    </form>` : '<p class="status error">The refill service is not running.</p>'
}

// The family can log a dose too, for example when the patient took it but didn't tap
function renderDoseRow(e: MedEntry, today: string) {
  if (!e.med.times.length) return ''
  const items = e.med.times.map(time => {
    const slot = `${today} ${time}`
    const taken = doses.find(d => d.medKey === e.key && d.slot === slot)
    return taken
      ? `<span class="dose taken">${esc(formatTime(time))} ✓ taken ${esc(new Date(taken.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))} <button class="link" data-dose-undo="${esc(e.key)}|${esc(slot)}">Undo</button></span>`
      : `<span class="dose">${esc(formatTime(time))} <button class="secondary" data-dose-take="${esc(e.key)}|${esc(slot)}">Mark as taken</button></span>`
  })
  return `<div class="dose-row" aria-label="Today's doses of ${esc(e.med.name)}">${items.join('')}</div>`
}

// What is running low, at the top, so it can't be missed
function renderLowSummary() {
  const low = runningLow(data, doses)
  const open = (e: MedEntry) => refillState?.refills.find(r => r.medKey === e.key && r.status !== 'cancelled' && r.status !== 'received')
  const note = (e: MedEntry) => {
    const r = open(e)
    if (!r) return 'getting ready to look up prices'
    return ({ preparing: 'looking up GoodRx prices', awaiting_approval: 'waiting for your approval below', approved: 'approved, pickup is on the calendar', rejected: 'you said not now', needs_review: 'needs a person to look' } as Record<string, string>)[r.status] ?? ''
  }
  $('low-summary').innerHTML = low.length
    ? `<div class="refill due low-summary" role="status"><p><b>Running low (${low.length}):</b></p><ul>${low.map(({ entry, supply }) => `<li><b>${esc(`${entry.med.name} ${entry.med.strength}`)}</b>: ${esc(supplyText(supply))}. Refill: ${esc(note(entry))}.</li>`).join('')}</ul></div>`
    : ''
}

function renderMedicines() {
  renderLowSummary()
  renderRefillSettings()
  const meds = allMedicines(data)
  const today = ymd(new Date())
  $('medicines').innerHTML = meds.length
    ? meds.map(e => {
      const left = pillsLeft(e, data, doses)
      const days = daysLeft(e, data, doses)
      const takenToday = doses.filter(d => d.medKey === e.key && d.slot.startsWith(today)).length
      const checking = prices[e.key]?.status === 'checking'
      if (editing === e.key) return `<li><div>${editMedForm(e)}</div></li>`
      return `
      <li>
        <div>
          <strong>${esc(`${e.med.name} ${e.med.strength}`)}</strong>
          <p>${e.med.times.map(formatTime).join(', ') || 'No dose times'} · taken today: ${takenToday} of ${e.med.times.length}</p>
          ${renderDoseRow(e, today)}
          <p>Pills left: <b>${left ?? 'unknown'}</b>${days != null ? ` (about ${days} days)` : ''}${refillDue(e, data, doses) ? ' <span class="tag low">Running low</span>' : ''}</p>
          <form class="stock-form" data-stock="${e.key}">
            <input type="number" min="0" step="1" placeholder="Pills on hand" aria-label="Pills on hand for ${esc(e.med.name)}" />
            <button type="submit" class="secondary">Update count</button>
          </form>
          ${renderRefill(e)}
          ${renderMarked(e)}
          ${renderTexted(e)}
          ${refillState?.refills.some(r => r.medKey === e.key && r.status !== 'cancelled' && r.status !== 'received') ? '' : renderPrices(e)}
        </div>
        <div class="actions">
          <button class="link" data-prices="${e.key}" ${checking ? 'disabled' : ''}>${prices[e.key] ? 'Check prices again' : 'Check GoodRx prices'}</button>
          <button class="link" data-edit="${e.key}">Edit</button>
          <button class="link" data-stop-med="${e.key}">Stop taking</button>
        </div>
      </li>`
    }).join('')
    : '<li class="empty">No medicines yet. Upload a prescription or add a medicine by hand above.</li>'
}

async function startPriceCheck(key: string) {
  const entry = allMedicines(data).find(e => e.key === key)
  if (!entry) return
  try {
    await checkPrices(key, entry.med, data.patient.zip ?? '')
  } catch (err) {
    prices[key] = { status: 'failed', zip: data.patient.zip ?? '', error: (err as Error).message }
    renderMedicines()
  }
}

function renderReading(rx: Prescription) {
  if (busy.has(rx.id)) return '<p class="status">Reading medicines…</p>'
  if (rx.readError) {
    return `<p class="status error">${esc(rx.readError)}</p>`
  }
  const r = rx.reading
  if (!r) return '<p class="status">Not read yet.</p>'
  return `
    <div class="reading">
      <h4>Medicines</h4>
      ${r.medicines.length ? `<div class="table-scroll"><table>${r.medicines.map((m, i) => `
        <tr>
          <td>${esc(`${m.name} ${m.strength}`)}${m.stopped ? ` <span class="tag">Stopped</span> <button class="link" data-restart-med="${esc(rx.id)}|${i}">Start again</button>` : ''}</td>
          <td>${m.times.map(formatTime).join(', ') || 'No times found'}</td>
          <td>${esc(m.instructions)}${m.quantity != null ? ` · Qty ${m.quantity}` : ''}${m.refills != null ? ` · ${m.refills} refills` : ''}</td>
        </tr>`).join('')}</table></div>` : '<p class="status">No medicines found.</p>'}
      ${r.appointments.length ? `<h4>Appointments</h4><ul>${r.appointments.map(a =>
        `<li>${esc(a.title)}: ${esc(a.date)}${a.time ? ` at ${formatTime(a.time)}` : ''}</li>`).join('')}</ul>` : ''}
      ${r.notes.length ? `<h4>Care plan notes</h4><ul>${r.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </div>`
}

const firstName = () => (data.patient.name || 'the patient').split(' ')[0]

function voiceTag(p: Person) {
  if (!voices?.ready || !p.voiceFile) return ''
  return voices.enrolled.includes(p.id) ? '<span class="tag ok">voice learned</span>' : '<span class="tag">learning voice…</span>'
}

function renderPatientVoice() {
  const saved = $('pv-saved')
  if (!data.patient.voiceFile) { saved.textContent = ''; return }
  saved.innerHTML = `${voices?.patientEnrolled ? `HALO knows ${esc(firstName())}'s voice.` : 'Saved. HALO is learning the voice…'}
    <audio controls src="${fileUrl(data.patient.voiceFile)}"></audio>`
}

function renderVoices() {
  const el = $('voices')
  if (!voices) { el.innerHTML = ''; return }
  if (!voices.ready) { el.innerHTML = `<p class="status error">Voice recognition is off: ${esc(voices.problem ?? 'unknown problem')}</p>`; return }
  if (!voices.guests.length) { el.innerHTML = ''; return }
  el.innerHTML = `
    <h3>Voices HALO doesn't know yet</h3>
    <p class="hint">Heard through the glasses in the last week. Name someone and HALO recognizes them from then on, including what they already said.</p>
    <ul class="list">${voices.guests.map(g => `
      <li>
        <div>
          <strong>${esc(g.label)}</strong>
          <span class="tag">${g.seconds < 60 ? `talked ${g.seconds}s` : `talked about ${Math.round(g.seconds / 60)} min`} · ${g.lines} ${g.lines === 1 ? 'sentence' : 'sentences'}</span>
          <p>First heard ${shortDate(g.firstHeard)} · last heard ${shortDate(g.lastHeard)}</p>
          ${g.hasClip ? `<audio controls preload="none" src="${guestClipUrl(g.id)}"></audio>` : ''}
          ${naming === g.id ? `
            <form data-name-guest="${g.id}" class="name-guest">
              <div class="row">
                <label>Name <input name="name" required placeholder="Raj" /></label>
                <label>Relation <input name="relation" placeholder="Neighbor" /></label>
              </div>
              <label>About them <textarea name="blurb" rows="2" placeholder="Lives next door. Brings the newspaper."></textarea></label>
              <button type="submit">Save person</button>
              <button type="button" class="link" data-cancel-naming>Cancel</button>
            </form>` : ''}
        </div>
        <div class="actions">
          ${naming === g.id ? '' : `<button class="link" data-name="${g.id}">Name this person</button>`}
          <button class="link" data-forget-guest="${g.id}">Forget</button>
        </div>
      </li>`).join('')}
    </ul>`
}

function render() {
  renderPlans()
  renderPatientVoice()
  renderVoices()
  $('people').innerHTML = data.people.length
    ? data.people.map(p => `
      <li>
        <div>
          <strong>${esc(p.name)}</strong> <span class="tag">${esc(p.relation)}</span> ${voiceTag(p)}
          ${p.blurb ? `<p>${esc(p.blurb)}</p>` : ''}
          ${p.voiceFile ? `<audio controls src="${fileUrl(p.voiceFile)}"></audio>` : ''}
          ${busy.has(p.id) ? '<p class="status">Transcribing…</p>'
            : p.transcript ? `<details><summary>What they said</summary>${esc(p.transcript)}</details>` : ''}
        </div>
        <div class="actions">
          ${p.voiceFile ? `<button class="link" data-transcribe="${p.id}">${p.transcript ? 'Transcribe again' : 'Transcribe'}</button>` : ''}
          <button class="link" data-rerecord="${p.id}">Re-record</button>
          <button class="link" data-del-person="${p.id}">Remove</button>
        </div>
      </li>`).join('')
    : '<li class="empty">No one added yet.</li>'

  $('prescriptions').innerHTML = data.prescriptions.length
    ? data.prescriptions.map(r => `
      <li>
        <div>
          ${r.file ? `<a href="${fileUrl(r.file)}" target="_blank">${esc(r.originalName)}</a>` : `<strong>${esc(r.originalName)}</strong>`}
          ${editing === r.id ? editRxForm(r) : `
          <p>${[r.doctor, r.date].filter(Boolean).map(esc).join(' · ')}</p>
          ${r.notes ? `<p>${esc(r.notes)}</p>` : ''}`}
          ${renderReading(r)}
        </div>
        <div class="actions">
          ${r.file ? `<button class="link" data-read-rx="${r.id}">${r.reading ? 'Read again' : 'Read medicines'}</button>` : ''}
          <button class="link" data-edit="${r.id}">Edit</button>
          <button class="link" data-del-rx="${r.id}">Remove</button>
        </div>
      </li>`).join('')
    : '<li class="empty">No prescriptions yet.</li>'

  renderMedicines()
}

async function readRx(id: string) {
  const rx = data.prescriptions.find(r => r.id === id)
  if (!rx) return
  busy.add(id)
  render()
  try {
    rx.reading = await readPrescription(rx.file)
    delete rx.readError
  } catch (err) {
    rx.readError = `Couldn't read this prescription: ${(err as Error).message}`
  }
  busy.delete(id)
  await saveData(data)
  render()
}

async function transcribePerson(id: string) {
  const person = data.people.find(p => p.id === id)
  if (!person) return
  busy.add(id)
  render()
  try {
    person.transcript = await transcribe(person.voiceFile)
  } catch (err) {
    recStatus.textContent = (`Couldn't transcribe ${person.name}'s recording: ${(err as Error).message}`)
  }
  busy.delete(id)
  await saveData(data)
  render()
}

// Patient
$<HTMLInputElement>('patient-name').addEventListener('change', e => {
  data.patient.name = (e.target as HTMLInputElement).value.trim()
  saveData(data)
})

$<HTMLInputElement>('patient-zip').addEventListener('change', e => {
  data.patient.zip = (e.target as HTMLInputElement).value.trim()
  saveData(data)
})

$('ics-btn').addEventListener('click', async () => downloadIcs(data, await loadPlans().catch(() => [])))

// Voice recording
const MAX_SECONDS = 30

function voiceRecorder(prefix: string, idleLabel: string, onRecorded: (blob: Blob) => void = () => {}) {
  const btn = $<HTMLButtonElement>(`${prefix}-btn`)
  const status = $(`${prefix}-status`)
  const preview = $<HTMLAudioElement>(`${prefix}-preview`)
  let recorder: MediaRecorder | null = null
  let timer = 0
  const r = {
    blob: null as Blob | null,
    status,
    reset() {
      r.blob = null
      preview.hidden = true
      preview.removeAttribute('src')
      status.textContent = 'No recording yet'
      btn.textContent = idleLabel
    },
  }
  btn.addEventListener('click', async () => {
    if (recorder?.state === 'recording') {
      recorder.stop()
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      status.textContent = 'Microphone blocked. Allow microphone access in the browser and try again.'
      return
    }
    const chunks: Blob[] = []
    recorder = new MediaRecorder(stream)
    recorder.ondataavailable = e => chunks.push(e.data)
    recorder.onstop = () => {
      clearInterval(timer)
      stream.getTracks().forEach(t => t.stop())
      r.blob = new Blob(chunks, { type: recorder!.mimeType })
      preview.src = URL.createObjectURL(r.blob)
      preview.hidden = false
      status.textContent = 'Recorded. Play it back to check, or record again.'
      btn.textContent = '● Record again'
      onRecorded(r.blob)
    }
    recorder.start()
    const started = Date.now()
    btn.textContent = '■ Stop'
    status.textContent = `Recording… 0s / ${MAX_SECONDS}s`
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000)
      status.textContent = `Recording… ${s}s / ${MAX_SECONDS}s`
      if (s >= MAX_SECONDS) recorder?.stop()
    }, 250)
  })
  return r
}

const extFor = (blob: Blob) => (blob.type.includes('mp4') ? 'mp4' : 'webm')
const personRec = voiceRecorder('rec', '● Record voice')
const recStatus = personRec.status

// The patient's own voice is saved as soon as it's recorded
const patientRec = voiceRecorder('pv', "● Record patient's voice", async blob => {
  const old = data.patient.voiceFile
  data.patient.voiceFile = await uploadFile(blob, `patient.${extFor(blob)}`)
  await saveData(data)
  if (old) await removeFile(old).catch(() => {})
  patientRec.status.textContent = 'Saved. HALO is learning the voice…'
})

// Listen live: the browser mic, matched against the saved samples
const liveBtn = $<HTMLButtonElement>('live-btn')
const liveStatus = $('live-status')
let live: LiveAudio | null = null

function addLiveLine(clip: HeardClip) {
  const li = document.createElement('li')
  li.className = clip.match?.kind ?? 'unknown'
  const time = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  li.innerHTML = `<div class="who"><b>${esc(matchLabel(clip))}</b> · ${time}</div>
    <div>${esc(clip.text)}</div>${clip.summary ? `<div class="hint">Plan heard: ${esc(clip.summary)}</div>` : ''}`
  $('live-lines').prepend(li)
  liveStatus.textContent = 'Listening…'
}

liveBtn.addEventListener('click', async () => {
  if (live) {
    liveBtn.disabled = true
    liveStatus.textContent = 'Finishing the last sentence…'
    await live.stop().catch(() => {})
    live = null
    liveBtn.disabled = false
    liveBtn.textContent = '● Listen live'
    liveBtn.classList.remove('on')
    liveStatus.textContent = 'Stopped.'
    return
  }
  try {
    live = await startLiveAudio({
      onHeard: addLiveLine,
      onSending: () => { liveStatus.textContent = 'Transcribing and matching…' },
      onError: err => { liveStatus.textContent = `Couldn't send that: ${(err as Error).message}` },
    })
  } catch (err) {
    liveStatus.textContent = (err as Error).name === 'NotAllowedError'
      ? 'Microphone blocked. Allow microphone access in the browser and try again.'
      : `Couldn't start the microphone: ${(err as Error).message}`
    return
  }
  liveBtn.textContent = '■ Stop listening'
  liveBtn.classList.add('on')
  liveStatus.textContent = voices && !voices.ready ? 'Listening, but voice matching is off (see below).' : 'Listening…'
})

const whoBtn = $<HTMLButtonElement>('who-btn')
let who: LiveAudio | null = null
whoBtn.addEventListener('click', async () => {
  if (who) {
    await who.stop().catch(() => {})
    who = null
    whoBtn.textContent = 'Test match'
    liveStatus.textContent = 'Stopped.'
    return
  }
  try {
    who = await startWhoAudio({
      onHeard: clip => { liveStatus.textContent = matchLabel(clip) },
      onError: err => { liveStatus.textContent = `Couldn't match that: ${(err as Error).message}` },
    })
  } catch (err) {
    liveStatus.textContent = (err as Error).name === 'NotAllowedError'
      ? 'Microphone blocked. Allow microphone access in the browser and try again.'
      : `Couldn't start the microphone: ${(err as Error).message}`
    return
  }
  whoBtn.textContent = '■ Stop test'
  liveStatus.textContent = 'Say a sentence. This names you without adding it to the calendar.'
})

// People
$<HTMLFormElement>('person-form').addEventListener('submit', async e => {
  e.preventDefault()
  const recording = personRec.blob
  if (!recording) {
    recStatus.textContent = 'Record a voice sample before saving.'
    return
  }
  const saveBtn = $<HTMLButtonElement>('person-save')
  saveBtn.disabled = true
  const name = $<HTMLInputElement>('p-name').value.trim()
  const ext = extFor(recording)
  const id = crypto.randomUUID()
  data.people.push({
    id,
    name,
    relation: $<HTMLInputElement>('p-relation').value.trim(),
    blurb: $<HTMLTextAreaElement>('p-blurb').value.trim(),
    voiceFile: await uploadFile(recording, `${name || 'voice'}.${ext}`),
    createdAt: new Date().toISOString(),
  })
  await saveData(data)
  ;(e.target as HTMLFormElement).reset()
  personRec.reset()
  saveBtn.disabled = false
  render()
  transcribePerson(id)
})

// Prescriptions
$<HTMLFormElement>('rx-form').addEventListener('submit', async e => {
  e.preventDefault()
  const file = $<HTMLInputElement>('rx-file').files?.[0]
  if (!file) return
  const saveBtn = $<HTMLButtonElement>('rx-save')
  saveBtn.disabled = true
  const id = crypto.randomUUID()
  data.prescriptions.push({
    id,
    file: await uploadFile(file, file.name),
    originalName: file.name,
    doctor: $<HTMLInputElement>('rx-doctor').value.trim(),
    date: $<HTMLInputElement>('rx-date').value,
    notes: $<HTMLInputElement>('rx-notes').value.trim(),
    uploadedAt: new Date().toISOString(),
  })
  await saveData(data)
  ;(e.target as HTMLFormElement).reset()
  saveBtn.disabled = false
  readRx(id)
})

// List buttons
document.addEventListener('click', async e => {
  const {
    delPerson, delRx, readRx: readId, transcribe: transcribeId, rerecord, prices: pricesKey,
    refillApprove, refillReject, refillRequote, refillReceived, price, doseTake, doseUndo, planApprove, planReject,
    edit, cancelEdit, stopMed, restartMed, hidePrices,
    name: nameId, forgetGuest: forgetId, cancelNaming,
  } = (e.target as HTMLElement).dataset
  if (nameId || cancelNaming !== undefined) {
    naming = nameId ?? null
    renderVoices()
    document.querySelector<HTMLInputElement>('.name-guest input')?.focus()
    return
  }
  if (forgetId) {
    await forgetGuest(forgetId)
    return load()
  }
  if (hidePrices) { delete prices[hidePrices]; render(); await clearPrices(hidePrices).catch(() => {}); return }
  if (edit) { editing = edit; return render() }
  if (cancelEdit !== undefined) { editing = null; return render() }
  if (stopMed) {
    const entry = allMedicines(data).find(x => x.key === stopMed)
    if (!entry || !confirm(`Stop ${entry.med.name}? It leaves the schedule and refills. You can start it again from the prescription.`)) return
    entry.med.stopped = true
    await saveData(data)
    return render()
  }
  if (restartMed) {
    const [rxId, i] = restartMed.split('|')
    const med = data.prescriptions.find(x => x.id === rxId)?.reading?.medicines[Number(i)]
    if (!med) return
    delete med.stopped
    await saveData(data)
    return render()
  }
  if (readId) return readRx(readId)
  if (transcribeId) return transcribePerson(transcribeId)
  if (rerecord) {
    const person = data.people.find(p => p.id === rerecord)
    const recording = personRec.blob
    if (!person || !recording) {
      recStatus.textContent = 'Record a new sample above, then click Re-record.'
      return
    }
    const old = person.voiceFile
    person.voiceFile = await uploadFile(recording, `${person.name || 'voice'}.${extFor(recording)}`)
    await saveData(data)
    if (old) await removeFile(old).catch(() => {})
    personRec.reset()
    recStatus.textContent = `Saved a new sample for ${person.name}. HALO is folding it into their voice.`
    return render()
  }
  if (pricesKey) return startPriceCheck(pricesKey)
  if (refillApprove) {
    if (!approver().trim()) {
      alert('Enter your name under the medicines first, so HALO can record who approved the refill.')
      $('refill-settings').querySelector<HTMLInputElement>('input[name="approver"]')?.focus()
      return
    }
    return refillStep(refillApprove, 'approve', { approvedBy: approver().trim(), expectedPriceCents: Number(price) })
  }
  if (planApprove || planReject) {
    try { await planAction((planApprove ?? planReject)!, planApprove ? 'approve' : 'reject') } catch (err) { alert(err instanceof Error ? err.message : String(err)) }
    return load()
  }
  if (doseTake || doseUndo) {
    const [medKey, slot] = (doseTake ?? doseUndo)!.split('|')
    ;(e.target as HTMLButtonElement).disabled = true
    try { await setDose(medKey, slot, Boolean(doseTake), 'family') } catch (err) { alert(err instanceof Error ? err.message : String(err)) }
    return load()
  }
  if (refillReject) return refillStep(refillReject, 'reject')
  if (refillRequote) return refillStep(refillRequote, 'requote')
  if (refillReceived) return refillStep(refillReceived, 'received')
  if (delPerson) {
    const p = data.people.find(x => x.id === delPerson)
    data.people = data.people.filter(x => x.id !== delPerson)
    if (p) await removeFile(p.voiceFile)
  } else if (delRx) {
    const r = data.prescriptions.find(x => x.id === delRx)
    data.prescriptions = data.prescriptions.filter(x => x.id !== delRx)
    if (data.stock) data.stock = Object.fromEntries(Object.entries(data.stock).filter(([k]) => !k.startsWith(`${delRx}:`)))
    if (r?.file) await removeFile(r.file)
  } else {
    return
  }
  await saveData(data)
  render()
})

async function refillStep(id: string, op: 'approve' | 'reject' | 'requote' | 'received', body?: object) {
  try {
    await refillAction(id, op, body)
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
  await load()
}

document.addEventListener('submit', async e => {
  const form = e.target as HTMLFormElement
  if (form.id !== 'refill-settings-form') return
  e.preventDefault()
  const dollars = Number(new FormData(form).get('limit'))
  try { localStorage.setItem(APPROVER_KEY, String(new FormData(form).get('approver') ?? '').trim()) } catch { /* private mode: the name just won't be remembered */ }
  try {
    await setRefillLimit(Math.round(dollars * 100))
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err))
  }
  ;(document.activeElement as HTMLElement | null)?.blur()
  await load()
})

// Editing a medicine or a prescription in place
document.addEventListener('submit', async e => {
  const form = e.target as HTMLFormElement
  const medKey = form.dataset.editMed
  const rxId = form.dataset.editRx
  if (!medKey && !rxId) return
  e.preventDefault()
  const f = new FormData(form)
  const text = (k: string) => String(f.get(k) ?? '').trim()
  if (medKey) {
    const entry = allMedicines(data).find(x => x.key === medKey)
    if (!entry) { editing = null; return render() }
    const times = parseTimes(text('times'))
    const error = form.querySelector<HTMLElement>('[data-edit-error]')!
    if (!text('name')) { error.textContent = 'Enter the medicine name.'; error.hidden = false; return }
    if (!times) { error.textContent = 'Enter times like 8:00 AM, 9:00 PM.'; error.hidden = false; return }
    const quantity = Number(text('quantity'))
    Object.assign(entry.med, {
      name: text('name'), strength: text('strength'), instructions: text('instructions'), times,
      quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : null,
    })
    delete prices[medKey]
    await clearPrices(medKey).catch(() => {})
  } else {
    const rx = data.prescriptions.find(x => x.id === rxId)
    if (rx) Object.assign(rx, { doctor: text('doctor'), date: text('date'), notes: text('notes') })
  }
  editing = null
  await saveData(data)
  render()
})

// A medicine typed in by hand becomes a prescription of its own, so it edits and refills like the others
$<HTMLFormElement>('med-form').addEventListener('submit', async e => {
  e.preventDefault()
  const val = (id: string) => $<HTMLInputElement>(id).value.trim()
  const error = $('m-error')
  const times = parseTimes(val('m-times'))
  if (!times) { error.textContent = 'Enter times like 8:00 AM, 9:00 PM.'; error.hidden = false; return }
  error.hidden = true
  const count = val('m-count') === '' ? null : Number(val('m-count'))
  const quantity = val('m-quantity') === '' ? count : Number(val('m-quantity'))
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  data.prescriptions.push({
    id, file: '', originalName: `${val('m-name')} ${val('m-strength')}`.trim(), doctor: val('m-doctor'), date: val('m-date'), notes: '', uploadedAt: now,
    reading: {
      medicines: [{ name: val('m-name'), strength: val('m-strength'), form: '', instructions: val('m-instructions'), times,
        quantity: quantity != null && Number.isInteger(quantity) && quantity > 0 ? quantity : null, refills: null }],
      appointments: [], notes: [], readAt: now,
    },
  })
  if (count != null && Number.isInteger(count) && count >= 0) data.stock = { ...data.stock, [`${id}:0`]: { count, at: now } }
  await saveData(data)
  ;(e.target as HTMLFormElement).reset()
  $<HTMLDetailsElement>('add-med-box').open = false
  render()
})

// A new pill count starts the refill cycle over
document.addEventListener('submit', async e => {
  const form = e.target as HTMLFormElement
  const guestId = form.dataset.nameGuest
  if (guestId) {
    e.preventDefault()
    const f = new FormData(form)
    const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!
    button.disabled = true
    try {
      const person = await nameGuest(guestId, { name: String(f.get('name') ?? ''), relation: String(f.get('relation') ?? ''), blurb: String(f.get('blurb') ?? '') })
      naming = null
      await load()
      if (person.voiceFile) void transcribePerson(person.id)
    } catch (err) {
      button.disabled = false
      form.insertAdjacentHTML('beforeend', `<p class="status error">${esc((err as Error).message)}</p>`)
    }
    return
  }
  const key = form.dataset.stock
  if (!key) return
  e.preventDefault()
  const count = Number(form.querySelector('input')!.value)
  if (!Number.isInteger(count) || count < 0) return
  data.stock = { ...data.stock, [key]: { count, at: new Date().toISOString() } }
  delete prices[key] // prices looked up for the old count no longer apply
  await Promise.all([saveData(data), clearPrices(key).catch(() => {})])
  render()
})

// Reload when data changes elsewhere, unless a request from this page is still running
onDataChanged(() => { if (!busy.size && !editing && !naming) load() })

load()

// Show how long a GoodRx lookup has been running
setInterval(() => {
  document.querySelectorAll<HTMLElement>('[data-elapsed]').forEach(el => {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(el.dataset.elapsed ?? '')) / 1000))
    el.textContent = Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : ''
  })
}, 1000)
