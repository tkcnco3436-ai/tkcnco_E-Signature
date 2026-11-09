import fs from 'node:fs'
import { Readable } from 'node:stream'
import { getDocument, getSignerByToken, signedPdfPath } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(_req: Request, ctx: Ctx) {
  const { token } = await ctx.params
  const signer = getSignerByToken(token)
  const doc = signer ? getDocument(signer.document_id) : undefined
  if (!signer || !doc) return new Response('Not found', { status: 404, headers: NO_STORE })
  if (doc.status !== 'completed') return new Response('Document not completed', { status: 409, headers: NO_STORE })

  const file = signedPdfPath(doc.id)
  let size: number
  try {
    size = (await fs.promises.stat(file)).size
  } catch {
    return new Response('Signed file missing', { status: 409, headers: NO_STORE })
  }
  // Strip characters that are illegal in Windows/macOS filenames before encoding.
  // Same naming as the admin download: `<title>_서명완료.pdf` (ASCII fallback `signed.pdf`).
  const base = (doc.title || 'document').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 150) || 'document'
  const name = rfc5987(`${base}_서명완료.pdf`)
  const stream = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream<Uint8Array>
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="signed.pdf"; filename*=UTF-8''${name}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

// RFC 5987 ext-value: encodeURIComponent leaves ' ( ) * unescaped, which are not attr-chars.
function rfc5987(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}
