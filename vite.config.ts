import { defineConfig } from 'vite'

// Listen on the LAN so the Even App on your phone can reach the dev server.
// /api goes to the HALO care portal (npm run portal).
export default defineConfig({
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://localhost:5174' },
  },
})
