import { checkPassword, createSession } from '@/lib/auth'
import { clientInfo, rateLimit } from '@/lib/http'

export async function POST(req: Request) {
  const { ip } = clientInfo(req)
  // 5 attempts per minute per IP.
  if (!rateLimit(`login:${ip ?? 'unknown'}`, 5, 60_000)) {
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
