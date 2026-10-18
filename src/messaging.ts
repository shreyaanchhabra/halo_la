import { API } from './api.ts'
import type { MessageReply, MessageState } from '../shared/messages.ts'
import { messagePages, messageScreen } from './message-screen.ts'

async function request<T>(path: string, input?: object | Uint8Array): Promise<T> {
  const audio = input instanceof Uint8Array
  const response = await fetch(`${API}/api/messages${path}`, {
    ...(input ? { method: 'POST', headers: { 'Content-Type': audio ? 'audio/wav' : 'application/json' }, body: audio ? input as BodyInit : JSON.stringify(input) } : {}),
    signal: AbortSignal.timeout(audio ? 25_000 : 20_000),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'Messaging unavailable')
  return result as T
}

export class GlassesMessaging {
  private state: MessageState = { message: null, reply: null }
  private page = 0
  private phase: 'reading' | 'recording' | 'busy' | 'review' | 'result' = 'reading'
  private notice = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  visible = false
  private refresh: () => void
  constructor(refresh: () => void) { this.refresh = refresh }
  get capturing() { return this.visible && this.phase === 'recording' }
  async poll() {
    try {
      const next = await request<MessageState>('/state')
      if (next.message?.id !== this.state.message?.id || next.reply?.id !== this.state.reply?.id) {
        if (this.phase !== 'result' && this.phase !== 'busy') this.phase = next.reply ? 'review' : 'reading'
        this.page = 0
      }
      this.state = next
      if (this.phase === 'review' && !next.reply) this.phase = 'reading'
    } catch {
      this.state = { message: null, reply: null }
      if (this.phase !== 'result' && this.phase !== 'busy') this.phase = 'reading'
    }
  }
  screen(): string | null {
    if (this.phase === 'result') return this.notice
    if (this.phase === 'busy') return 'HALO messages\nPlease wait...'
    const m = this.state.message
    if (!m) return null
    if (this.phase === 'recording') return `Reply to ${m.name.slice(0, 24)}\nSpeak your reply.\n\nHold: cancel\nNothing sent yet.`
    return messageScreen(m, this.phase === 'review' ? this.state.reply!.text : m.text, this.page, this.phase === 'review')
  }
  private result(text: string) {
    clearTimeout(this.timer)
    this.phase = 'result'; this.notice = text; this.refresh()
    this.timer = setTimeout(() => { this.phase = 'reading'; this.page = 0; this.refresh() }, 6000)
  }
  async click() {
    if (!this.visible) return
    const m = this.state.message
    if (this.phase === 'result') { clearTimeout(this.timer); this.phase = 'reading'; this.refresh(); return }
    if (!m || this.phase === 'busy' || this.phase === 'recording') return
    const review = this.phase === 'review', r = this.state.reply
    if (this.page < messagePages(review ? r!.text : m.text).length - 1) { this.page++; this.refresh(); return }
    this.phase = 'busy'; this.refresh()
    try {
      if (review && r) {
        const sent = await request<MessageReply>(`/${r.id}/confirm`, { confirmed: true, text: r.text })
        this.state.reply = null; this.state.message = null
        this.result(sent.status === 'demo_sent' ? 'Demo reply recorded.\nNo text was sent.' : sent.status === 'sent' ? 'Reply sent.' : 'Delivery unconfirmed.\nAsk family to check.\nDo not send again.')
      } else {
        await request(`/${m.id}/dismiss`, {})
        this.state.message = null; this.phase = 'reading'
      }
    } catch { this.result('Could not complete that.\nAsk family to check.') }
    this.refresh()
  }
  async hold() {
    if (!this.visible || !this.state.message || this.phase === 'busy' || this.phase === 'result') return
    if (this.phase === 'review' && this.state.reply) {
      try { await request(`/${this.state.reply.id}/cancel`, {}) } catch { this.result('Could not cancel.\nNothing sent.'); return }
      this.state.reply = null; this.phase = 'reading'; this.page = 0
    } else if (this.phase === 'recording') {
      clearTimeout(this.timer); this.phase = 'reading'
    } else {
      this.phase = 'recording'; clearTimeout(this.timer)
      this.timer = setTimeout(() => { if (this.phase === 'recording') this.result('No reply recorded.\nNothing sent.\nHold to try again.') }, 20_000)
    }
    this.refresh()
  }
  async audio(wav: Uint8Array) {
    if (!this.capturing || !this.state.message) return
    clearTimeout(this.timer)
    const id = this.state.message.id
    this.phase = 'busy'; this.refresh()
    try {
      const r = await request<MessageReply>(`/${id}/audio`, wav)
      await this.poll()
      if (this.state.message?.id === id && this.state.reply?.id === r.id) { this.phase = 'review'; this.page = 0 }
      else this.result('Message no longer available.\nNothing sent.')
    } catch { this.result('Could not hear your reply.\nNothing sent.\nHold to try again.') }
    this.refresh()
  }
  suspend() {
    this.visible = false
    if (this.phase === 'recording') { clearTimeout(this.timer); this.phase = 'reading' }
  }
}
