import type { IncomingMessage, MessageContact, MessageReply, MessageState, MessagingData } from '../../shared/messages.ts'

export class MessageError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}
export const emptyMessages = (): MessagingData => ({ contacts: [], messages: [], replies: [], activity: [] })
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new MessageError(`${field} is required (maximum ${max} characters)`)
  return value.trim()
}
export function phone(value: unknown): string {
  const n = text(value, 'phone', 40).replace(/[ ().-]/g, '')
  if (!/^\+[1-9]\d{7,14}$/.test(n)) throw new MessageError('Use an international phone number, including + and country code')
  return n
}
export type MessageTransport = { mode: 'demo' | 'live'; send: (reply: MessageReply) => Promise<string> }

export class MessageService {
  public data: MessagingData
  private persist: () => void
  private clock: () => Date
  constructor(data: MessagingData, persist = () => {}, clock = () => new Date()) {
    this.data = data; this.persist = persist; this.clock = clock
  }
  private log(text: string, sourceId: string) { this.data.activity.push({ at: this.clock().toISOString(), text, sourceId }) }
  private contact(from: string) { return this.data.contacts.find(c => c.phone === from && c.approved) }
  private getMessage(id: string): IncomingMessage {
    const m = this.data.messages.find(m => m.id === id)
    if (!m) throw new MessageError('Message not found', 404)
    return m
  }
  private allowed(m: IncomingMessage) { return m.allowedOnArrival && !m.dismissed && Boolean(this.contact(m.from)) }
  upsertContact(input: Record<string, unknown>): MessageContact {
    const number = phone(input.phone)
    const name = text(input.name, 'name', 60)
    const relation = text(input.relation, 'relation', 60)
    if (typeof input.approved !== 'boolean') throw new MessageError('approved must be true or false')
    let c = this.data.contacts.find(c => c.phone === number)
    if (!c) { c = { id: crypto.randomUUID(), phone: number, name, relation, approved: input.approved }; this.data.contacts.push(c) }
    else Object.assign(c, { name, relation, approved: input.approved })
    if (!c.approved) {
      // A later reapproval must not resurrect private messages or stale reply drafts.
      for (const m of this.data.messages.filter(m => m.from === number)) m.dismissed = true
      for (const r of this.data.replies.filter(r => r.to === number && r.status === 'draft')) r.status = 'cancelled'
    }
    this.log(`${c.approved ? 'Approved' : 'Blocked'} contact ${c.name}`, c.id)
    this.persist()
    return c
  }
  receive(input: Record<string, unknown>, demo = false): IncomingMessage {
    const from = phone(input.from)
    const providerId = text(input.providerId, 'providerId', 200)
    const body = text(input.text, 'text', 2000)
    const old = this.data.messages.find(m => m.providerId === providerId && m.demo === demo)
    if (old) {
      if (old.from !== from || old.text !== body) throw new MessageError('Provider ID already used for a different message', 409)
      return old
    }
    const m: IncomingMessage = { id: crypto.randomUUID(), providerId, from, text: body, receivedAt: this.clock().toISOString(), allowedOnArrival: Boolean(this.contact(from)), dismissed: false, demo }
    this.data.messages.push(m)
    this.log(m.allowedOnArrival ? 'Message queued for glasses' : 'Unapproved message withheld from glasses', m.id)
    this.persist()
    return m
  }
  state(): MessageState {
    const now = this.clock().getTime()
    const draft = this.data.replies.find(r => r.status === 'draft' && Date.parse(r.expiresAt) > now && this.allowed(this.getMessage(r.messageId)))
    const m = draft ? this.getMessage(draft.messageId) : this.data.messages.find(m => this.allowed(m))
    const c = m && this.contact(m.from)
    return { message: m && c ? { id: m.id, name: c.name, relation: c.relation, text: m.text, demo: m.demo } : null, reply: draft ? { id: draft.id, messageId: draft.messageId, text: draft.text, expiresAt: draft.expiresAt } : null }
  }
  dismiss(id: string) {
    this.getMessage(id).dismissed = true
    for (const r of this.data.replies.filter(r => r.messageId === id && r.status === 'draft')) r.status = 'cancelled'
    this.log('Patient dismissed message', id)
    this.persist()
  }
  draft(id: string, body: unknown): MessageReply {
    const m = this.getMessage(id)
    if (!this.allowed(m)) throw new MessageError('Contact is not approved or message is no longer available', 403)
    if (this.data.replies.some(r => r.messageId === id && (r.status === 'sending' || r.status === 'unknown'))) throw new MessageError('Previous reply delivery is unconfirmed; check the provider before sending again', 409)
    const replyText = text(body, 'reply text', 1000)
    for (const r of this.data.replies.filter(r => r.status === 'draft')) r.status = 'cancelled'
    const now = this.clock()
    const r: MessageReply = { id: crypto.randomUUID(), messageId: id, to: m.from, text: replyText, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 120_000).toISOString(), status: 'draft' }
    this.data.replies.push(r)
    this.log('Reply transcribed for patient review; not sent', r.id)
    this.persist()
    return r
  }
  cancel(id: string) {
    const r = this.data.replies.find(r => r.id === id)
    if (!r || r.status !== 'draft') throw new MessageError('Active draft not found', 404)
    r.status = 'cancelled'; this.log('Patient cancelled reply', r.id); this.persist()
  }
  async confirm(id: string, input: Record<string, unknown>, transport: MessageTransport): Promise<MessageReply> {
    const r = this.data.replies.find(r => r.id === id)
    if (!r) throw new MessageError('Reply not found', 404)
    if (input.confirmed !== true || input.text !== r.text) throw new MessageError('Confirm the exact reviewed reply text')
    if (r.status === 'sent' || r.status === 'demo_sent') return r
    if (r.status !== 'draft') throw new MessageError(`Reply is ${r.status}; do not resend`, 409)
    const m = this.getMessage(r.messageId)
    if (!this.allowed(m) || Date.parse(r.expiresAt) <= this.clock().getTime()) throw new MessageError('Reply expired or contact is no longer approved', 403)
    if (!m.demo && transport.mode === 'demo') throw new MessageError('Live messaging adapter is not configured', 503)
    r.status = 'sending'; this.persist() // lock synchronously before the first await
    try {
      // Synthetic demo messages must never reach a live recipient, even when an adapter is configured.
      r.providerId = m.demo ? `demo:${r.id}` : await transport.send(r)
      r.status = m.demo ? 'demo_sent' : 'sent'
      m.dismissed = true
      this.log(m.demo ? 'Demo reply recorded; no text sent' : 'Messaging adapter accepted reply', r.id)
    } catch {
      r.status = 'unknown' // a timeout may have happened after the provider accepted it
      m.dismissed = true // don't offer a second draft for an ambiguously delivered reply
      this.log('Reply delivery unconfirmed; check provider before retrying', r.id)
    }
    this.persist()
    return r
  }
}
