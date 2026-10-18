import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const DATA_DIR = fileURLToPath(new URL('../data', import.meta.url))
const DATA_FILE = path.join(DATA_DIR, 'halo.json')
const UPLOADS = path.join(DATA_DIR, 'uploads')

const MIME: Record<string, string> = {
  '.webm': 'audio/webm', '.mp4': 'audio/mp4', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.heic': 'image/heic',
}

function readBody(req: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Dev-only stand-in for a backend: saves everything to portal/data/
export function jsonStore(): Plugin {
  return {
    name: 'halo-json-store',
    configureServer(server) {
      fs.mkdirSync(UPLOADS, { recursive: true })
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        try {
          if (url.pathname === '/api/data' && req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE) : '{}')
          } else if (url.pathname === '/api/data' && req.method === 'PUT') {
            const data = JSON.parse((await readBody(req)).toString())
            fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
            res.end('{"ok":true}')
          } else if (url.pathname === '/api/upload' && req.method === 'POST') {
            const name = path.basename(url.searchParams.get('name') ?? 'file').replace(/[^\w.-]/g, '_')
            const file = `${Date.now()}-${name}`
            fs.writeFileSync(path.join(UPLOADS, file), await readBody(req))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ file }))
          } else if (url.pathname.startsWith('/api/files/') && req.method === 'GET') {
            const file = path.join(UPLOADS, path.basename(decodeURIComponent(url.pathname)))
            if (!fs.existsSync(file)) { res.statusCode = 404; return res.end() }
            res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
            fs.createReadStream(file).pipe(res)
          } else if (url.pathname.startsWith('/api/files/') && req.method === 'DELETE') {
            fs.rmSync(path.join(UPLOADS, path.basename(decodeURIComponent(url.pathname))), { force: true })
            res.end('{"ok":true}')
          } else {
            next()
          }
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}
