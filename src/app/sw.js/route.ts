import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/*
 * The till's service worker, generated per build. It precaches the till page and every file
 * under /_next/static of the running build, so the till opens with no network. The build id is
 * baked into the script, so a deploy changes its bytes and the browser installs the new worker,
 * which drops the old build's cache.
 */

const SHELL = ['/till', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

async function staticFiles(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await staticFiles(full, `${prefix}/${e.name}`)))
    else if (!e.name.endsWith('.map')) out.push(`${prefix}/${encodeURIComponent(e.name)}`)
  }
  return out
}

const WORKER = `
const CACHE = 'pos-till-' + VERSION
const isStatic = (url) => url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest'
const isTill = (url) => url.pathname === '/till' || url.pathname.startsWith('/till/')

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    // The page must be cached; static files are best effort (any one missing is fetched later).
    await cache.add(new Request('/till', { cache: 'reload' }))
    for (let i = 0; i < PRECACHE.length; i += 20) {
      await Promise.all(PRECACHE.slice(i, i + 20).map((u) => cache.add(u).catch(() => undefined)))
    }
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('pos-till-') && key !== CACHE) await caches.delete(key)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (isStatic(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const hit = await cache.match(req)
      if (hit) return hit
      const res = await fetch(req)
      if (res.ok) cache.put(req, res.clone())
      return res
    })())
  } else if (req.mode === 'navigate' && isTill(url)) {
    // The till shell is fixed per build: serve it from the cache, the network only as a fallback.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      return (await cache.match('/till')) ?? fetch(req)
    })())
  }
})
`

let cached: Promise<string> | undefined

async function build(): Promise<string> {
  const root = path.join(process.cwd(), '.next')
  const version = (await readFile(path.join(root, 'BUILD_ID'), 'utf8').catch(() => 'dev')).trim()
  const files = await staticFiles(path.join(root, 'static'), '/_next/static')
  return `const VERSION = ${JSON.stringify(version)}\nconst PRECACHE = ${JSON.stringify([...SHELL, ...files])}\n${WORKER}`
}

export async function GET() {
  // Rebuilt per request in development, where files change under the server.
  const body = process.env.NODE_ENV === 'production' ? await (cached ??= build()) : await build()
  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  })
}
