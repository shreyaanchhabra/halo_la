import '../../shell'
import '../../styles/base.css'
import { $ } from '../../lib/dom'
import { emptyCareData, loadCareData, removeFile, saveCareData } from '../../lib/care-data'
import { mountPeopleForm, renderPeople } from './people'
import { mountPrescriptionForm, renderPrescriptions } from './prescriptions'

let data = emptyCareData()
const save = () => saveCareData(data)

function render() {
  renderPeople(data)
  renderPrescriptions(data)
}

$<HTMLInputElement>('patient-name').addEventListener('change', e => {
  data.patient.name = (e.target as HTMLInputElement).value.trim()
  void save()
})

mountPeopleForm(() => data, save, render)
mountPrescriptionForm(() => data, save, render)

// Remove buttons for people and prescriptions
document.addEventListener('click', async e => {
  const el = e.target as HTMLElement
  const personId = el.dataset.delPerson
  const rxId = el.dataset.delRx
  if (personId) {
    const p = data.people.find(x => x.id === personId)
    data.people = data.people.filter(x => x.id !== personId)
    if (p) await removeFile(p.voiceFile)
  } else if (rxId) {
    const r = data.prescriptions.find(x => x.id === rxId)
    data.prescriptions = data.prescriptions.filter(x => x.id !== rxId)
    if (r) await removeFile(r.file)
  } else {
    return
  }
  await save()
  render()
})

void loadCareData().then(saved => {
  data = saved
  $<HTMLInputElement>('patient-name').value = data.patient.name
  render()
})
