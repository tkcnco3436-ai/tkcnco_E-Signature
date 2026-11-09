import 'server-only'
import crypto from 'node:crypto'
import { db, logEvent, nowIso } from './db'
import { mailDisabled, otpEmail, sendMail } from './mail'
import { sessionSecret } from './session'
import type { DocumentRow, SignerRow } from './types'

// Email OTP identity check for signers.
// The code itself is never stored or returned: only HMAC-SHA256(code, SESSION_SECRET + signer.id).

export const OTP_TTL_MS = 10 * 60_000
export const OTP_MAX_ATTEMPTS = 5
export const OTP_RESEND_COOLDOWN_MS = 60_000
export const OTP_MAX_SENDS_PER_HOUR = 5
export const OTP_VERIFIED_VALID_MS = 30 * 60_000

type ClientInfo = { ip: string | null; userAgent: string | null }

/** Error with an HTTP status plus optional retry/attempt hints for the API response. */
export class OtpError extends Error {
  status: number
  retryAfter?: number // seconds
  remaining?: number // attempts left for the current code
  constructor(message: string, status: number, extra: { retryAfter?: number; remaining?: number } = {}) {
    super(message)
    this.name = 'OtpError'
    this.status = status
    this.retryAfter = extra.retryAfter
    this.remaining = extra.remaining
  }
}

const flag = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase())

/** SIGN_OTP=on (default) | off. */
function otpSwitchOn(): boolean {
  const v = (process.env.SIGN_OTP ?? 'on').trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no')
}

/** True when MAIL_DISABLED and OTP_TEST_MODE=1: codes are printed to the console instead of mailed. */
export function otpTestMode(): boolean {
  return mailDisabled() && flag(process.env.OTP_TEST_MODE)
}

/** True when mail can actually be delivered (same conditions sendMail uses). */
function mailConfigured(): boolean {
  return !mailDisabled() && !!process.env.RESEND_API_KEY?.trim() && !!process.env.MAIL_FROM?.trim()
}

/** Effective requirement: SIGN_OTP on AND (mail configured OR test mode). */
export function otpRequired(): boolean {
  if (!otpSwitchOn()) return false
  return mailConfigured() || otpTestMode()
}

/** `hl****@tkcnco.com`: first 2 characters of the local part, the rest masked. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return '****'
  const local = email.slice(0, at)
  const keep = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2)
  return `${keep}****${email.slice(at)}`
}

export function otpVerifiedRecently(signer: SignerRow, now = Date.now()): boolean {
  if (!signer.otp_verified_at) return false
  const t = Date.parse(signer.otp_verified_at)
  return Number.isFinite(t) && now - t <= OTP_VERIFIED_VALID_MS && t <= now + 60_000
}

export function otpStatus(signer: SignerRow): { required: boolean; verified: boolean; email_masked: string } {
  return { required: otpRequired(), verified: otpVerifiedRecently(signer), email_masked: maskEmail(signer.email) }
}

function hashCode(signerId: string, code: string): string {
  return crypto.createHmac('sha256', sessionSecret() + signerId).update(code).digest('hex')
}

function getSigner(id: string): SignerRow | undefined {
  return db().prepare('SELECT * FROM signers WHERE id = ?').get(id) as SignerRow | undefined
}

// Test-only: last generated code per signer, kept ONLY in test mode.
const g = globalThis as unknown as { __esignOtpPeek?: Map<string, string> }
const peek = (g.__esignOtpPeek ??= new Map())

/** Test hook: the last code generated for `signerId`. Throws unless OTP_TEST_MODE=1 and MAIL_DISABLED=1. */
export function __otpTestPeek(signerId: string): string | undefined {
  if (!otpTestMode()) throw new Error('__otpTestPeek is only available with OTP_TEST_MODE=1 and MAIL_DISABLED=1')
  return peek.get(signerId)
}

/**
 * Generates and sends a new code (invalidating any previous one). Caller has already checked
 * that the signer may sign now. Throws OtpError 429 on cooldown / hourly limit, 502 when mail fails.
 */
