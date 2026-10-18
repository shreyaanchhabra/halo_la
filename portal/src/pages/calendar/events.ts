import type { Plan } from '../../../../shared/calendar.ts'
import { dateLabel, planTitle, timeLabel } from '../../../../shared/format.ts'
import { esc } from '../../lib/dom'
import { toLocalInput } from './dates'
import { state } from './state'

function origin(p: Plan): string {
  if (p.confirmedBy === 'patient') return 'Confirmed by voice'
  if (p.confirmedBy === 'family') return p.source ? 'Approved by family' : 'Added by family'
  return ''
}

export function heard(p: Plan): string {
  if (!p.source) return ''
  const line = state.transcript.find(l => l.id === p.source!.lineId)
  const who = line && line.speaker !== 'unknown' ? `${esc(line.speaker)}, ` : ''
  const when = line ? ` <span class="muted">(${who}${timeLabel(new Date(line.ts))})</span>` : ''
  return `<p class="quote"><button class="link" data-act="heard" data-line="${esc(p.source.lineId)}">Heard</button>: “${esc(p.source.quote)}”${when}</p>`
}

export function whenLabel(p: Plan): string {
  return `${p.allDay ? '' : timeLabel(new Date(p.start)) + ', '}${dateLabel(new Date(p.start))}`
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

export function eventItem(p: Plan, now: Date): string {
  if (state.editing === p.id) return `<li class="ev">${editForm(p)}</li>`
  const start = new Date(p.start)
  const past = !p.allDay && start.getTime() < now.getTime()
  return `
    <li class="ev${past ? ' past' : ''}">
      <div>
        <p><strong class="time">${p.allDay ? 'All day' : timeLabel(start)}</strong> ${esc(planTitle(p))}</p>
        <p class="tags">${origin(p) ? `<span class="tag">${origin(p)}</span>` : ''}${p.conflictWith ? '<span class="tag warn">Overlaps another event</span>' : ''}</p>
        ${heard(p)}
      </div>
      <div class="actions"><button class="link" data-act="edit" data-id="${p.id}">Edit</button><button class="link" data-act="delete" data-id="${p.id}">Delete</button></div>
    </li>`
}

export function approvalItem(p: Plan): string {
  if (state.editing === p.id) return `<li class="ev">${editForm(p)}</li>`
  return `
    <li class="ev need">
      <div>
        <p><strong>${esc(planTitle(p))}</strong> <span class="muted">${esc(whenLabel(p))}</span></p>
        <p class="tags">${p.conflictWith ? '<span class="tag warn">Overlaps another event</span>' : ''}</p>
        ${heard(p)}
      </div>
      <div class="actions">
        <button data-act="approve" data-id="${p.id}">Add to calendar</button>
        <button class="link" data-act="edit" data-id="${p.id}">Edit</button>
        <button class="link" data-act="reject" data-id="${p.id}">Don’t add</button>
      </div>
    </li>`
}
