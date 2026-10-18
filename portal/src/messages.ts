import './style.css'
import type { MessageContact, MessagingData } from '../../shared/messages.ts'

// Family messages: approved contacts, the inbox of withheld and delivered texts, replies and activity.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

const UNAVAILABLE = 'HALO backend is unavailable. Start the project with npm run start:all.'

export async function api<T>(suffix: string, body?: object): Promise<T> {
  const res = await fetch(`/api/messages${suffix}`, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) })
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new Error(UNAVAILABLE)
  const raw = await res.text()
  let result
  try { result = JSON.parse(raw) } catch { throw new Error(UNAVAILABLE) }
  if (!res.ok) throw new Error(result.error ?? 'Request failed')
  return result
}


export type MessagesView = MessagingData & {
  mode: string
  photon: { configured: boolean; agentNumber: string; connected: string[]; error?: string }
}

export function renderContacts(data: MessagesView) {
  $('contacts').innerHTML = data.contacts.map(c => {
    const connected = data.photon.connected.includes(c.phone)
    const status = !c.approved ? 'Blocked' : connected ? 'Connected through Photon' : 'Approved · waiting for their first text'
    return `<li><div><strong>${esc(c.name)} (${esc(c.relation)})</strong><span>${esc(c.phone)} · ${status}</span></div><button data-contact="${c.id}">${c.approved ? 'Revoke' : 'Approve'}</button></li>`
  }).join('') || '<li class="empty">Add a contact to begin.</li>'
}

export function renderInbox(data: MessagesView) {
  $('inbox').innerHTML = [...data.messages].reverse().map(m => {
    const c = data.contacts.find(c => c.phone === m.from)
    const status = !m.allowedOnArrival ? 'Withheld on arrival' : !c?.approved ? 'Contact revoked' : m.dismissed ? 'Dismissed' : 'Queued for glasses'
    return `<li><div><strong>${esc(c?.name ?? m.from)} ${m.demo ? '· DEMO' : ''}</strong><p>${esc(m.text)}</p><span>${status} · ${esc(new Date(m.receivedAt).toLocaleString())}</span></div></li>`
  }).join('') || '<li class="empty">No messages yet.</li>'
}

export function renderReplies(data: MessagesView) {
  $('replies').innerHTML = [...data.replies].reverse().map(r => `<li><div><strong>${esc(r.to)} · ${esc(r.status === 'demo_sent' ? 'Demo recorded, no text sent' : r.status === 'unknown' ? 'Delivery unconfirmed. Check provider before retrying.' : r.status)}</strong><p>${esc(r.text)}</p></div></li>`).join('') || '<li class="empty">No replies yet.</li>'
}

export function renderOutgoing(data: MessagesView) {
  $('outgoing').innerHTML = [...data.outgoing].reverse().map(m => {
    const contact = data.contacts.find(c => c.phone === m.to)
    return `<li><div><strong>${esc(contact?.name ?? m.to)} · ${m.kind === 'care' ? 'Care text' : 'HALO reply'}</strong><p>${esc(m.text)}</p><span>${esc(new Date(m.sentAt).toLocaleString())}</span></div></li>`
  }).join('') || '<li class="empty">No HALO texts yet.</li>'
}

export function renderActivity(data: MessagesView) {
  $('activity').innerHTML = data.activity.slice(-30).reverse().map(a => `<li><div>${esc(a.text)}<span>${esc(new Date(a.at).toLocaleString())} · ${esc(a.sourceId)}</span></div></li>`).join('')
}

export function renderProviderStatus(data: MessagesView) {
  const status = $('provider-status')
  status.className = data.photon.configured && !data.photon.error ? 'status ok' : 'status error'
  status.textContent = data.photon.configured
    ? `Photon iMessage is configured at ${data.photon.agentNumber}. HALO sends updates when a dose is marked taken or undone, keeps a missed-dose safety alert, and can send a care summary when family texts "summary". No scheduled appointment reminders or morning check-ins.`
    : `Photon isn't connected. Add PHOTON_PROJECT_ID, PHOTON_API_KEY and PHOTON_AGENT_NUMBER to portal/.env, then restart the portal.`
  if (data.photon.error) status.textContent = `Photon reports a connection or send issue: ${data.photon.error}`
}

let data: MessagesView
let loading = false
let action = false

const showStatus = (text: string) => { $('status').hidden = false; $('status').textContent = text }

async function load() {
  if (loading) return
  loading = true
  try {
    data = await api<MessagesView>('')
    $('status').hidden = true
    renderProviderStatus(data)
    renderContacts(data)
    renderInbox(data)
    renderOutgoing(data)
    renderReplies(data)
    renderActivity(data)
  } catch (e) { showStatus(`Messages unavailable: ${e instanceof Error ? e.message : 'connection failed'}`) }
  finally { loading = false }
}

async function mutate(fn: () => Promise<unknown>) {
  if (action) return
  action = true
  try { await fn(); await load() }
  catch (e) { showStatus(e instanceof Error ? e.message : 'Could not save') }
  finally { action = false }
}

$<HTMLFormElement>('contact-form').addEventListener('submit', e => {
  e.preventDefault()
  const fields = new FormData(e.currentTarget as HTMLFormElement)
  void mutate(() => api<MessageContact>('/contacts', { name: fields.get('name'), relation: fields.get('relation'), phone: fields.get('phone'), approved: fields.has('approved') }))
})
$('contacts').addEventListener('click', e => {
  const id = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-contact]')?.dataset.contact
  const c = data?.contacts.find(c => c.id === id)
  if (c) void mutate(() => api('/contacts', { ...c, approved: !c.approved }))
})

void load()
setInterval(() => { if (!action) void load() }, 2000)
