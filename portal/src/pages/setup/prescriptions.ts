import { $, esc } from '../../lib/dom'
import { fileUrl, uploadFile, type CareData } from '../../lib/care-data'

export function renderPrescriptions(data: CareData) {
  $('prescriptions').innerHTML = data.prescriptions.length
    ? data.prescriptions.map(r => `
      <li>
        <div>
          <a href="${fileUrl(r.file)}" target="_blank">${esc(r.originalName)}</a>
          <p>${[r.doctor, r.date].filter(Boolean).map(esc).join(' · ')}</p>
          ${r.notes ? `<p>${esc(r.notes)}</p>` : ''}
        </div>
        <button class="link" data-del-rx="${r.id}">Remove</button>
      </li>`).join('')
    : '<li class="empty">No prescriptions uploaded yet.</li>'
}

export function mountPrescriptionForm(getData: () => CareData, save: () => Promise<void>, render: () => void) {
  $<HTMLFormElement>('rx-form').addEventListener('submit', async e => {
    e.preventDefault()
    const file = $<HTMLInputElement>('rx-file').files?.[0]
    if (!file) return
    const saveBtn = $<HTMLButtonElement>('rx-save')
    saveBtn.disabled = true
    getData().prescriptions.push({
      id: crypto.randomUUID(),
      file: await uploadFile(file, file.name),
      originalName: file.name,
      doctor: $<HTMLInputElement>('rx-doctor').value.trim(),
      date: $<HTMLInputElement>('rx-date').value,
      notes: $<HTMLInputElement>('rx-notes').value.trim(),
      uploadedAt: new Date().toISOString(),
    })
    await save()
    ;(e.target as HTMLFormElement).reset()
    saveBtn.disabled = false
    render()
  })
}
