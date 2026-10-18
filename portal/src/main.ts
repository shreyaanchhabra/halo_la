import './style.css'
import {
  checkPrices, esc, fileUrl, loadData, loadDoses, loadPlans, loadPrices, loadRefills, onDataChanged, readPrescription, refillAction,
  planAction, removeFile, saveData, setDose, setRefillLimit, transcribe, uploadFile,
} from './api'
import { allMedicines, daysLeft, pillsLeft, refillDue, runningLow, supplyText, type MedEntry } from './meds'
import { downloadIcs, formatTime, ymd } from './schedule'
import { formatCents, type RefillState } from '../../shared/refill-types.ts'
import { dateLabel, planTitle, startOfDay, timeLabel } from '../../shared/format.ts'
import type { DoseLog, HaloData, Plan, PriceCheck, Prescription } from './types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let data: HaloData = { patient: { name: '' }, people: [], prescriptions: [] }
let doses: DoseLog[] = []
let prices: Record<string, PriceCheck> = {}
let refillState: RefillState | null = null
let plans: Plan[] = []
const APPROVER_KEY = 'halo.approver'
const approver = () => { try { return localStorage.getItem(APPROVER_KEY) ?? '' } catch { return '' } }
// Prescriptions and people with a request to Groq in progress
const busy = new Set<string>()
// Medicines whose GoodRx lookup this page already started on its own, so it only does it once
const autoChecked = new Set<string>()

async function load() {
  ;[data, doses, prices, refillState, plans] = await Promise.all([loadData(), loadDoses(), loadPrices(), loadRefills().catch(() => null), loadPlans().catch(() => [] as Plan[])])
  for (const [id, value] of [['patient-name', data.patient.name], ['patient-zip', data.patient.zip ?? '']]) {
    const input = $<HTMLInputElement>(id)
    if (document.activeElement !== input) input.value = value
  }
  render()
  autoCheckPrices()
}

