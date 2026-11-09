import 'server-only'
import { WorkflowError } from '@/lib/workflow'

// Shared helpers for admin route handlers (not a route: no route.ts in this folder).

export const MAX_PDF_BYTES = 20 * 1024 * 1024

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
}

export function unauthorized(): Response {
  return json({ error: '로그인이 필요합니다.' }, 401)
}

export function badRequest(message: string): Response {
  return json({ error: message }, 400)
}

/** WorkflowError -> its status. Anything else -> 500 with a generic message (details logged). */
export function errorResponse(err: unknown, context: string): Response {
  if (err instanceof WorkflowError) return json({ error: err.message }, err.status)
  console.error(`[admin api] ${context}`, err)
  return json({ error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' }, 500)
}

export const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/
