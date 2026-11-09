// Session token signing/verification shared by lib/auth.ts and proxy.ts.
// Uses Web Crypto (globalThis.crypto.subtle) so it works in any runtime
// (Next 16 proxy runs on Node.js by default, but this stays edge-safe).

export const SESSION_COOKIE = 'esign_session'
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

interface SessionPayload {
  iat: number // issued-at, unix seconds
  exp: number // expiry, unix seconds
  pwf?: string // ADMIN_PASSWORD fingerprint: changing the password revokes existing sessions
}

export const MIN_ADMIN_PASSWORD_LENGTH = 12

/** Human-readable problem with ADMIN_PASSWORD, or null when it is acceptable. */
export function adminPasswordProblem(pw = process.env.ADMIN_PASSWORD): string | null {
  if (!pw) return 'ADMIN_PASSWORD is not set. Set it in .env.local.'
  if (pw.length < MIN_ADMIN_PASSWORD_LENGTH)
    return `ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters (currently ${pw.length}). Change it in .env.local.`
  return null
}

const enc = new TextEncoder()

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET
  if (!s || s.length < 32) {
    throw new Error(
      'SESSION_SECRET is missing or shorter than 32 characters. Set it in .env.local ' +
        "(generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\")",
    )
  }
  return s
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

/** First 16 hex chars of HMAC-SHA256(secret, ADMIN_PASSWORD). Embedded in the session payload. */
export async function passwordFingerprint(secret: string, password = process.env.ADMIN_PASSWORD ?? ''): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode('pwf:' + password)))
  let hex = ''
  for (const b of mac.subarray(0, 8)) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** `pwf` (password fingerprint) is included when given; verify with the same value. */
export async function signSessionToken(secret: string, now = Date.now(), pwf?: string): Promise<string> {
  const iat = Math.floor(now / 1000)
  const payload: SessionPayload = { iat, exp: iat + SESSION_TTL_SECONDS, ...(pwf ? { pwf } : {}) }
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)))
  return `${body}.${b64urlEncode(sig)}`
}

/**
 * Constant-time HMAC verification (crypto.subtle.verify) plus expiry check.
 * When `pwf` is given, the token must carry the same password fingerprint.
 */
export async function verifySessionToken(
  secret: string,
  token: string | undefined | null,
  pwf?: string,
): Promise<boolean> {
  if (!token || token.length > 512) return false
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return false
  const body = token.slice(0, dot)
  const sig = b64urlDecode(token.slice(dot + 1))
  if (!sig || sig.length !== 32) return false
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(body))
  if (!ok) return false
  const raw = b64urlDecode(body)
  if (!raw) return false
  try {
    const p = JSON.parse(new TextDecoder().decode(raw)) as Partial<SessionPayload>
    const now = Math.floor(Date.now() / 1000)
    if (pwf !== undefined && p.pwf !== pwf) return false
    return typeof p.exp === 'number' && typeof p.iat === 'number' && p.exp > now && p.iat <= now + 60
  } catch {
    return false
  }
}
