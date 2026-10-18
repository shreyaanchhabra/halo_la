// One long-lived parent for HALO's three development services. Run with npm run start:all.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const services = [
  { name: 'backend', url: 'http://localhost:8787/api/health', args: ['server/index.ts'] },
  { name: 'portal', url: 'http://localhost:5174/messages.html', args: [vite, 'portal', '--port', '5174', '--strictPort'] },
  { name: 'glasses', url: 'http://localhost:5175/', args: [vite, '--port', '5175', '--strictPort'] },
]
let stopping = false
const children = new Set()
const timers = new Set()

function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const timer of timers) clearTimeout(timer)
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL')
    process.exit(code)
  }, 1500).unref()
  process.exitCode = code
}
process.on('SIGTERM', () => stop())
process.on('SIGINT', () => stop())

async function healthy(service) {
  try {
    const response = await fetch(service.url, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return false
    if (service.name === 'backend') return (await response.json()).ok === true
    return (await response.text()).includes(service.name === 'portal' ? 'HALO · Messages' : '/src/main.ts')
  } catch { return false }
}
function start(service) {
  if (stopping) return
  const child = spawn(process.execPath, service.args, { cwd: root, stdio: 'inherit', env: process.env })
  service.child = child
  children.add(child)
  child.on('error', error => { console.error(`[HALO ${service.name}] ${error.message}`); stop(1) })
  child.on('exit', code => {
    children.delete(child)
    if (service.child === child) service.child = null
    if (stopping) return
    console.error(`[HALO ${service.name}] exited (${code}); restarting in 2 seconds`)
    const timer = setTimeout(() => { timers.delete(timer); start(service) }, 2000)
    timers.add(timer)
  })
}

for (const service of services) {
  if (await healthy(service)) console.log(`[HALO] Reusing ${service.name} at ${service.url}`)
  else {
    start(service)
    let ready = false
    for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
      if (await healthy(service)) { ready = true; break }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!ready) { console.error(`[HALO] ${service.name} did not start. Check whether its port is occupied.`); stop(1); break }
  }
}
if (!stopping) {
  console.log('\nHALO messages: http://localhost:5174/messages.html')
  console.log('HALO glasses (Even App or simulator): http://localhost:5175/')
}
// Also recover services that were already running when this launcher attached.
let checking = false
setInterval(async () => {
  if (stopping || checking) return
  checking = true
  try {
    for (const service of services) {
      if (!service.child && !await healthy(service)) start(service)
    }
  } finally { checking = false }
}, 5000)
