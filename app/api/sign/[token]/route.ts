import { clientInfo, rateLimit } from '@/lib/http'
import { otpStatus } from '@/lib/otp'
import { markViewed, signerView, submitSignature, WorkflowError } from '@/lib/workflow'
import type { SignField, SignSubmitBody, SignViewResponse } from '@/components/sign/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const PNG_PREFIX = 'data:image/png;base64,'
const MAX_PNG_CHARS = PNG_PREFIX.length + Math.ceil((500 * 1024 * 4) / 3) + 4
const MAX_VALUE_LEN = 1000
const MAX_VALUES = 500

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE })
}

// POST: 10/min per IP (spec). GET gets a looser separate bucket so reloads don't block signing.
function limited(req: Request, kind: 'get' | 'post'): boolean {
  const ip = clientInfo(req).ip ?? 'unknown'
  return kind === 'post' ? !rateLimit(`sign-post:${ip}`, 10, 60_000) : !rateLimit(`sign-get:${ip}`, 60, 60_000)
}

export async function GET(req: Request, ctx: Ctx) {
  const { token } = await ctx.params
  if (limited(req, 'get')) return json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' }, 429)

  let view = signerView(token)
  if (!view) return json({ error: '유효하지 않은 서명 링크입니다.' }, 404)

  // First open: record 'viewed' once (signer status moves sent -> viewed).
  if (view.signer.status === 'sent' && view.bundle.document.status === 'sent') {
    try {
      markViewed(token, clientInfo(req))
      view = signerView(token) ?? view
    } catch (e) {
      console.error('markViewed failed', e)
    }
  }

  const { bundle, signer, canSign, reason } = view
  // Signers who already signed: their field values and signature image are shown to later signers.
  // Never include tokens, emails or anything from signers who have not signed yet.
  const signedSigners = new Map(bundle.signers.filter((s) => s.status === 'signed').map((s) => [s.id, s.signature_png]))
  const fields: SignField[] = bundle.fields.map((f) => {
    const mine = f.signer_id === signer.id
    const signed = signedSigners.has(f.signer_id)
    return {
      id: f.id,
      page: f.page,
      x: f.x,
      y: f.y,
      w: f.w,
      h: f.h,
      type: f.type,
      label: mine ? f.label : null,
      mine,
      value: mine || signed ? f.value : null,
      signed,
      signature_png: signed && f.type === 'signature' ? (signedSigners.get(f.signer_id) ?? null) : null,
    }
  })
  const d = bundle.document
  const body: SignViewResponse = {
    document: { id: d.id, title: d.title, message: d.message, page_count: d.page_count, status: d.status },
    signer: { id: signer.id, name: signer.name, email: signer.email, status: signer.status, signed_at: signer.signed_at },
    fields,
    canSign,
    reason: reason ?? null,
    progress: { signed: bundle.signers.filter((s) => s.status === 'signed').length, total: bundle.signers.length },
    otp: otpStatus(signer),
  }
  return json(body)
}

export async function POST(req: Request, ctx: Ctx) {
  const { token } = await ctx.params
  if (limited(req, 'post')) return json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' }, 429)

  const ct = req.headers.get('content-type') ?? ''
  if (!ct.toLowerCase().includes('application/json')) return json({ error: 'JSON 요청이 필요합니다.' }, 415)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return json({ error: '요청 본문을 읽을 수 없습니다.' }, 400)
  }
  const parsed = parseBody(raw)
  if (typeof parsed === 'string') return json({ error: parsed }, 400)

  try {
    const result = await submitSignature(token, parsed, clientInfo(req))
    return json({ completed: result.completed })
  } catch (e) {
    if (e instanceof WorkflowError) return json({ error: e.message }, e.status)
    console.error('submitSignature failed', e)
    return json({ error: '서명 처리 중 오류가 발생했습니다.' }, 500)
  }
}

function parseBody(raw: unknown): SignSubmitBody | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '잘못된 요청입니다.'
  const b = raw as Record<string, unknown>
  if (b.consent !== true) return '전자서명 동의가 필요합니다.'
  const png = b.signaturePng
  if (typeof png !== 'string' || !png.startsWith(PNG_PREFIX)) return '서명 이미지가 올바르지 않습니다.'
  if (png.length > MAX_PNG_CHARS) return '서명 이미지가 너무 큽니다.'
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(png.slice(PNG_PREFIX.length))) return '서명 이미지가 올바르지 않습니다.'
  const v = b.values ?? {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '입력값 형식이 올바르지 않습니다.'
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length > MAX_VALUES) return '입력값이 너무 많습니다.'
  const values: Record<string, string> = {}
  for (const [k, val] of entries) {
    if (typeof val !== 'string' || k.length > 100) return '입력값 형식이 올바르지 않습니다.'
    if (val.length > MAX_VALUE_LEN) return '입력값이 너무 깁니다.'
    values[k] = val
  }
  return { signaturePng: png, values, consent: true }
}
