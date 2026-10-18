import type { MetadataRoute } from 'next'

/** Installable till: opens straight on /till, full screen, in the rail colour. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'PC Systems POS Till',
    short_name: 'POS Till',
    description: 'Sell, take payments and hand over goods, online or offline.',
    start_url: '/till',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f4f6f5',
    theme_color: '#1b2530',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
