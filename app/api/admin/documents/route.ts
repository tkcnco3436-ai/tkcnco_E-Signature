import { isAdmin } from '@/lib/auth'
import { createDocument } from '@/lib/workflow'
import { MAX_PDF_BYTES, badRequest, errorResponse, json, unauthorized } from '../_util'

// Multipart overhead allowance on top of the 20 MB file limit.
const MULTIPART_SLACK = 256 * 1024

export async function POST(req: Request) {
  if (!(await isAdmin())) return unauthorized()

  const len = Number(req.headers.get('content-length') ?? '0')
  if (!Number.isFinite(len) || len > MAX_PDF_BYTES + MULTIPART_SLACK) {
    return json({ error: '파일이 너무 큽니다. 20MB 이하의 PDF만 업로드할 수 있습니다.' }, 413)
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return badRequest('업로드 형식이 올바르지 않습니다.')
  }

  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) return badRequest('PDF 파일을 선택해 주세요.')
  if (file.size > MAX_PDF_BYTES) {
    return json({ error: '파일이 너무 큽니다. 20MB 이하의 PDF만 업로드할 수 있습니다.' }, 413)
  }

  const pdf = new Uint8Array(await file.arrayBuffer())
  const magic = new TextDecoder().decode(pdf.subarray(0, 5))
  if (magic !== '%PDF-') return badRequest('PDF 파일만 업로드할 수 있습니다.')

  const rawTitle = form.get('title')
  let title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  if (!title) title = file.name.replace(/\.pdf$/i, '').trim() || '제목 없는 문서'
  if (title.length > 200) return badRequest('제목은 200자 이하로 입력해 주세요.')

  const rawMessage = form.get('message')
  const message = typeof rawMessage === 'string' && rawMessage.trim() ? rawMessage.trim() : null
  if (message && message.length > 2000) return badRequest('메시지는 2000자 이하로 입력해 주세요.')

  try {
    const doc = await createDocument({ title, pdf, message })
    return json({ id: doc.id }, 201)
  } catch (err) {
    return errorResponse(err, 'createDocument')
  }
}
