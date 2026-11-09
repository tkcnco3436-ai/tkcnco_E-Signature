import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // node:sqlite and signing libs must stay on the server and not be bundled.
  serverExternalPackages: ['@signpdf/signpdf', '@signpdf/signer-p12', '@signpdf/placeholder-pdf-lib', 'node-forge'],
  allowedDevOrigins: ['*.trycloudflare.com'],
}

export default nextConfig
