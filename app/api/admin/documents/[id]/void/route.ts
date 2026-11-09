import { isAdmin } from '@/lib/auth'
import { voidDocument } from '@/lib/workflow'
import { errorResponse, json, unauthorized } from '../../../_util'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return unauthorized()
  const { id } = await params
  try {
    voidDocument(id)
    return json({ ok: true })
  } catch (err) {
    return errorResponse(err, 'voidDocument')
  }
}
