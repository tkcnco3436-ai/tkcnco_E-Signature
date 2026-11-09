import fs from 'node:fs/promises'
import { isAdmin } from '@/lib/auth'
import { getDocument, originalPdfPath, signedPdfPath } from '@/lib/db'
import { errorResponse, json, unauthorized } from '../../../_util'

// GET ?kind=original|signed[&download=1]
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return unauthorized()
  const { id } = await params
  const url = new URL(req.url)
  const kind = url.searchParams.get('kind') ?? 'original'
  if (kind !== 'original' && kind !== 'signed') return json({ error: '잘못된 요청입니다.' }, 400)
  const download = url.searchParams.get('download') === '1'

  try {
    const doc = getDocument(id)
    if (!doc) return json({ error: '문서를 찾을 수 없습니다.' }, 404)
    if (kind === 'signed' && doc.status !== 'completed') {
      return json({ error: '모든 서명이 완료된 후 받을 수 있습니다.' }, 409)
    }
    let data: Buffer
    try {
      data = await fs.readFile(kind === 'signed' ? signedPdfPath(id) : originalPdfPath(id))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return json({ error: '파일을 찾을 수 없습니다.' }, 404)
      throw e
    }
    const base = (doc.title || 'document').replace(/[\/:*?"<>|\r\n]+/g, '_').slice(0, 150)
    const name = kind === 'signed' ? `${base}_서명완료.pdf` : `${base}.pdf`
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(data.length),
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${kind}.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (err) {
    return errorResponse(err, 'file')
  }
}
