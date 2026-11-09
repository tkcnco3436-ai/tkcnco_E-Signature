import type { DocumentStatus } from '@/lib/types'
import { DOC_STATUS } from './format'

export default function StatusBadge({ status }: { status: DocumentStatus }) {
  const s = DOC_STATUS[status]
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.cls}`}>
      {s.label}
    </span>
  )
}
