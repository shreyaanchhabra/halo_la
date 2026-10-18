import './style.css'
import './month.css'
import './calendar.css'
import {
  addPlan, addTranscript, deletePlan, editPlan, esc, loadData, loadPlans, loadPresent, loadTranscripts, onDataChanged, planAction, setPresent,
} from './api'
import { appointments, formatTime, scheduleFor, ymd } from './schedule'
import { dateLabel, googleCalendarUrl, planTitle, timeLabel } from '../../shared/format.ts'
import { longDate, monthGridHtml, monthStart, monthTitle, shiftMonth, type Mark } from './month.ts'
import type { HaloData, Plan, TranscriptLine } from './types'

// Care portal calendar: a month grid of plans HALO picked up from conversation and the appointments from
// prescriptions, what needs the family's approval, adding and syncing, and a box to try it without speaking.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let data: HaloData = { patient: { name: '' }, people: [], prescriptions: [] }
let plans: Plan[] = []
let lines: TranscriptLine[] = []
let present: string[] = []
let online = true
let editing: string | null = null
const today = () => ymd(new Date())
let selected = today()
let view = monthStart(new Date())
const shown: Record<string, string> = {}

const patientName = () => data.patient.name.split(' ')[0] || 'the patient'
const dayOf = (iso: string) => ymd(new Date(iso))

// Only touch the page when what it shows has changed, so typing and focus are never disturbed
function setHtml(id: string, html: string) {
  if (shown[id] === html) return
  shown[id] = html
  $(id).innerHTML = html
}

