import './patient.css'
import { addTranscript, esc, fileUrl, loadAsk, loadData, loadDoses, loadPlans, loadTranscripts, onDataChanged, planAction, setDose } from './api'
import { appointments, formatTime, scheduleFor, ymd, type ScheduleItem } from './schedule'
import type { DoseLog, GlassesState, HaloData, Plan, TranscriptLine } from './types'

const $ = (id: string) => document.getElementById(id)!

let data: HaloData = { patient: { name: '' }, people: [], prescriptions: [] }
let heard: TranscriptLine[] = []
let doses: DoseLog[] = []

const takenAt = (i: ScheduleItem) => doses.find(d => d.medKey === i.medKey && d.slot === i.slot)?.at
const clockTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

function doseControl(i: ScheduleItem) {
  if (i.kind !== 'medicine') return ''
  const at = takenAt(i)
  return at
    ? `<span class="taken">✓ Taken ${clockTime(at)} <button class="undo" data-undo="${esc(i.medKey!)}|${esc(i.slot!)}">Undo</button></span>`
    : `<button class="took" data-took="${esc(i.medKey!)}|${esc(i.slot!)}">I took it</button>`
}
let plans: Plan[] = []
let ask: GlassesState['prompt'] = null

const nowHHMM = () => {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function renderClock() {
  const now = new Date()
  const h = now.getHours()
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  const first = data.patient.name.split(' ')[0]
  $('greeting').textContent = first ? `${part}, ${first}` : part
  $('today-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  $('clock').textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function renderSchedule() {
  const items = scheduleFor(data, new Date(), plans)
  const now = nowHHMM()
  // Doses that are due and not yet taken come first, then whatever is next
  const open = items.filter(i => !takenAt(i))
  const next = open.find(i => i.kind === 'medicine' && i.time && i.time <= now) ?? open.find(i => !i.time || i.time >= now)

  $('next-up').innerHTML = next
    ? `<p class="label">Next</p>
       <p class="next-time">${next.time ? formatTime(next.time) : 'Today'}</p>
       <p class="next-title">${next.kind === 'medicine' ? 'Take ' : ''}${esc(next.title)}</p>
       <p class="next-detail">${esc(next.detail)}</p>
       ${doseControl(next)}`
    : `<p class="label">Next</p><p class="next-title">Nothing else planned today.</p>`

  $('today').innerHTML = items.length
    ? items.map(i => `
      <li class="${(i.kind === 'medicine' ? takenAt(i) : i.time && i.time < now) ? 'done' : ''} ${i === next ? 'is-next' : ''}">
        <span class="time">${i.time ? formatTime(i.time) : 'All day'}</span>
        <span><b>${i.kind === 'medicine' ? 'Take ' : ''}${esc(i.title)}</b><small>${esc(i.detail)}</small>${doseControl(i)}</span>
      </li>`).join('')
    : '<li class="empty">Nothing planned today.</li>'

  const today = ymd(new Date())
  const soon = appointments(data, plans).filter(a => a.date > today).slice(0, 5)
  $('upcoming').innerHTML = soon.length
    ? soon.map(a => {
      const day = new Date(`${a.date}T00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      return `<li><span class="time">${day}</span><span><b>${esc(a.title)}</b><small>${a.time ? formatTime(a.time) : 'All day'}</small></span></li>`
    }).join('')
    : '<li class="empty">No appointments coming up.</li>'
}

// A plan HALO heard, waiting for the patient to say yes or no (or press a button)
function renderAsk() {
  const box = $('ask')
  box.hidden = !ask
  if (!ask) { box.innerHTML = ''; return }
  const [question, title, when, , hint] = ask.lines
  box.innerHTML = `
    <p class="label">${esc(question)}</p>
    <p class="ask-title">${esc(title)}</p>
    <p class="ask-when">${esc(when)}</p>
    <p class="ask-hint">${esc(hint)}</p>
    <div class="ask-buttons">
      <button type="button" data-answer="yes">Yes</button>
      <button type="button" data-answer="no" class="secondary">No</button>
    </div>`
  box.querySelectorAll<HTMLButtonElement>('[data-answer]').forEach(b =>
    b.addEventListener('click', async () => { b.disabled = true; await planAction(ask!.id, b.dataset.answer as 'yes' | 'no').catch(() => {}) }))
}

function render() {
  renderClock()
  renderSchedule()
  renderAsk()

  $('people').innerHTML = data.people.length
    ? data.people.map(p => `
      <li>
        <p class="who">${esc(p.name)}</p>
        <p class="relation">${esc(p.relation)}</p>
        ${p.blurb ? `<p>${esc(p.blurb)}</p>` : ''}
        <audio controls preload="none" src="${fileUrl(p.voiceFile)}"></audio>
        ${p.transcript ? `<details><summary>What ${esc(p.name.split(' ')[0])} said</summary><p>${esc(p.transcript)}</p></details>` : ''}
      </li>`).join('')
    : '<li class="empty">Your family will add people here.</li>'

  const meds = data.prescriptions.flatMap(rx => rx.reading?.medicines ?? [])
  $('medicines').innerHTML = meds.length
    ? meds.map(m => `
      <li>
        <b>${esc(`${m.name} ${m.strength}`)}</b>
        <span>${m.times.map(formatTime).join(' and ')}</span>
        <small>${esc(m.instructions)}</small>
      </li>`).join('')
    : '<li class="empty">No medicines yet.</li>'

  const notes = data.prescriptions.flatMap(rx => (rx.reading?.notes ?? []).map(n => ({ n, doctor: rx.doctor })))
  $('doctor-notes').innerHTML = notes.length
    ? notes.map(({ n, doctor }) => `<li>${esc(n)}${doctor ? `<small>${esc(doctor)}</small>` : ''}</li>`).join('')
    : '<li class="empty">No notes yet.</li>'
}

function renderHeard() {
  $('heard').innerHTML = heard.slice(-8).reverse().map(l => `
    <li><span class="time">${clockTime(l.at)}</span>${esc(l.text)}</li>`).join('')
}

async function load() {
  ;[data, doses, plans, ask] = await Promise.all([loadData(), loadDoses(), loadPlans(), loadAsk().then(s => s.prompt)])
  render()
}

document.addEventListener('click', async e => {
  const { took, undo } = (e.target as HTMLElement).dataset
  const target = took ?? undo
  if (!target) return
  const [medKey, slot] = target.split('|')
  ;(e.target as HTMLButtonElement).disabled = true
  await setDose(medKey, slot, Boolean(took))
  doses = await loadDoses()
  renderSchedule()
})

async function loadHeard() {
  heard = await loadTranscripts()
  renderHeard()
}

// ---- Live transcript with the browser's speech recognition ----

const Recognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
const listenBtn = $('listen-btn') as HTMLButtonElement
const caption = $('live-caption')
let listening = false
let recognizer: any = null

function stopListening(message: string) {
  listening = false
  recognizer?.stop()
  listenBtn.textContent = 'Start listening'
  listenBtn.classList.remove('on')
  caption.textContent = message
}

if (!Recognition) {
  listenBtn.disabled = true
  caption.textContent = "This browser can't transcribe speech. Open this page in Chrome or Safari."
}

listenBtn.addEventListener('click', () => {
  if (listening) return stopListening('Paused.')

  recognizer = new Recognition()
  recognizer.continuous = true
  recognizer.interimResults = true
  recognizer.lang = 'en-US'
  recognizer.onresult = (e: any) => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript.trim()
      if (e.results[i].isFinal) {
        if (text) addTranscript(text)
      } else {
        interim += `${text} `
      }
    }
    caption.textContent = interim.trim() || 'Listening…'
  }
  recognizer.onerror = (e: any) => {
    if (e.error === 'not-allowed') stopListening('Microphone blocked. Allow microphone access in the browser and try again.')
  }
  // The browser stops after a pause in speech; keep going until the patient presses Stop
  recognizer.onend = () => { if (listening) recognizer.start() }
  recognizer.start()
  listening = true
  listenBtn.textContent = 'Stop listening'
  listenBtn.classList.add('on')
  caption.textContent = 'Listening…'
})

// Changes in the care portal show up here straight away
onDataChanged(() => { load(); loadHeard() })
setInterval(() => { renderClock(); renderSchedule() }, 30_000)

load()
loadHeard()
