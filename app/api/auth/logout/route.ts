import { destroySession } from '@/lib/auth'
import { csrfOk } from '@/lib/http'

export async function POST(req: Request) {
  if (!csrfOk(req)) return Response.json({ error: '허용되지 않은 요청 출처입니다.' }, { status: 403 })
  await destroySession()
  return Response.json({ ok: true })
}
