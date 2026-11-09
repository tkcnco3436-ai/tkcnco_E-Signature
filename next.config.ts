import type { NextConfig } from 'next'

// Startup warnings (next.config is evaluated when `next dev` / `next start` / `next build` boot).
{
  const appUrl = process.env.APP_URL || ''
  let host = ''
  try {
    host = new URL(appUrl).hostname.toLowerCase()
  } catch {
    /* unset or invalid: lib/workflow.ts falls back to localhost */
  }
  if (host.endsWith('trycloudflare.com')) {
    console.warn(
      `[pdf-esign] APP_URL is a Cloudflare quick tunnel (${host}). Its address changes on every restart, ` +
        'so links in emails already sent will stop working. Use "알림 재발송" after a restart, or set up a ' +
        'named tunnel with your own domain (see README).',
    )
  }
  const pw = process.env.ADMIN_PASSWORD
  if (process.env.NODE_ENV !== 'test' && (!pw || pw.length < 12)) {
    console.warn('[pdf-esign] ADMIN_PASSWORD is missing or shorter than 12 characters; admin login will be refused.')
  }
}

const nextConfig: NextConfig = {
  // node:sqlite and signing libs must stay on the server and not be bundled.
  // pdf-lib must be external too: @signpdf/placeholder-pdf-lib uses pdf-lib classes (instanceof),
  // so a bundled copy and the external copy would not match and the placeholder is silently lost.
  serverExternalPackages: [
    'pdf-lib',
    '@pdf-lib/fontkit',
    '@signpdf/signpdf',
    '@signpdf/signer-p12',
    '@signpdf/placeholder-pdf-lib',
    'node-forge',
  ],
  allowedDevOrigins: ['*.trycloudflare.com'],
  // proxy.ts only matches /admin pages (GET), so the proxy body-buffer size setting is not needed.
}

export default nextConfig