const toLocalInput = (iso: string) => {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const fromLocalInput = (v: string, allDay: boolean) => (allDay ? new Date(`${v.slice(0, 10)}T00:00`) : new Date(v)).toISOString()
const splitNames = (s: string) => s.split(',').map(n => n.trim()).filter(Boolean)

// ---- events ---------------------------------------------------------------------------------------------

const origin = (p: Plan) => (p.confirmedBy === 'patient' ? 'Confirmed by voice' : p.confirmedBy === 'family' ? (p.source ? 'Approved by family' : 'Added by family') : '')
const when = (p: Plan) => `${p.allDay ? '' : `${timeLabel(new Date(p.start))}, `}${dateLabel(new Date(p.start))}`

function heardLine(p: Plan): string {
  if (!p.source) return ''
  const line = lines.find(l => l.id === p.source!.lineId)
  const who = line?.speaker && line.speaker !== 'unknown' ? `${esc(line.speaker)}, ` : ''
  const at = line ? ` <span class="muted">(${who}${timeLabel(new Date(line.at))})</span>` : ''
  return `<p class="quote"><button class="link" data-act="heard" data-line="${esc(p.source.lineId)}">Heard</button>: “${esc(p.source.quote)}”${at}</p>`
}

function editForm(p: Plan): string {
  return `
    <form class="edit" data-id="${p.id}">
      <label>What <input name="activity" value="${esc(p.activity)}" required /></label>
      <label>With <input name="who" value="${esc(p.who.join(', '))}" placeholder="Maya, Paul" /></label>
      <div class="row">
        <label>When <input name="start" type="${p.allDay ? 'date' : 'datetime-local'}" value="${p.allDay ? toLocalInput(p.start).slice(0, 10) : toLocalInput(p.start)}" required /></label>
        <label class="check"><input name="allDay" type="checkbox" ${p.allDay ? 'checked' : ''} /> All day</label>
      </div>
      <div class="actions"><button type="submit">Save</button><button type="button" class="link" data-act="cancel">Cancel</button></div>
    </form>`
}

function eventItem(p: Plan): string {
  if (editing === p.id) return `<li class="ev">${editForm(p)}</li>`
  const start = new Date(p.start)
  const past = !p.allDay && start.getTime() < Date.now()
  return `
    <li class="ev${past ? ' past' : ''}">
      <div>
        <p><strong class="time">${p.allDay ? 'All day' : timeLabel(start)}</strong> ${esc(planTitle(p))}</p>
        <p class="tags">${origin(p) ? `<span class="tag">${origin(p)}</span>` : ''}${p.conflictWith ? '<span class="tag warn">Overlaps another event</span>' : ''}</p>
        ${heardLine(p)}
      </div>
      <div class="actions">
        <a href="${googleCalendarUrl(p)}" target="_blank" rel="noopener">Google Calendar</a>
        <button class="link" data-act="edit" data-id="${p.id}">Edit</button>
        <button class="link" data-act="delete" data-id="${p.id}">Delete</button>
      </div>
    </li>`
}

function approvalItem(p: Plan): string {
  if (editing === p.id) return `<li class="ev">${editForm(p)}</li>`
  return `
    <li class="ev need">
      <div>
        <p><strong>${esc(planTitle(p))}</strong> <span class="muted">${esc(when(p))}</span></p>
        <p class="tags">${p.conflictWith ? '<span class="tag warn">Overlaps another event</span>' : ''}</p>
        ${heardLine(p)}
      </div>
      <div class="actions">
        <button data-act="approve" data-id="${p.id}">Add to calendar</button>
        <button class="link" data-act="edit" data-id="${p.id}">Edit</button>
        <button class="link" data-act="reject" data-id="${p.id}">Don’t add</button>
      </div>
    </li>`
}

// ---- month grid -------------------------------------------------------------------------------------------

function marksFor(day: string): Mark[] {
  const out: Mark[] = []
  for (const p of plans) {
    if (dayOf(p.start) !== day || p.status === 'declined' || p.status === 'rejected') continue
    out.push({ time: p.allDay ? '' : timeLabel(new Date(p.start)), label: planTitle(p), cls: p.status === 'confirmed' ? '' : 'pending', at: p.allDay ? new Date(`${day}T00:00`).getTime() : new Date(p.start).getTime() })
  }
  for (const a of appointments(data).filter(x => x.date === day)) out.push({ time: a.time ? formatTime(a.time) : '', label: a.title, cls: 'appt', at: new Date(`${day}T${a.time ?? '00:00'}`).getTime() })
  return out
}

function renderMonth() {
  const dayPlans = plans.filter(p => dayOf(p.start) === selected && p.status === 'confirmed').sort((a, b) => a.start.localeCompare(b.start))
  const items = scheduleFor(data, new Date(`${selected}T12:00`)).filter(i => i.kind !== 'plan')
  const meds = items.filter(i => i.kind === 'medicine')
  const appts = items.filter(i => i.kind === 'appointment')
  const upcomingMonth = monthTitle(view)

  setHtml('calendar', `
    <div class="month-head">
      <h2>${esc(upcomingMonth)}</h2>
      <button type="button" class="secondary" data-act="prev" aria-label="Previous month">‹</button>
      <button type="button" class="secondary" data-act="now">Today</button>
      <button type="button" class="secondary" data-act="next" aria-label="Next month">›</button>
    </div>
    ${monthGridHtml({ view, selected, today: today(), marksFor })}
    <p class="hint"><span class="chip">Confirmed</span> <span class="chip pending">Waiting for a yes</span> <span class="chip appt">Doctor appointment</span></p>
    <h3>${esc(longDate(selected))}</h3>
    ${dayPlans.length || appts.length ? `<ul class="list">${dayPlans.map(eventItem).join('')}${appts.map(a => `<li class="ev"><div><p><strong class="time">${a.time ? formatTime(a.time) : 'All day'}</strong> ${esc(a.title)}</p><p class="tags"><span class="tag">From a prescription</span></p></div></li>`).join('')}</ul>` : '<p class="empty hint">Nothing planned this day.</p>'}
    ${meds.length ? `<details><summary>Medicine times (${meds.length})</summary><ul class="list">${meds.map(m => `<li class="ev"><div><p><strong class="time">${m.time ? formatTime(m.time) : ''}</strong> ${esc(m.title)}</p></div></li>`).join('')}</ul></details>` : ''}`)
}

function renderNeeds() {
  const needs = plans.filter(p => p.status === 'needs_approval').sort((a, b) => a.start.localeCompare(b.start))
  const asking = plans.filter(p => p.status === 'asked' || p.status === 'queued')
  $('needs').hidden = !needs.length && !asking.length
  const skipped = plans.filter(p => p.status === 'declined' || p.status === 'rejected')
  setHtml('needs', [
    needs.length ? `<h2>Needs your approval (${needs.length})</h2><p class="hint">${esc(patientName())} didn’t answer, so nothing was added.</p><ul class="list">${needs.map(approvalItem).join('')}</ul>` : '',
    asking.length ? `<h3>Asking ${esc(patientName())} now</h3><ul class="list">${asking.map(p => `<li class="ev"><div><p>${esc(planTitle(p))} <span class="muted">${esc(when(p))}</span></p>${heardLine(p)}<p class="hint">${p.status === 'queued' ? 'Next in line.' : 'Waiting for a spoken yes or no.'}</p></div></li>`).join('')}</ul>` : '',
    skipped.length ? `<details><summary>Not added (${skipped.length})</summary><ul class="list">${skipped.map(p => `<li class="ev past"><div><p>${esc(planTitle(p))} <span class="muted">${esc(when(p))}</span></p><p class="tags"><span class="tag">${p.status === 'declined' ? `${esc(patientName())} said no` : 'Family said no'}</span></p></div></li>`).join('')}</ul></details>` : '',
  ].join(''))
}

// ---- adding, syncing, trying it out ----------------------------------------------------------------------

function mount() {
  $('add').innerHTML = `
    <h2>Add an event</h2>
    <form id="add-form">
      <div class="row">
        <label>What <input name="activity" required placeholder="Dentist appointment" /></label>
        <label>With <input name="who" placeholder="Maya, Paul" /></label>
      </div>
      <div class="row">
        <label>When <input name="start" type="datetime-local" required /></label>
        <label class="check"><input name="allDay" type="checkbox" /> All day</label>
      </div>
      <button type="submit">Add to calendar</button>
      <p class="hint" id="add-error" role="alert"></p>
    </form>`

  const feed = `${location.origin}/api/calendar.ics`
  $('sync').innerHTML = `
    <h2>Use it in your own calendar</h2>
    <p class="hint">Every event above has a <b>Google Calendar</b> button that opens it ready to save. To keep a whole calendar in sync, subscribe once: medicines, appointments and plans show up in Apple Calendar, Google Calendar or Outlook, with a reminder an hour before plans.</p>
    <div class="actions">
      <a class="button" href="${feed.replace(/^https?:/, 'webcal:')}">Open in Apple Calendar</a>
      <button type="button" id="copy-feed">Copy calendar link</button>
      <span class="hint" id="copied" role="status"></span>
    </div>
    <p class="hint">Google Calendar: Settings → Add calendar → From URL. That needs a link reachable from the internet, so use the copied link once HALO is hosted. Until then, download the file with “Add to calendar (.ics)” on the setup page.</p>`
  $('copy-feed').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(feed); $('copied').textContent = 'Copied.' } catch { $('copied').textContent = feed }
  })

  $('presence').innerHTML = `
    <h2>Who is here?</h2>
    <p class="hint">Until HALO can tell voices apart, say who is visiting so plans get the right name (“I’ll come Saturday” becomes “Maya: …”).</p>
    <div class="chips" id="present-chips"></div>`

  $('conversation').innerHTML = `
    <h2>Conversation</h2>
    <p class="hint">What HALO has heard. Type a sentence to try it without speaking. Plans start with “Set an event for …”.</p>
    <form id="say-form" class="say">
      <label>Speaker <select id="say-speaker"></select></label>
      <label>Says <input id="say-text" required autocomplete="off" placeholder="Set an event for soccer tomorrow at 4 PM" /></label>
      <button type="submit" id="say-btn">Send</button>
    </form>
    <p class="hint" id="say-result" role="status"></p>
    <ul class="list transcript" id="transcript"></ul>`

  $<HTMLFormElement>('add-form').addEventListener('submit', async e => {
    e.preventDefault()
    const f = e.target as HTMLFormElement
    const v = (n: string) => f.elements.namedItem(n) as HTMLInputElement
    const allDay = v('allDay').checked
    try {
      await addPlan({ activity: v('activity').value, who: splitNames(v('who').value), start: fromLocalInput(v('start').value, allDay), allDay })
      f.reset()
      $('add-error').textContent = ''
      await refresh()
    } catch (err) { $('add-error').textContent = String(err instanceof Error ? err.message : err) }
  })

  $<HTMLFormElement>('say-form').addEventListener('submit', async e => {
    e.preventDefault()
    const text = $<HTMLInputElement>('say-text')
    const btn = $<HTMLButtonElement>('say-btn')
    btn.disabled = true
    $('say-result').textContent = 'Listening…'
    try {
      const r = await addTranscript(text.value, $<HTMLSelectElement>('say-speaker').value)
      $('say-result').textContent = RESULT[r.kind]?.(r.summary ?? '') ?? r.kind
      text.value = ''
      await refresh()
    } catch (err) { $('say-result').textContent = String(err instanceof Error ? err.message : err) }
    btn.disabled = false
    text.focus()
  })

  // One listener for every button on the page
  document.addEventListener('click', async e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (!el) return
    const { act, id, name, line, day } = el.dataset
    try {
      if (act === 'approve' || act === 'reject') await planAction(id!, act)
      else if (act === 'delete') { if (confirm('Remove this event from the calendar?')) await deletePlan(id!) }
      else if (act === 'edit') editing = id!
      else if (act === 'cancel') editing = null
      else if (act === 'present') await setPresent(present.includes(name!) ? present.filter(n => n !== name) : [...present, name!])
      else if (act === 'day') { selected = day!; const d = new Date(`${day}T00:00`); if (d.getMonth() !== view.getMonth()) view = monthStart(d) }
      else if (act === 'prev') view = shiftMonth(view, -1)
      else if (act === 'next') view = shiftMonth(view, 1)
      else if (act === 'now') { selected = today(); view = monthStart(new Date()) }
      else if (act === 'heard') {
        const li = document.getElementById(`line-${line}`)
        li?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        li?.classList.add('flash')
        setTimeout(() => li?.classList.remove('flash'), 1800)
      }
    } catch (err) { alert(String(err instanceof Error ? err.message : err)) }
    await refresh()
  })

  document.addEventListener('submit', async e => {
    const f = e.target as HTMLFormElement
    if (!f.classList.contains('edit')) return
    e.preventDefault()
    const v = (n: string) => f.elements.namedItem(n) as HTMLInputElement
    const allDay = v('allDay').checked
    try {
      await editPlan(f.dataset.id!, { activity: v('activity').value, who: splitNames(v('who').value), start: fromLocalInput(v('start').value, allDay), allDay })
      editing = null
    } catch (err) { alert(String(err instanceof Error ? err.message : err)) }
    await refresh()
  })
}

