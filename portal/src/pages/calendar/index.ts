import '../../shell'
import '../../styles/base.css'
import './calendar.css'
import type { Plan, TranscriptLine } from '../../../../shared/calendar.ts'
import { fetchJson } from '../../lib/http'
import { mountActions } from './actions'
import { renderCalendar } from './calendar-view'
import { renderConversation } from './conversation-view'
import { state, type CareInfo } from './state'
import { mountTemplates } from './template'

// Care portal: calendar and the conversation box. Talks to the HALO server (npm run server).

const POLL_MS = 2000

async function refresh() {
  try {
    const [p, t, d] = await Promise.all([
      fetchJson<Plan[]>('/api/plans'),
      fetchJson<TranscriptLine[]>('/api/transcript'),
      fetchJson<CareInfo>('/api/data').catch(() => ({}) as CareInfo),
    ])
    state.plans = p; state.transcript = t
    state.people = d.people ?? []
    state.patient = d.patient?.name ?? ''
    state.online = true
  } catch {
    state.online = false
  }
  renderCalendar()
  renderConversation()
}

mountTemplates()
mountActions(refresh)
void refresh()
setInterval(() => { if (!document.hidden) void refresh() }, POLL_MS)
