// Request helpers shared by route handlers.

/** Client IP (Cloudflare tunnel first, then proxies) and a truncated user agent. */
export function clientInfo(req: Request): { ip: string | null; userAgent: string | null } {
  const h = req.headers
  const pick = (v: string | null | undefined) => {
    const t = (v ?? '').trim()
    return t ? t.slice(0, 100) : null
  }
  const ip =
    pick(h.get('cf-connecting-ip')) ?? pick(h.get('x-forwarded-for')?.split(',')[0]) ?? pick(h.get('x-real-ip'))
  const ua = (h.get('user-agent') ?? '').trim()
  return { ip, userAgent: ua ? ua.slice(0, 300) : null }
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
