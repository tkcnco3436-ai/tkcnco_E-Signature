// Next 16: `middleware.ts` was renamed to `proxy.ts` (runs on the Node.js runtime by default).
// Guards the owner pages (/admin). Pages still re-check with lib/auth.ts.
//
// /api/admin is deliberately NOT matched: when a proxy runs, Next buffers the whole request
// body (up to proxyClientMaxBodySize) before the proxy's response is sent, so an anonymous
// client could make the server read a 20 MB upload just to get a 401. Every admin route
// handler checks the session itself (isAdmin / adminGuard), which also rejects cross-site
// Origin headers (CSRF).
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE, adminPasswordProblem, passwordFingerprint, verifySessionToken } from './lib/session'

export async function proxy(request: NextRequest) {
  const secret = process.env.SESSION_SECRET
  const token = request.cookies.get(SESSION_COOKIE)?.value
  const ok =
    !!secret &&
    secret.length >= 32 &&
    !adminPasswordProblem() &&
    (await verifySessionToken(secret, token, await passwordFingerprint(secret)))
  if (ok) return NextResponse.next()

  const { pathname, search } = request.nextUrl
  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  url.searchParams.set('next', pathname + search)
  return NextResponse.redirect(url)
}

export const config = {
  matcher: ['/admin', '/admin/:path*'],
}
