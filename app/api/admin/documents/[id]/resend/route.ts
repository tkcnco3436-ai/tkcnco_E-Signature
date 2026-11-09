import { isAdmin } from '@/lib/auth'
import { resendNotification } from '@/lib/workflow'
import { errorResponse, json, unauthorized } from '../../../_util'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return unauthorized()
  const { id } = await params
  try {
    return json({ notified: await resendNotification(id) })
  } catch (err) {
    return errorResponse(err, 'resendNotification')
  }
}
