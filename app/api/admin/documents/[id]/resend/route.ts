import { adminGuard } from '@/lib/auth'
import { getDocument } from '@/lib/db'
import { resendNotification } from '@/lib/workflow'
import { errorResponse, json } from '../../../_util'

/**
 * `notified`: the first entry (or null) — kept for the existing UI, which shows one link.
 * `notifiedAll`: every notification. For a completed document this is the completion email
 * re-sent to all signers (links are download links). `completed` reports the document status
 * afterwards (true after a successful sealing retry).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await adminGuard(req)
  if (denied) return denied
  const { id } = await params
  try {
    const list = await resendNotification(id)
    const completed = getDocument(id)?.status === 'completed'
    return json({ notified: list[0] ?? null, notifiedAll: list, completed })
  } catch (err) {
    return errorResponse(err, 'resendNotification')
  }
}