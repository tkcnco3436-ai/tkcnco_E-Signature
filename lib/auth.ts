import 'server-only'
import crypto from 'node:crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE, SESSION_TTL_SECONDS, sessionSecret, signSessionToken, verifySessionToken } from './session'

function secureCookie(): boolean {
  return (process.env.APP_URL || '').toLowerCase().startsWith('https')
}

/** True when the request carries a valid owner session cookie. */
export async function isAdmin(): Promise<boolean> {
  const store = await cookies()
  return verifySessionToken(sessionSecret(), store.get(SESSION_COOKIE)?.value)
}

/**
 * For server components / pages: redirects to /login when not logged in.
 * Route handlers should use `isAdmin()` and return 401 themselves.
 */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) redirect('/login')
}

/** Timing-safe comparison against ADMIN_PASSWORD. */
export function checkPassword(pw: string): boolean {
  const expected = process.env.ADMIN_PASSWORD
  if (!expected || typeof pw !== 'string') return false
  // Hash both sides so lengths match and timingSafeEqual never throws.
  const a = crypto.createHash('sha256').update(pw, 'utf8').digest()
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}

export async function createSession(): Promise<void> {
  const token = await signSessionToken(sessionSecret())
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