const money = (n: number) => `$${n.toFixed(2)}`
const shortDate = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function renderPrices(e: MedEntry) {
  const p = prices[e.key]
  if (!p) return `<p class="status">No GoodRx prices yet.</p>`
  if (p.status === 'checking') return `<p class="status">Checking GoodRx with Browser Use… this usually takes 1 to 3 minutes.</p>`
  if (p.status === 'failed') return `<p class="status error">GoodRx lookup failed: ${esc(p.error ?? 'unknown error')}</p>`
  const quotes = p.quotes ?? []
  return `
    <div class="reading">
      <h4>GoodRx prices near ${esc(p.zip)}${p.quantity ? ` · qty ${p.quantity}` : ''}</h4>
      ${quotes.length ? `<div class="table-scroll"><table>${quotes.map(q => `
        <tr><td>${esc(q.pharmacy)}</td><td>${money(q.price)}</td><td>${esc(q.priceType)}</td></tr>`).join('')}</table></div>`
        : '<p class="status">No prices found.</p>'}
      ${p.note ? `<p class="status">${esc(p.note)}</p>` : ''}
      <p class="status">Checked ${p.checkedAt ? shortDate(p.checkedAt) : ''}${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">Open on GoodRx</a>` : ''}</p>
    </div>`
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

// Refill before it runs out: what the errands agent found, and what the family can do about it
function renderRefill(e: MedEntry) {
  const days = daysLeft(e, data, doses)
  const r = refillState?.refills.find(x => x.medKey === e.key && x.status !== 'cancelled' && x.status !== 'received')
  if (!r) return refillDue(e, data, doses) ? `<p class="refill due"><b>Refill needed:</b> about ${days} days of pills left. HALO is getting ready to look for one.</p>` : ''

  const link = r.quote ? ` <a href="/test-pharmacy/cart/${esc(r.quote.cartId)}" target="_blank" rel="noopener">View on the pharmacy site</a>` : ''
  switch (r.status) {
    case 'preparing':
      return `<p class="refill due"><b>Refill needed:</b> about ${days} days of pills left. HALO is checking the pharmacy for a price. Nothing will be bought until you approve it.</p>`
    case 'awaiting_approval': {
      const q = r.quote!
      const limit = refillState!.settings.spendingLimitCents
      const over = q.priceCents > limit
      const expired = Date.parse(q.expiresAt) <= Date.now()
      return `
        <div class="refill due">
          <p><b>Refill ${esc(r.medicine)}, ${formatCents(q.priceCents)}, approve?</b></p>
          <p>${q.quantity} tablets at ${esc(q.pharmacy)}. About ${days} days of pills left. <b>Nothing has been paid.</b> This price is good until ${esc(shortDate(q.expiresAt))}.${link}</p>
          ${over ? `<p class="warn">This is over your limit of ${formatCents(limit)}. Raise the limit above to approve it.</p>` : ''}
          ${expired ? '<p class="warn">This price has expired. Get a fresh price.</p>' : ''}
          <div class="refill-actions">
            <button data-refill-approve="${esc(r.id)}" data-price="${q.priceCents}" ${over || expired ? 'disabled' : ''}>Approve ${formatCents(q.priceCents)}</button>
            <button class="link" data-refill-reject="${esc(r.id)}">Not now</button>
            ${expired ? `<button class="link" data-refill-requote="${esc(r.id)}">Get a fresh price</button>` : ''}
          </div>
        </div>`
    }
    case 'ordering':
      return `<p class="refill ok"><b>Approved by ${esc(r.approvedBy ?? 'the family')}.</b> Placing the order with ${esc(r.quote?.pharmacy ?? 'the pharmacy')}…</p>`
    case 'ordered':
      return `
        <div class="refill ok">
          <p><b>Ordered:</b> ${formatCents(r.order!.priceCents)} for ${r.quantity} tablets, approved by ${esc(r.approvedBy ?? 'the family')}. Order ${esc(r.order!.id)}.</p>
          <p>${r.order!.method === 'delivery' ? 'Delivery' : 'Pickup'}: <b>${esc(shortDate(r.order!.readyAt))}</b>. It is on the <a href="/calendar.html">calendar</a>.</p>
          <div class="refill-actions"><button data-refill-received="${esc(r.id)}">I have it</button></div>
        </div>`
    case 'rejected':
      return `
        <div class="refill due">
          <p><b>Refill not requested.</b> About ${days} days of pills left. HALO will not ask again until you do.</p>
          <div class="refill-actions"><button class="secondary" data-refill-requote="${esc(r.id)}">Get a new price</button></div>
        </div>`
    default: // needs_review
      return `
        <div class="refill bad">
          <p><b>A person needs to look at this refill.</b> ${esc(r.error ?? '')}</p>
          <div class="refill-actions"><button class="secondary" data-refill-requote="${esc(r.id)}">Check the pharmacy again</button></div>
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
      <p class="hint">Errands agent: ${esc(refillState.driver)}. Every order needs a person's approval first.</p>
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
    if (!r) return 'getting ready to look for a refill'
    return ({ preparing: 'checking the pharmacy', awaiting_approval: 'waiting for your approval below', ordering: 'placing the order', ordered: 'ordered, on its way', rejected: 'you said not now', needs_review: 'needs a person to look' } as Record<string, string>)[r.status] ?? ''
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
          ${renderPrices(e)}
        </div>
        <div class="actions">
          <button class="link" data-prices="${e.key}" ${checking ? 'disabled' : ''}>${prices[e.key] ? 'Check prices again' : 'Check GoodRx prices'}</button>
        </div>
      </li>`
    }).join('')
    : '<li class="empty">No medicines yet. Upload a prescription above.</li>'
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

// When a refill comes due, look up prices once without waiting to be asked
function autoCheckPrices() {
  if (!data.patient.zip) return
  for (const e of allMedicines(data)) {
    if (refillDue(e, data, doses) && !prices[e.key] && !autoChecked.has(e.key)) {
      autoChecked.add(e.key)
      startPriceCheck(e.key)
    }
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
      ${r.medicines.length ? `<div class="table-scroll"><table>${r.medicines.map(m => `
        <tr>
          <td>${esc(`${m.name} ${m.strength}`)}</td>
          <td>${m.times.map(formatTime).join(', ') || 'No times found'}</td>
          <td>${esc(m.instructions)}${m.quantity != null ? ` · Qty ${m.quantity}` : ''}${m.refills != null ? ` · ${m.refills} refills` : ''}</td>
        </tr>`).join('')}</table></div>` : '<p class="status">No medicines found.</p>'}
      ${r.appointments.length ? `<h4>Appointments</h4><ul>${r.appointments.map(a =>
        `<li>${esc(a.title)}: ${esc(a.date)}${a.time ? ` at ${formatTime(a.time)}` : ''}</li>`).join('')}</ul>` : ''}
      ${r.notes.length ? `<h4>Care plan notes</h4><ul>${r.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </div>`
}

function render() {
  renderPlans()
  $('people').innerHTML = data.people.length
    ? data.people.map(p => `
      <li>
        <div>
          <strong>${esc(p.name)}</strong> <span class="tag">${esc(p.relation)}</span>
          ${p.blurb ? `<p>${esc(p.blurb)}</p>` : ''}
          <audio controls src="${fileUrl(p.voiceFile)}"></audio>
          ${busy.has(p.id) ? '<p class="status">Transcribing…</p>'
            : p.transcript ? `<details><summary>What they said</summary>${esc(p.transcript)}</details>` : ''}
        </div>
        <div class="actions">
          <button class="link" data-transcribe="${p.id}">${p.transcript ? 'Transcribe again' : 'Transcribe'}</button>
          <button class="link" data-del-person="${p.id}">Remove</button>
        </div>
      </li>`).join('')
    : '<li class="empty">No one added yet.</li>'

  $('prescriptions').innerHTML = data.prescriptions.length
    ? data.prescriptions.map(r => `
      <li>
        <div>
          <a href="${fileUrl(r.file)}" target="_blank">${esc(r.originalName)}</a>
          <p>${[r.doctor, r.date].filter(Boolean).map(esc).join(' · ')}</p>
          ${r.notes ? `<p>${esc(r.notes)}</p>` : ''}
          ${renderReading(r)}
        </div>
        <div class="actions">
          <button class="link" data-read-rx="${r.id}">${r.reading ? 'Read again' : 'Read medicines'}</button>
          <button class="link" data-del-rx="${r.id}">Remove</button>
        </div>
      </li>`).join('')
    : '<li class="empty">No prescriptions uploaded yet.</li>'

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
let recorder: MediaRecorder | null = null
let recording: Blob | null = null
let timer = 0

const recBtn = $<HTMLButtonElement>('rec-btn')
const recStatus = $('rec-status')
const recPreview = $<HTMLAudioElement>('rec-preview')

function resetRecording() {
  recording = null
  recPreview.hidden = true
  recPreview.removeAttribute('src')
  recStatus.textContent = 'No recording yet'
  recBtn.textContent = '● Record voice'
}

recBtn.addEventListener('click', async () => {
  if (recorder?.state === 'recording') {
    recorder.stop()
    return
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    recStatus.textContent = 'Microphone blocked. Allow microphone access in the browser and try again.'
    return
  }
  const chunks: Blob[] = []
  recorder = new MediaRecorder(stream)
  recorder.ondataavailable = e => chunks.push(e.data)
  recorder.onstop = () => {
    clearInterval(timer)
    stream.getTracks().forEach(t => t.stop())
    recording = new Blob(chunks, { type: recorder!.mimeType })
    recPreview.src = URL.createObjectURL(recording)
    recPreview.hidden = false
    recStatus.textContent = 'Recorded. Play it back to check, or record again.'
    recBtn.textContent = '● Record again'
  }
  recorder.start()
  const started = Date.now()
  recBtn.textContent = '■ Stop'
  recStatus.textContent = `Recording… 0s / ${MAX_SECONDS}s`
  timer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000)
    recStatus.textContent = `Recording… ${s}s / ${MAX_SECONDS}s`
    if (s >= MAX_SECONDS) recorder?.stop()
  }, 250)
})

// People
$<HTMLFormElement>('person-form').addEventListener('submit', async e => {
  e.preventDefault()
  if (!recording) {
    recStatus.textContent = 'Record a voice sample before saving.'
    return
  }
  const saveBtn = $<HTMLButtonElement>('person-save')
  saveBtn.disabled = true
  const name = $<HTMLInputElement>('p-name').value.trim()
  const ext = recording.type.includes('mp4') ? 'mp4' : 'webm'
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
  resetRecording()
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
    delPerson, delRx, readRx: readId, transcribe: transcribeId, prices: pricesKey,
    refillApprove, refillReject, refillRequote, refillReceived, price, doseTake, doseUndo, planApprove, planReject,
  } = (e.target as HTMLElement).dataset
  if (readId) return readRx(readId)
  if (transcribeId) return transcribePerson(transcribeId)
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
    try { await setDose(medKey, slot, Boolean(doseTake)) } catch (err) { alert(err instanceof Error ? err.message : String(err)) }
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
    if (r) await removeFile(r.file)
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

// A new pill count starts the refill cycle over
document.addEventListener('submit', async e => {
  const form = e.target as HTMLFormElement
  const key = form.dataset.stock
  if (!key) return
  e.preventDefault()
  const count = Number(form.querySelector('input')!.value)
  if (!Number.isInteger(count) || count < 0) return
  data.stock = { ...data.stock, [key]: { count, at: new Date().toISOString() } }
  autoChecked.delete(key)
  await saveData(data)
  render()
})

// Reload when data changes elsewhere, unless a request from this page is still running
onDataChanged(() => { if (!busy.size) load() })

load()
