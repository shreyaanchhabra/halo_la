import { defineConfig } from 'vite'

// Listen on the LAN so the Even App on your phone can reach the dev server
export default defineConfig({
  // /api goes to the HALO server (npm run server), so the glasses app uses same-origin URLs
  server: { host: true, port: 5173, strictPort: true, proxy: { '/api': 'http://localhost:8787' } },
})
