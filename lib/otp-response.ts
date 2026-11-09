import 'server-only'
import { OtpError } from './otp'
import { WorkflowError } from './workflow'

export const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Error -> JSON response for the signer OTP routes: { error, retry_after?, remaining? }. */
export function otpErrorResponse(e: unknown, what: string): Response {
  if (e instanceof OtpError) {
    const headers: Record<string, string> = { ...NO_STORE }
    if (e.retryAfter) headers['Retry-After'] = String(e.retryAfter)
    return Response.json(
      {
        error: e.message,
        ...(e.retryAfter !== undefined ? { retry_after: e.retryAfter } : {}),
        ...(e.remaining !== undefined ? { remaining: e.remaining } : {}),
      },
      { status: e.status, headers },
    )
  }
  if (e instanceof WorkflowError) return Response.json({ error: e.message }, { status: e.status, headers: NO_STORE })
  console.error(`${what} failed`, e)
  return Response.json({ error: '인증 처리 중 오류가 발생했습니다.' }, { status: 500, headers: NO_STORE })
}
