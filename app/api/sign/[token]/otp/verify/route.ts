import { clientInfo, rateKey, rateLimit } from '@/lib/http'
import { NO_STORE, otpErrorResponse } from '@/lib/otp-response'
import { verifySignerOtp } from '@/lib/workflow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string }> }

// POST /api/sign/[token]/otp/verify { code } -> 200 { ok: true, verified_at }
// Errors: 400 { remaining } wrong code, 410 expired / no code, 429 { remaining: 0 } too many wrong attempts,
// 404 bad token, 409 not this signer's turn / OTP not required.
export async function POST(req: Request, ctx: Ctx) {
  const { token } = await ctx.params
  if (!rateLimit(`otp-verify:${rateKey(req)}`, 20, 60_000))
    return Response.json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' }, { status: 429, headers: NO_STORE })
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: '요청 본문을 읽을 수 없습니다.' }, { status: 400, headers: NO_STORE })
  }
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined
  try {
    const r = verifySignerOtp(token, code, clientInfo(req))
    return Response.json({ ok: true, ...r }, { headers: NO_STORE })
  } catch (e) {
    return otpErrorResponse(e, 'verifySignerOtp')
  }
}