export async function issueOtp(
  doc: DocumentRow,
  signerId: string,
  info: ClientInfo,
): Promise<{ expires_in: number; resend_in: number }> {
  const signer = getSigner(signerId)
  if (!signer) throw new OtpError('서명자를 찾을 수 없습니다.', 404)
  const now = Date.now()

  const last = signer.otp_sent_at ? Date.parse(signer.otp_sent_at) : NaN
  if (Number.isFinite(last) && now - last < OTP_RESEND_COOLDOWN_MS) {
    const s = Math.ceil((OTP_RESEND_COOLDOWN_MS - (now - last)) / 1000)
    throw new OtpError(`${s}초 후에 다시 요청할 수 있습니다.`, 429, { retryAfter: s })
  }
  const hourAgo = new Date(now - 3600_000).toISOString()
  const recent = db()
    .prepare("SELECT at FROM events WHERE signer_id = ? AND type = 'otp_sent' AND at > ? ORDER BY at ASC")
    .all(signer.id, hourAgo) as { at: string }[]
  if (recent.length >= OTP_MAX_SENDS_PER_HOUR) {
    const s = Math.max(1, Math.ceil((Date.parse(recent[0].at) + 3600_000 - now) / 1000))
    throw new OtpError(
      `인증번호 요청 횟수를 초과했습니다. ${Math.ceil(s / 60)}분 후에 다시 시도해 주세요.`,
      429,
      { retryAfter: s },
    )
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  const sentAt = new Date(now).toISOString()
  const expiresAt = new Date(now + OTP_TTL_MS).toISOString()
  // Claim the cooldown and replace the old code synchronously, before any await (no double sends).
  db()
    .prepare('UPDATE signers SET otp_hash = ?, otp_expires_at = ?, otp_attempts = 0, otp_sent_at = ? WHERE id = ?')
    .run(hashCode(signer.id, code), expiresAt, sentAt, signer.id)

  if (otpTestMode()) {
    peek.set(signer.id, code)
    console.log(`[otp] ${signer.email} ${code}`)
  } else {
    const r = await sendMail({ to: signer.email, ...otpEmail(doc, signer, code) })
    if (!r.ok) {
      // Undo: no usable code, no cooldown.
      db()
        .prepare('UPDATE signers SET otp_hash = NULL, otp_expires_at = NULL, otp_sent_at = ? WHERE id = ? AND otp_sent_at = ?')
        .run(signer.otp_sent_at, signer.id, sentAt)
      logEvent({
        document_id: doc.id,
        signer_id: signer.id,
        type: 'email_failed',
        detail: `인증번호 → ${signer.email}: ${r.error ?? 'unknown error'}`,
      })
      throw new OtpError('인증번호 메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.', 502)
    }
  }
  logEvent({
    document_id: doc.id,
    signer_id: signer.id,
    type: 'otp_sent',
    ip: info.ip,
    user_agent: info.userAgent,
    detail: `인증번호 발송 → ${maskEmail(signer.email)}${otpTestMode() ? ' (테스트 모드)' : ''}`,
  })
  return { expires_in: OTP_TTL_MS / 1000, resend_in: OTP_RESEND_COOLDOWN_MS / 1000 }
}

/**
 * Checks `code` against the stored hash. 200 → sets otp_verified_at.
 * Throws OtpError: 400 wrong (with remaining), 410 expired/none, 429 too many wrong attempts.
 */
export function verifyOtp(doc: DocumentRow, signerId: string, code: unknown, info: ClientInfo): { verified_at: string } {
  const signer = getSigner(signerId)
  if (!signer) throw new OtpError('서명자를 찾을 수 없습니다.', 404)
  const c = typeof code === 'string' ? code.trim() : ''
  if (!/^\d{6}$/.test(c)) throw new OtpError('6자리 숫자를 입력하세요.', 400)

  if (!signer.otp_hash) {
    if (signer.otp_attempts >= OTP_MAX_ATTEMPTS)
      throw new OtpError('입력 횟수를 초과했습니다. 새 인증번호를 받아 주세요.', 429, { remaining: 0 })
    throw new OtpError('인증번호가 만료되었습니다. 새 인증번호를 받아 주세요.', 410)
  }
  const exp = signer.otp_expires_at ? Date.parse(signer.otp_expires_at) : NaN
  if (!Number.isFinite(exp) || Date.now() > exp) {
    db().prepare('UPDATE signers SET otp_hash = NULL, otp_expires_at = NULL WHERE id = ? AND otp_hash = ?').run(signer.id, signer.otp_hash)
    throw new OtpError('인증번호가 만료되었습니다. 새 인증번호를 받아 주세요.', 410)
  }

  const expected = Buffer.from(signer.otp_hash, 'hex')
  const actual = Buffer.from(hashCode(signer.id, c), 'hex')
  const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual)

  if (!match) {
    const attempts = signer.otp_attempts + 1
    const exhausted = attempts >= OTP_MAX_ATTEMPTS
    db()
      .prepare(
        `UPDATE signers SET otp_attempts = otp_attempts + 1${exhausted ? ', otp_hash = NULL, otp_expires_at = NULL' : ''} WHERE id = ? AND otp_hash = ?`,
      )
      .run(signer.id, signer.otp_hash)
    logEvent({
      document_id: doc.id,
      signer_id: signer.id,
      type: 'otp_failed',
      ip: info.ip,
      user_agent: info.userAgent,
      detail: exhausted ? `인증번호 ${attempts}회 오류, 인증번호 무효화` : `인증번호 오류 (${attempts}/${OTP_MAX_ATTEMPTS})`,
    })
    if (exhausted) throw new OtpError('입력 횟수를 초과했습니다. 새 인증번호를 받아 주세요.', 429, { remaining: 0 })
    const remaining = OTP_MAX_ATTEMPTS - attempts
    throw new OtpError(`인증번호가 일치하지 않습니다. (남은 시도 ${remaining}회)`, 400, { remaining })
  }

  const verifiedAt = nowIso()
  const r = db()
    .prepare(
      'UPDATE signers SET otp_verified_at = ?, otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0 WHERE id = ? AND otp_hash = ?',
    )
    .run(verifiedAt, signer.id, signer.otp_hash)
  if (Number(r.changes) !== 1) throw new OtpError('인증번호가 만료되었습니다. 새 인증번호를 받아 주세요.', 410)
  peek.delete(signer.id)
  logEvent({
    document_id: doc.id,
    signer_id: signer.id,
    type: 'otp_verified',
    ip: info.ip,
    user_agent: info.userAgent,
    detail: `이메일 인증 완료 (${maskEmail(signer.email)})`,
  })
  return { verified_at: verifiedAt }
}
