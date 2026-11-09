import 'server-only'
import crypto from 'node:crypto'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { csrfOk, originAllowed } from './http'
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  adminPasswordProblem,
  passwordFingerprint,
  sessionSecret,
  signSessionToken,
  verifySessionToken,
} from './session'

function secureCookie(): boolean {
  return (process.env.APP_URL || '').toLowerCase().startsWith('https')
}

let warnedPassword = false

/** Throws (once logged) when ADMIN_PASSWORD is missing or too short. */
export function assertAdminPasswordConfigured(): void {
  const problem = adminPasswordProblem()
  if (!problem) return
  if (!warnedPassword) {
    warnedPassword = true
    console.error(`[auth] ${problem} Admin login is refused until this is fixed.`)
  }
  throw new Error(problem)
}

/**
 * True when the request carries a valid owner session cookie (signed with the current
 * ADMIN_PASSWORD fingerprint) and no cross-site Origin header.
 */
export async function isAdmin(): Promise<boolean> {
  if (adminPasswordProblem()) return false
  // Cross-site requests never count as admin (CSRF). Same-origin and Origin-less requests pass.
  if (!originAllowed(await headers())) return false
  const secret = sessionSecret()
  const store = await cookies()
  return verifySessionToken(secret, store.get(SESSION_COOKIE)?.value, await passwordFingerprint(secret))
}

/**
 * Route-handler guard: 403 for a cross-site state-changing request, 401 without a session,
 * null when the caller may proceed.
 */
export async function adminGuard(req: Request): Promise<Response | null> {
  if (!csrfOk(req)) return Response.json({ error: '허용되지 않은 요청 출처입니다.' }, { status: 403 })
  if (!(await isAdmin())) return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 })
  return null
}

/**
 * For server components / pages: redirects to /login when not logged in.
 * Route handlers should use `isAdmin()` / `adminGuard()` and return 401 themselves.
 */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) redirect('/login')
}

/** Timing-safe comparison against ADMIN_PASSWORD. Throws when ADMIN_PASSWORD is unset or < 12 chars. */
export function checkPassword(pw: string): boolean {
  assertAdminPasswordConfigured()
  const expected = process.env.ADMIN_PASSWORD as string
  if (typeof pw !== 'string') return false
  // Hash both sides so lengths match and timingSafeEqual never throws.
  const a = crypto.createHash('sha256').update(pw, 'utf8').digest()
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}

export async function createSession(): Promise<void> {
  const secret = sessionSecret()
  const token = await signSessionToken(secret, Date.now(), await passwordFingerprint(secret))
  const store = await cookies()
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(),
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
}

export async function destroySession(): Promise<void> {
  const store = await cookies()
  store.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(),
    path: '/',
    maxAge: 0,
  })
}
