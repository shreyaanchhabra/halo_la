import type { MessagingData } from '../../../../shared/messages.ts'
import { $, esc } from '../../lib/dom'

export type MessagesView = MessagingData & { mode: string }

export function renderContacts(data: MessagesView) {
  $('contacts').innerHTML = data.contacts.map(c => `<li><div><strong>${esc(c.name)} (${esc(c.relation)})</strong><span>${esc(c.phone)} · ${c.approved ? 'Approved' : 'Blocked'}</span></div><button data-contact="${c.id}">${c.approved ? 'Revoke' : 'Approve'}</button></li>`).join('') || '<li class="empty">Add a contact to begin.</li>'
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

export function renderActivity(data: MessagesView) {
  $('activity').innerHTML = data.activity.slice(-30).reverse().map(a => `<li><div>${esc(a.text)}<span>${esc(new Date(a.at).toLocaleString())} · ${esc(a.sourceId)}</span></div></li>`).join('')
}
