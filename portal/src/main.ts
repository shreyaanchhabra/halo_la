import './style.css'
import {
  esc, fileUrl, loadData, onDataChanged, readPrescription, removeFile, saveData, transcribe, uploadFile,
} from './api'
import { downloadIcs, formatTime } from './schedule'
import type { HaloData, Prescription } from './types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let data: HaloData = { patient: { name: '' }, people: [], prescriptions: [] }
// Prescriptions and people with a request to Groq in progress
const busy = new Set<string>()

async function load() {
  data = await loadData()
  const nameInput = $<HTMLInputElement>('patient-name')
  if (document.activeElement !== nameInput) nameInput.value = data.patient.name
  render()
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

$('ics-btn').addEventListener('click', () => downloadIcs(data))

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
  const { delPerson, delRx, readRx: readId, transcribe: transcribeId } = (e.target as HTMLElement).dataset
  if (readId) return readRx(readId)
  if (transcribeId) return transcribePerson(transcribeId)
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

// Reload when data changes elsewhere, unless a request from this page is still running
onDataChanged(() => { if (!busy.size) load() })

load()
