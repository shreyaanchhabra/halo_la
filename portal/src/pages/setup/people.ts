import { $, esc } from '../../lib/dom'
import { fileUrl, uploadFile, type CareData } from '../../lib/care-data'
import { createRecorder } from './recorder'

export function renderPeople(data: CareData) {
  $('people').innerHTML = data.people.length
    ? data.people.map(p => `
      <li>
        <div>
          <strong>${esc(p.name)}</strong> <span class="tag">${esc(p.relation)}</span>
          ${p.blurb ? `<p>${esc(p.blurb)}</p>` : ''}
          <audio controls src="${fileUrl(p.voiceFile)}"></audio>
        </div>
        <button class="link" data-del-person="${p.id}">Remove</button>
      </li>`).join('')
    : '<li class="empty">No one added yet.</li>'
}

export function mountPeopleForm(getData: () => CareData, save: () => Promise<void>, render: () => void) {
  const recorder = createRecorder()
  $<HTMLFormElement>('person-form').addEventListener('submit', async e => {
    e.preventDefault()
    const recording = recorder.current()
    if (!recording) {
      recorder.warn('Record a voice sample before saving.')
      return
    }
    const saveBtn = $<HTMLButtonElement>('person-save')
    saveBtn.disabled = true
    const name = $<HTMLInputElement>('p-name').value.trim()
    const ext = recording.type.includes('mp4') ? 'mp4' : 'webm'
    const voiceFile = await uploadFile(recording, `${name || 'voice'}.${ext}`)
    getData().people.push({
      id: crypto.randomUUID(),
      name,
      relation: $<HTMLInputElement>('p-relation').value.trim(),
      blurb: $<HTMLTextAreaElement>('p-blurb').value.trim(),
      voiceFile,
      createdAt: new Date().toISOString(),
    })
    await save()
    ;(e.target as HTMLFormElement).reset()
    recorder.reset()
    saveBtn.disabled = false
    render()
  })
}
