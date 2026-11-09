import type { NextConfig } from 'next'

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
  // proxy.ts buffers request bodies; default 10 MB would truncate 20 MB PDF uploads.
  experimental: { proxyClientMaxBodySize: '25mb' },
}

export default nextConfig
