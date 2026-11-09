import { checkPassword, createSession } from '@/lib/auth'
import { csrfOk, rateCount, rateKey, rateLimit } from '@/lib/http'
import { adminPasswordProblem } from '@/lib/session'

// Failed logins across all clients: 30 per 10 minutes, on top of 5/min per client.
const GLOBAL_FAIL_KEY = 'login-fail:global'
const GLOBAL_FAIL_LIMIT = 30
const GLOBAL_FAIL_WINDOW_MS = 10 * 60_000

export async function POST(req: Request) {
  if (!csrfOk(req)) return Response.json({ error: '허용되지 않은 요청 출처입니다.' }, { status: 403 })

  const problem = adminPasswordProblem()
  if (problem) {
    console.error(`[auth] ${problem}`)
    return Response.json(
      { error: '서버 설정 오류: ADMIN_PASSWORD가 없거나 12자 미만입니다. .env.local을 수정한 뒤 서버를 다시 시작하세요.' },
      { status: 500 },
    )
  }

  if (rateCount(GLOBAL_FAIL_KEY) >= GLOBAL_FAIL_LIMIT) {
    return Response.json(
      { error: '로그인 실패가 너무 많아 잠시 잠겼습니다. 10분 후 다시 시도해 주세요.' },
      { status: 429, headers: { 'Retry-After': '600' } },
    )
  }
  // 5 attempts per minute per client (see TRUST_PROXY in lib/http.ts).
  if (!rateLimit(`login:${rateKey(req)}`, 5, 60_000)) {
    return Response.json(
      { error: '시도 횟수가 너무 많습니다. 1분 후 다시 시도해 주세요.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    )
  }

  let password = ''
  try {
    const body = (await req.json()) as { password?: unknown }
    if (typeof body.password === 'string') password = body.password
  } catch {
    return Response.json({ error: '잘못된 요청입니다.' }, { status: 400 })
  }
  if (!password || password.length > 1024 || !checkPassword(password)) {
    rateLimit(GLOBAL_FAIL_KEY, GLOBAL_FAIL_LIMIT, GLOBAL_FAIL_WINDOW_MS)
    return Response.json({ error: '비밀번호가 올바르지 않습니다.' }, { status: 401 })
  }

  try {
    await createSession()
  } catch (err) {
    console.error('[auth] createSession failed', err)
    return Response.json({ error: '서버 설정 오류로 로그인할 수 없습니다.' }, { status: 500 })
  }
  return Response.json({ ok: true })
}
