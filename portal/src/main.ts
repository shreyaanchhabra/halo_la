import './style.css'

type Person = {
  id: string
  name: string
  relation: string
  blurb: string
  voiceFile: string
  createdAt: string
}

type Prescription = {
  id: string
  file: string
  originalName: string
  doctor: string
  date: string
  notes: string
  uploadedAt: string
}

type HaloData = {
  patient: { name: string }
  people: Person[]
  prescriptions: Prescription[]
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let data: HaloData = { patient: { name: '' }, people: [], prescriptions: [] }

async function load() {
  const saved = await (await fetch('/api/data')).json()
  data = { ...data, ...saved }
  $<HTMLInputElement>('patient-name').value = data.patient.name
  render()
}

async function save() {
  await fetch('/api/data', { method: 'PUT', body: JSON.stringify(data) })
}

async function upload(blob: Blob, name: string): Promise<string> {
  const res = await fetch(`/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob })
  return (await res.json()).file
}

async function removeFile(file: string) {
  await fetch(`/api/files/${encodeURIComponent(file)}`, { method: 'DELETE' })
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

function render() {
  $('people').innerHTML = data.people.length
    ? data.people.map(p => `
      <li>
        <div>
          <strong>${esc(p.name)}</strong> <span class="tag">${esc(p.relation)}</span>
          ${p.blurb ? `<p>${esc(p.blurb)}</p>` : ''}
          <audio controls src="/api/files/${encodeURIComponent(p.voiceFile)}"></audio>
        </div>
        <button class="link" data-del-person="${p.id}">Remove</button>
      </li>`).join('')
    : '<li class="empty">No one added yet.</li>'

  $('prescriptions').innerHTML = data.prescriptions.length
    ? data.prescriptions.map(r => `
      <li>
        <div>
          <a href="/api/files/${encodeURIComponent(r.file)}" target="_blank">${esc(r.originalName)}</a>
          <p>${[r.doctor, r.date].filter(Boolean).map(esc).join(' · ')}</p>
          ${r.notes ? `<p>${esc(r.notes)}</p>` : ''}
        </div>
        <button class="link" data-del-rx="${r.id}">Remove</button>
      </li>`).join('')
    : '<li class="empty">No prescriptions uploaded yet.</li>'
}

// Patient
$<HTMLInputElement>('patient-name').addEventListener('change', e => {
  data.patient.name = (e.target as HTMLInputElement).value.trim()
  save()
})

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
  const voiceFile = await upload(recording, `${name || 'voice'}.${ext}`)
  data.people.push({
    id: crypto.randomUUID(),
    name,
    relation: $<HTMLInputElement>('p-relation').value.trim(),
    blurb: $<HTMLTextAreaElement>('p-blurb').value.trim(),
    voiceFile,
    createdAt: new Date().toISOString(),
  })
  await save()
  ;(e.target as HTMLFormElement).reset()
  resetRecording()
  saveBtn.disabled = false
  render()
})

// Prescriptions
$<HTMLFormElement>('rx-form').addEventListener('submit', async e => {
  e.preventDefault()
  const file = $<HTMLInputElement>('rx-file').files?.[0]
  if (!file) return
  const saveBtn = $<HTMLButtonElement>('rx-save')
  saveBtn.disabled = true
  data.prescriptions.push({
    id: crypto.randomUUID(),
    file: await upload(file, file.name),
    originalName: file.name,
    doctor: $<HTMLInputElement>('rx-doctor').value.trim(),
    date: $<HTMLInputElement>('rx-date').value,
    notes: $<HTMLInputElement>('rx-notes').value.trim(),
    uploadedAt: new Date().toISOString(),
  })
  await save()
  ;(e.target as HTMLFormElement).reset()
  saveBtn.disabled = false
  render()
})

// Remove buttons
document.addEventListener('click', async e => {
  const el = e.target as HTMLElement
  const personId = el.dataset.delPerson
  const rxId = el.dataset.delRx
  if (personId) {
    const p = data.people.find(x => x.id === personId)
    data.people = data.people.filter(x => x.id !== personId)
    if (p) await removeFile(p.voiceFile)
  } else if (rxId) {
    const r = data.prescriptions.find(x => x.id === rxId)
    data.prescriptions = data.prescriptions.filter(x => x.id !== rxId)
    if (r) await removeFile(r.file)
  } else {
    return
  }
  await save()
  render()
})

load()