const RESULT: Record<string, (summary: string) => string> = {
  proposed: s => `Asking now: ${s}. Say “yes” or “no” to answer.`,
  queued: s => `Queued behind another question: ${s}.`,
  answer: s => `Answered: ${s}.`,
  duplicate: () => 'Already on the calendar, or already answered.',
  ignored: () => 'Not a calendar plan, so HALO ignored it.',
  silence: () => 'No speech heard.',
}

function renderSide() {
  setHtml('present-chips', data.people.length
    ? data.people.map(p => `<button type="button" class="chipbtn${present.includes(p.name) ? ' on' : ''}" data-act="present" data-name="${esc(p.name)}" aria-pressed="${present.includes(p.name)}">${esc(p.name)} <span class="muted">${esc(p.relation)}</span></button>`).join('')
    : '<p class="empty hint">Add people on the setup page first.</p>')

  const speakers = ['unknown', ...data.people.map(p => p.name), ...(data.patient.name ? [data.patient.name] : [])]
  const sel = $<HTMLSelectElement>('say-speaker')
  const options = speakers.map(s => `<option value="${esc(s)}">${s === 'unknown' ? 'Unknown speaker' : esc(s)}</option>`).join('')
  if (shown['say-speaker'] !== options) {
    const keep = sel.value
    sel.innerHTML = options
    sel.value = speakers.includes(keep) ? keep : 'unknown'
    shown['say-speaker'] = options
  }
  setHtml('transcript', lines.length
    ? [...lines].reverse().slice(0, 15).map(l => `<li id="line-${esc(l.id ?? '')}"><span class="muted">${timeLabel(new Date(l.at))} · ${esc(!l.speaker || l.speaker === 'unknown' ? 'Unknown' : l.speaker)}</span><br />${esc(l.text)}</li>`).join('')
    : '<li class="empty">Nothing heard yet.</li>')
}

async function refresh() {
  try {
    ;[data, plans, lines, present] = await Promise.all([loadData(), loadPlans(), loadTranscripts(), loadPresent()])
    online = true
  } catch {
    online = false
  }
  setHtml('cal-status', online ? '' : '<div class="banner">Can’t reach the portal server. Is it still running?</div>')
  renderNeeds()
  renderMonth()
  renderSide()
}

mount()
void refresh()
// Changes made on the glasses, the patient page or another tab show up straight away
onDataChanged(() => void refresh())
setInterval(() => { if (!document.hidden) void refresh() }, 15_000)
