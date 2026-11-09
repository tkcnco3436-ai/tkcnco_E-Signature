import { clientInfo, rateKey, rateLimit } from '@/lib/http'
import { NO_STORE, otpErrorResponse } from '@/lib/otp-response'
import { requestSignerOtp } from '@/lib/workflow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ token: string }> }

// POST /api/sign/[token]/otp -> 200 { ok: true, expires_in, resend_in } (seconds). Never returns the code.
// Errors: 404 bad token, 409 not this signer's turn / OTP not required, 429 { retry_after } cooldown or limit, 502 mail failed.
export async function POST(req: Request, ctx: Ctx) {
  const { token } = await ctx.params
  if (!rateLimit(`otp-send:${rateKey(req)}`, 10, 10 * 60_000))
    return Response.json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' }, { status: 429, headers: NO_STORE })
  try {
    const r = await requestSignerOtp(token, clientInfo(req))
    return Response.json({ ok: true, ...r }, { headers: NO_STORE })
  } catch (e) {
    return otpErrorResponse(e, 'requestSignerOtp')
  }
}
