// Shape returned by GET /api/sign/[token]. Shared by the route handler and the signer UI.
import type { DocumentStatus, FieldType, SignerStatus } from '@/lib/types'

export interface SignField {
  id: string
  page: number // 1-based
  x: number // normalized 0..1, origin top-left
  y: number
  w: number
  h: number
  type: FieldType
  label: string | null
  mine: boolean
  // Own fields: current value. Other signers' fields: their submitted value, only once that signer has signed.
  value: string | null
  // True when the field's signer has already signed (their value/signature is final).
  signed: boolean
  // Signature fields of a signer who has signed: that signer's signature image (data:image/png). Otherwise null.
  signature_png: string | null
}

export interface SignViewResponse {
  document: { id: string; title: string; message: string | null; page_count: number; status: DocumentStatus }
  signer: { id: string; name: string; email: string; status: SignerStatus; signed_at: string | null }
  fields: SignField[]
  canSign: boolean
  reason: string | null
  progress: { signed: number; total: number }
  // Email OTP identity check. required=false when SIGN_OTP=off or mail is not configured (then signing works without it).
  // verified: a code was confirmed within the last 30 minutes. email_masked: e.g. "hl****@tkcnco.com".
  otp: { required: boolean; verified: boolean; email_masked: string }
}

/** POST /api/sign/[token]/otp -> 200. Errors: { error, retry_after? } (429 cooldown/limit). */
export interface OtpSendResponse {
  ok: true
  expires_in: number // seconds
  resend_in: number // seconds
}

/** POST /api/sign/[token]/otp/verify { code }. Errors: { error, remaining? } (400 wrong, 410 expired, 429 too many). */
export interface OtpVerifyResponse {
  ok: true
  verified_at: string
}

export interface SignSubmitBody {
  signaturePng: string
  values: Record<string, string>
  consent: true
}
