// Next 16: `middleware.ts` was renamed to `proxy.ts` (runs on the Node.js runtime by default).
// Guards the owner area. Route handlers / pages still re-check with lib/auth.ts.
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySessionToken } from './lib/session'

export async function proxy(request: NextRequest) {
  const secret = process.env.SESSION_SECRET
  const token = request.cookies.get(SESSION_COOKIE)?.value
  const ok = !!secret && secret.length >= 32 && (await verifySessionToken(secret, token))
  if (ok) return NextResponse.next()

  const { pathname, search } = request.nextUrl
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  url.searchParams.set('next', pathname + search)
  return NextResponse.redirect(url)
}

export const config = {
  matcher: ['/admin', '/admin/:path*', '/api/admin', '/api/admin/:path*'],
}
