import '../../shell'
import '../../styles/base.css'
import type { MessageContact } from '../../../../shared/messages.ts'
import { $ } from '../../lib/dom'
import { api } from './api'
import { renderActivity, renderContacts, renderInbox, renderReplies, type MessagesView } from './render'

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
    renderContacts(data)
    renderInbox(data)
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
