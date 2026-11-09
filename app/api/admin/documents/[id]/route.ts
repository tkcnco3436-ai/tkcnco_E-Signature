import { isAdmin } from '@/lib/auth'
import { getBundle, getDocument } from '@/lib/db'
import type { FieldType } from '@/lib/types'
import { deleteDocument, saveDraft } from '@/lib/workflow'
import { EMAIL_RE, badRequest, errorResponse, json, unauthorized } from '../../_util'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  if (!(await isAdmin())) return unauthorized()
  const { id } = await params
  try {
    const bundle = getBundle(id)
    if (!bundle) return json({ error: '문서를 찾을 수 없습니다.' }, 404)
    return json(bundle)
  } catch (err) {
    return errorResponse(err, 'getBundle')
  }
}

const FIELD_TYPES: FieldType[] = ['signature', 'name', 'date', 'text']
const EPS = 1e-6

type DraftInput = Parameters<typeof saveDraft>[1]

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const in01 = (v: unknown): v is number => isNum(v) && v >= -EPS && v <= 1 + EPS
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Returns validated input or an error message. */
function parseDraft(body: unknown, pageCount: number): DraftInput | string {
  if (!isObj(body)) return '잘못된 요청입니다.'
  const out: DraftInput = { signers: [], fields: [] }

  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) return '문서 제목을 입력해 주세요.'
    if (body.title.trim().length > 200) return '제목은 200자 이하로 입력해 주세요.'
    out.title = body.title.trim()
  }
  if (body.message !== undefined) {
    if (body.message !== null && typeof body.message !== 'string') return '메시지 형식이 올바르지 않습니다.'
    const m = typeof body.message === 'string' ? body.message.trim() : ''
    if (m.length > 2000) return '메시지는 2000자 이하로 입력해 주세요.'
    out.message = m || null
  }

  if (!Array.isArray(body.signers) || body.signers.length === 0) return '서명자를 1명 이상 추가해 주세요.'
  if (body.signers.length > 20) return '서명자는 최대 20명까지 지정할 수 있습니다.'
  let owners = 0
  const emails = new Set<string>()
  for (let i = 0; i < body.signers.length; i++) {
    const s = body.signers[i]
    if (!isObj(s)) return '서명자 정보가 올바르지 않습니다.'
    const name = typeof s.name === 'string' ? s.name.trim() : ''
    const email = typeof s.email === 'string' ? s.email.trim() : ''
    if (!name || name.length > 100) return `${i + 1}번 서명자의 이름을 확인해 주세요.`
    if (!EMAIL_RE.test(email) || email.length > 254) return `${i + 1}번 서명자의 이메일 주소를 확인해 주세요.`
    const key = email.toLowerCase()
    if (emails.has(key)) return `이메일 주소가 중복되었습니다: ${email}`
    emails.add(key)
    if (typeof s.is_owner !== 'boolean') return '서명자 정보가 올바르지 않습니다.'
    if (s.is_owner) owners++
    if (s.id !== undefined && (typeof s.id !== 'string' || s.id.length > 64)) return '서명자 정보가 올바르지 않습니다.'
    out.signers.push({
      ...(typeof s.id === 'string' ? { id: s.id } : {}),
      name,
      email,
      is_owner: s.is_owner,
      order_index: i, // order is the array order
    })
  }
  if (owners > 1) return '본인(나)은 한 번만 서명자로 지정할 수 있습니다.'

  if (!Array.isArray(body.fields)) return '필드 정보가 올바르지 않습니다.'
  if (body.fields.length > 500) return '필드는 최대 500개까지 배치할 수 있습니다.'
  for (const f of body.fields) {
    if (!isObj(f)) return '필드 정보가 올바르지 않습니다.'
    const { signer_ref, page, x, y, w, h, type, label } = f
    if (!Number.isInteger(signer_ref) || (signer_ref as number) < 0 || (signer_ref as number) >= out.signers.length)
      return '필드의 서명자 지정이 올바르지 않습니다.'
    if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > pageCount) return '필드의 페이지 번호가 올바르지 않습니다.'
    if (!in01(x) || !in01(y) || !in01(w) || !in01(h) || w <= 0 || h <= 0) return '필드 위치가 올바르지 않습니다.'
    if (x + w > 1 + 1e-3 || y + h > 1 + 1e-3) return '필드가 페이지 밖으로 벗어났습니다.'
    if (typeof type !== 'string' || !FIELD_TYPES.includes(type as FieldType)) return '필드 종류가 올바르지 않습니다.'
    if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > 100))
      return '필드 라벨은 100자 이하로 입력해 주세요.'
    const cx = clamp01(x)
    const cy = clamp01(y)
    out.fields.push({
      signer_ref: signer_ref as number,
      page: page as number,
      x: cx,
      y: cy,
      w: Math.min(w, 1 - cx),
      h: Math.min(h, 1 - cy),
      type: type as FieldType,
      label: typeof label === 'string' && label.trim() ? label.trim() : null,
    })
  }
  return out
}

export async function PUT(req: Request, { params }: Ctx) {
  if (!(await isAdmin())) return unauthorized()
  const { id } = await params
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return badRequest('잘못된 요청입니다.')
  }
  try {
    const doc = getDocument(id)
    if (!doc) return json({ error: '문서를 찾을 수 없습니다.' }, 404)
    if (doc.status !== 'draft') return json({ error: '발송된 문서는 수정할 수 없습니다.' }, 409)
    const input = parseDraft(body, doc.page_count)
    if (typeof input === 'string') return badRequest(input)
    return json(saveDraft(id, input))
  } catch (err) {
    return errorResponse(err, 'saveDraft')
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  if (!(await isAdmin())) return unauthorized()
  const { id } = await params
  try {
    deleteDocument(id)
    return json({ ok: true })
  } catch (err) {
    return errorResponse(err, 'deleteDocument')
  }
}
