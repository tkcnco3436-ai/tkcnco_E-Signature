import fs from 'node:fs'
import { Readable } from 'node:stream'
import { getDocument, getSignerByToken, originalPdfPath } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(_req: Request, ctx: Ctx) {
  const { token } = await ctx.params
  const signer = getSignerByToken(token)
  const doc = signer ? getDocument(signer.document_id) : undefined
  if (!signer || !doc) return new Response('Not found', { status: 404, headers: NO_STORE })
  if (doc.status === 'voided') return new Response('Voided', { status: 403, headers: NO_STORE })

  const file = originalPdfPath(doc.id)
  let size: number
  try {
    size = (await fs.promises.stat(file)).size
  } catch {
    return new Response('Not found', { status: 404, headers: NO_STORE })
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream<Uint8Array>
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(size),
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
