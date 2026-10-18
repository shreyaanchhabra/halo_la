import './style.css'
import {
  checkPrices, esc, fileUrl, loadData, loadDoses, loadPlans, loadPrices, onDataChanged, readPrescription, removeFile, saveData,
  transcribe, uploadFile,
} from './api'
import { allMedicines, daysLeft, pillsLeft, refillDue, type MedEntry } from './meds'
import { downloadIcs, formatTime, ymd } from './schedule'
import type { DoseLog, HaloData, PriceCheck, Prescription } from './types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let data: HaloData = { patient: { name: '' }, people: [], prescriptions: [] }
let doses: DoseLog[] = []
let prices: Record<string, PriceCheck> = {}
// Prescriptions and people with a request to Groq in progress
const busy = new Set<string>()
// Medicines whose GoodRx lookup this page already started on its own, so it only does it once
const autoChecked = new Set<string>()

async function load() {
  ;[data, doses, prices] = await Promise.all([loadData(), loadDoses(), loadPrices()])
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

function renderRefill(e: MedEntry) {
  const refill = data.refills?.[e.key]
  if (refill?.status === 'approved') {
    return `<p class="refill ok">Refill approved ${shortDate(refill.at)}${refill.pharmacy ? ` at ${esc(refill.pharmacy)}` : ''}${refill.price != null ? `, ${money(refill.price)}` : ''}. Order it with the pharmacy, then update the pill count.</p>`
  }
  if (!refillDue(e, data, doses) || refill?.status === 'dismissed') return ''
  const best = prices[e.key]?.quotes?.[0]
  return `
    <div class="refill due">
      <p><b>Refill needed:</b> about ${daysLeft(e, data, doses)} days of pills left.${best ? ` Cheapest on GoodRx: ${money(best.price)} at ${esc(best.pharmacy)}.` : ''}</p>
      <div class="refill-actions">
        <button data-approve="${e.key}">Approve refill</button>
        <button class="link" data-dismiss="${e.key}">Dismiss</button>
      </div>
    </div>`
}

function renderMedicines() {
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
          <p>Pills left: <b>${left ?? 'unknown'}</b>${days != null ? ` (about ${days} days)` : ''}</p>
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
    delPerson, delRx, readRx: readId, transcribe: transcribeId, prices: pricesKey, approve, dismiss,
  } = (e.target as HTMLElement).dataset
  if (readId) return readRx(readId)
  if (transcribeId) return transcribePerson(transcribeId)
  if (pricesKey) return startPriceCheck(pricesKey)
  if (approve) {
    const best = prices[approve]?.quotes?.[0]
    data.refills = { ...data.refills, [approve]: { status: 'approved', at: new Date().toISOString(), pharmacy: best?.pharmacy, price: best?.price } }
  } else if (dismiss) {
    data.refills = { ...data.refills, [dismiss]: { status: 'dismissed', at: new Date().toISOString() } }
  } else if (delPerson) {
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

// A new pill count starts the refill cycle over
document.addEventListener('submit', async e => {
  const form = e.target as HTMLFormElement
  const key = form.dataset.stock
  if (!key) return
  e.preventDefault()
  const count = Number(form.querySelector('input')!.value)
  if (!Number.isInteger(count) || count < 0) return
  data.stock = { ...data.stock, [key]: { count, at: new Date().toISOString() } }
  if (data.refills) delete data.refills[key]
  autoChecked.delete(key)
  await saveData(data)
  render()
})

// Reload when data changes elsewhere, unless a request from this page is still running
onDataChanged(() => { if (!busy.size) load() })

load()
