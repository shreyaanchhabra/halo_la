import { $ } from '../../lib/dom'

const MAX_SECONDS = 30

// Records one short voice sample for a person. `current()` is the finished recording, if any.
export function createRecorder() {
  let recorder: MediaRecorder | null = null
  let recording: Blob | null = null
  let timer = 0

  const recBtn = $<HTMLButtonElement>('rec-btn')
  const recStatus = $('rec-status')
  const recPreview = $<HTMLAudioElement>('rec-preview')

  function reset() {
    recording = null
    recPreview.hidden = true
    recPreview.removeAttribute('src')
    recStatus.textContent = 'No recording yet'
    recBtn.textContent = '● Record voice'
  }

  recBtn.addEventListener('click', async () => {
    if (recorder?.state === 'recording') {
      recorder.stop()
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      recStatus.textContent = 'Microphone blocked. Allow microphone access in the browser and try again.'
      return
    }
    const chunks: Blob[] = []
    recorder = new MediaRecorder(stream)
    recorder.ondataavailable = e => chunks.push(e.data)
    recorder.onstop = () => {
      clearInterval(timer)
      stream.getTracks().forEach(t => t.stop())
      recording = new Blob(chunks, { type: recorder!.mimeType })
      recPreview.src = URL.createObjectURL(recording)
      recPreview.hidden = false
      recStatus.textContent = 'Recorded. Play it back to check, or record again.'
      recBtn.textContent = '● Record again'
    }
    recorder.start()
    const started = Date.now()
    recBtn.textContent = '■ Stop'
    recStatus.textContent = `Recording… 0s / ${MAX_SECONDS}s`
    timer = window.setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000)
      recStatus.textContent = `Recording… ${s}s / ${MAX_SECONDS}s`
      if (s >= MAX_SECONDS) recorder?.stop()
    }, 250)
  })

  return {
    current: () => recording,
    reset,
    warn: (text: string) => { recStatus.textContent = text },
  }
}
