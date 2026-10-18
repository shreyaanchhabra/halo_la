import { defineConfig } from 'vite'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { jsonStore } from './vite/json-store'

export default defineConfig({
  plugins: [jsonStore()],
  build: {
    rolldownOptions: {
      input: Object.fromEntries(fs.readdirSync(fileURLToPath(new URL('.', import.meta.url)))
        .filter(name => name.endsWith('.html'))
        .map(name => [name.slice(0, -5), fileURLToPath(new URL(name, import.meta.url))])),
    },
  },
  server: {
    port: 5174,
    watch: { ignored: ['**/data/**'] },
    // Calendar endpoints live in the HALO server (npm run server); /api/data, /upload and /files stay here
    proxy: { '^/api/(audio|transcript|plans|present|glasses|health|refills|messages|calendar\\.ics)': 'http://localhost:8787', '/test-pharmacy': 'http://localhost:8787' },
    fs: { allow: ['..'] }, // the portal imports shared/ from the repo root
  },
})
