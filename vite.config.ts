import { defineConfig } from 'vite'

// Listen on the LAN so the Even App on your phone can reach the dev server
export default defineConfig({
  // /api goes to the portal's server (npm run portal), so the glasses app uses same-origin URLs.
  // Set HALO_PORTAL if the portal is not on port 5174.
  server: { host: true, port: 5173, strictPort: true, proxy: { '/api': process.env.HALO_PORTAL ?? 'http://localhost:5174' } },
})
