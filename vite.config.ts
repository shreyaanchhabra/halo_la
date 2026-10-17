import { defineConfig } from 'vite'

// Listen on the LAN so the Even App on your phone can reach the dev server
export default defineConfig({
  server: { host: true, port: 5173, strictPort: true },
})
