// Request helpers shared by route handlers and proxy.ts.

export type TrustProxy = 'cloudflare' | 'none'

/**
 * Which forwarding header to believe for the client IP.
 * - `cloudflare`: only `cf-connecting-ip` (set it when the app is reached through cloudflared;
 *   scripts/start.ps1 does this automatically). The server must bind to 127.0.0.1 so nobody can
 *   reach it directly with a forged header.
 * - `none` (default): forwarding headers are ignored. Route handlers cannot see the socket
 *   address, so the IP is unknown (null) and rate limits share one 'local' bucket.
 */
export function trustProxy(): TrustProxy {
  const v = (process.env.TRUST_PROXY ?? '').trim().toLowerCase()
  return v === 'cloudflare' ? 'cloudflare' : 'none'
}

/** Client IP per TRUST_PROXY (null when unknown) and a truncated user agent. */
export function clientInfo(req: Request): { ip: string | null; userAgent: string | null } {
  const h = req.headers
  let ip: string | null = null
  if (trustProxy() === 'cloudflare') {
    const t = (h.get('cf-connecting-ip') ?? '').trim()
    // IPv4 / IPv6 characters only; anything else is not a real Cloudflare value.
    ip = t && /^[0-9A-Fa-f:.]{2,45}$/.test(t) ? t : null
  }
  const ua = (h.get('user-agent') ?? '').trim()
  return { ip, userAgent: ua ? ua.slice(0, 300) : null }
}

/** Key for rate limiting: the trusted client IP, or one shared 'local' bucket when unknown. */
export function rateKey(req: Request): string {
  return clientInfo(req).ip ?? 'local'
}

// Tiny in-memory fixed-window rate limiter (per process; fine for a single-instance app).
const g = globalThis as unknown as { __esignRate?: Map<string, { count: number; reset: number }> }
const buckets = (g.__esignRate ??= new Map())

/** Returns true when the call is allowed, false when `key` exceeded `limit` within `windowMs`. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k)
  }
  const b = buckets.get(key)
  if (!b || b.reset <= now) {
    buckets.set(key, { count: 1, reset: now + windowMs })
    return true
  }
  b.count++
  return b.count <= limit
}

/** Current count for `key` in its window, without incrementing (0 when no live window). */
export function rateCount(key: string): number {
  const b = buckets.get(key)
  return b && b.reset > Date.now() ? b.count : 0
}

function hostOf(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * CSRF guard: false when the request carries an `Origin` header that matches neither the request
 * `Host` nor the APP_URL host. Requests without `Origin` (curl, same-origin GET) pass; the session
 * cookie is sameSite=lax on top of this.
 */
export function originAllowed(headers: Headers): boolean {
  const origin = headers.get('origin')
  if (!origin) return true
  if (origin === 'null') return false
  const o = hostOf(origin)
  if (!o) return false
  const host = (headers.get('host') ?? '').trim().toLowerCase()
  return o === host || o === hostOf(process.env.APP_URL)
}

/** Same as originAllowed, but only state-changing methods are checked. */
export function csrfOk(req: Request): boolean {
  const m = req.method.toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true
  return originAllowed(req.headers)
}
