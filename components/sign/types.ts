// Shape returned by GET /api/sign/[token]. Shared by the route handler and the signer UI.
import type { DocumentStatus, FieldType, SignerStatus } from '@/lib/types'

export interface SignField {
  id: string
  page: number // 1-based
  x: number // normalized 0..1, origin top-left
  y: number
  w: number
  h: number
  type: FieldType
  label: string | null
  mine: boolean
  value: string | null // only for own fields; always null for others
}

export interface SignViewResponse {
  document: { id: string; title: string; message: string | null; page_count: number; status: DocumentStatus }
  signer: { id: string; name: string; email: string; status: SignerStatus; signed_at: string | null }
  fields: SignField[]
  canSign: boolean
  reason: string | null
  progress: { signed: number; total: number }
}

export interface SignSubmitBody {
  signaturePng: string
  values: Record<string, string>
  consent: true
}
