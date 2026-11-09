// Shared domain types. Every module imports from here. Do not redefine elsewhere.

export type DocumentStatus = 'draft' | 'sent' | 'completed' | 'voided'
export type SignerStatus = 'pending' | 'sent' | 'viewed' | 'signed'
export type FieldType = 'signature' | 'name' | 'date' | 'text'

export interface DocumentRow {
  id: string
  title: string
  status: DocumentStatus
  page_count: number
  original_sha256: string
  signed_sha256: string | null
  message: string | null // optional note shown to signers and in the email
  created_at: string // ISO 8601
  sent_at: string | null
  completed_at: string | null
  // RFC 3161 signature timestamp embedded in the PAdES signature (null when none / failed)
  timestamp_at: string | null // genTime from the TSA token, ISO 8601
  timestamp_tsa: string | null // TSA URL used
}

export interface SignerRow {
  id: string
  document_id: string
  name: string
  email: string
  is_owner: 0 | 1 // 1 = the app owner (me). Owner signs inside the admin session.
  order_index: number // 0-based signing order. Lower signs first.
  token: string // 64 hex chars. Secret part of the signing link /sign/[token]
  status: SignerStatus
  signature_png: string | null // data:image/png;base64,... captured at signing
  signed_at: string | null
  ip: string | null
  user_agent: string | null
  // Email OTP identity check
  otp_hash: string | null // HMAC of the current code (never the code itself)
  otp_expires_at: string | null
  otp_attempts: number // failed attempts for the current code
  otp_sent_at: string | null // last send time (resend cooldown)
  otp_verified_at: string | null // set when the signer proved control of the email
}

// Coordinates are normalized to the page: 0..1, origin TOP-LEFT (browser convention).
// The PDF stamping code converts to PDF points (origin bottom-left).
export interface FieldRow {
  id: string
  document_id: string
  signer_id: string
  page: number // 1-based
  x: number
  y: number
  w: number
  h: number
  type: FieldType
  label: string | null
  value: string | null // filled at signing time (text/name/date). Signature uses signer.signature_png.
}

export type EventType =
  | 'created'
  | 'sent'
  | 'email_sent'
  | 'email_failed'
  | 'viewed'
  | 'signed'
  | 'completed'
  | 'voided'
  | 'otp_sent'
  | 'otp_verified'
  | 'otp_failed'
  | 'timestamped'
  | 'timestamp_failed'

export interface EventRow {
  id: string
  document_id: string
  signer_id: string | null
  type: EventType
  ip: string | null
  user_agent: string | null
  detail: string | null
  at: string
}

export interface DocumentBundle {
  document: DocumentRow
  signers: SignerRow[]
  fields: FieldRow[]
  events: EventRow[]
}
