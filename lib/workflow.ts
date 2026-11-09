import 'server-only'
import crypto from 'node:crypto'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { PDFDocument } from 'pdf-lib'
import {
  db,
  docDir,
  getBundle,
  getDocument,
  getSignerByToken,
  getSigners,
  logEvent,
  newId,
  newToken,
  nowIso,
  originalPdfPath,
  sha256,
  signedPdfPath,
  tx,
} from './db'
import { completedEmail, sealFailedEmail, sendMail, signRequestEmail } from './mail'
import { PdfValidationError, validatePdf } from './pdf'
import { buildSealedPdf } from './seal'
import { kstDate } from './time'
import type { DocumentBundle, DocumentRow, FieldType, SignerRow } from './types'

/** Error with an HTTP status, thrown by every workflow function on invalid input/state. */
export class WorkflowError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'WorkflowError'
    this.status = status
  }
}

type ClientInfo = { ip: string | null; userAgent: string | null }
type Notified = { signerId: string; link: string; emailed: boolean }

const FIELD_TYPES: readonly FieldType[] = ['signature', 'name', 'date', 'text']
const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/
const MAX_SIGNATURE_BYTES = 500 * 1024
const MAX_SIGNATURE_WIDTH = 3000
const MAX_SIGNATURE_HEIGHT = 1500
const MAX_VALUE_LEN = 500

function appUrl(): string {
  return (process.env.APP_URL || 'http://localhost:3100').replace(/\/+$/, '')
}

export function signLink(token: string): string {
  return `${appUrl()}/sign/${token}`
}

export function downloadLink(token: string): string {
  return `${appUrl()}/api/sign/${token}/download`
}

export function adminLink(documentId: string): string {
  return `${appUrl()}/admin/documents/${documentId}`
}

/** Owner's address: the owner signer's email, else OWNER_EMAIL. */
function ownerEmail(signers: SignerRow[]): string | null {
  const owner = signers.find((s) => s.is_owner)
  const e = owner?.email?.trim() || process.env.OWNER_EMAIL?.trim()
  return e && EMAIL_RE.test(e) ? e : null
}

function mustGetDocument(id: string): DocumentRow {
  const d = getDocument(id)
  if (!d) throw new WorkflowError('문서를 찾을 수 없습니다.', 404)
  return d
}

function mustGetBundle(id: string): DocumentBundle {
  const b = getBundle(id)
  if (!b) throw new WorkflowError('문서를 찾을 수 없습니다.', 404)
  return b
}

function safeFilename(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim().slice(0, 80) || 'document'
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

export async function createDocument(input: {
  title: string
  pdf: Uint8Array
  message?: string | null
}): Promise<DocumentRow> {
  const title = (input.title ?? '').trim()
  if (!title) throw new WorkflowError('제목을 입력하세요.')
  if (title.length > 200) throw new WorkflowError('제목은 200자 이하여야 합니다.')
  const message = input.message?.trim() ? input.message.trim().slice(0, 2000) : null

  let pageCount: number
  try {
    pageCount = (await validatePdf(input.pdf)).pageCount
  } catch (err) {
    if (err instanceof PdfValidationError) throw new WorkflowError(err.message, 400)
    throw err
  }

  const id = newId()
  fs.mkdirSync(docDir(id), { recursive: true })
  fs.writeFileSync(originalPdfPath(id), input.pdf)
  const row: DocumentRow = {
    id,
    title,
    status: 'draft',
    page_count: pageCount,
    original_sha256: sha256(input.pdf),
    signed_sha256: null,
    message,
    created_at: nowIso(),
    sent_at: null,
    completed_at: null,
  }
  try {
    tx(() => {
      db()
        .prepare(
          'INSERT INTO documents (id, title, status, page_count, original_sha256, signed_sha256, message, created_at, sent_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(row.id, row.title, row.status, row.page_count, row.original_sha256, null, row.message, row.created_at, null, null)
      logEvent({ document_id: id, type: 'created', detail: `원본 SHA-256 ${row.original_sha256}` })
    })
  } catch (err) {
    fs.rmSync(docDir(id), { recursive: true, force: true })
    throw err
  }
  return row
}

export function saveDraft(
  documentId: string,
  input: {
    title?: string
    message?: string | null
    signers: { id?: string; name: string; email: string; is_owner: boolean; order_index: number }[]
    fields: {
      signer_ref: number
      page: number
      x: number
      y: number
      w: number
      h: number
      type: FieldType
      label?: string | null
    }[]
  },
): DocumentBundle {
  const doc = mustGetDocument(documentId)
  if (doc.status !== 'draft') throw new WorkflowError('초안 상태에서만 수정할 수 있습니다.', 409)

  let title = doc.title
  if (input.title !== undefined) {
    title = String(input.title).trim()
    if (!title) throw new WorkflowError('제목을 입력하세요.')
    if (title.length > 200) throw new WorkflowError('제목은 200자 이하여야 합니다.')
  }
  let message = doc.message
  if (input.message !== undefined) message = input.message?.trim() ? input.message.trim().slice(0, 2000) : null

  const signers = Array.isArray(input.signers) ? input.signers : []
  const fields = Array.isArray(input.fields) ? input.fields : []
  if (signers.length < 1) throw new WorkflowError('서명자를 1명 이상 추가하세요.')
  if (signers.length > 20) throw new WorkflowError('서명자는 최대 20명입니다.')
  if (fields.length > 500) throw new WorkflowError('필드가 너무 많습니다.')

  const orders = new Set<number>()
  let owners = 0
  const cleanSigners = signers.map((s, i) => {
    const name = String(s?.name ?? '').trim()
    const email = String(s?.email ?? '').trim()
    if (!name) throw new WorkflowError(`${i + 1}번째 서명자의 이름을 입력하세요.`)
    if (name.length > 100) throw new WorkflowError(`${i + 1}번째 서명자의 이름이 너무 깁니다.`)
    if (!EMAIL_RE.test(email) || email.length > 254)
      throw new WorkflowError(`${i + 1}번째 서명자의 이메일 주소가 올바르지 않습니다.`)
    if (!Number.isInteger(s.order_index) || s.order_index < 0)
      throw new WorkflowError(`${i + 1}번째 서명자의 순서가 올바르지 않습니다.`)
    if (orders.has(s.order_index)) throw new WorkflowError('서명 순서가 중복되었습니다.')
    orders.add(s.order_index)
    if (s.is_owner) owners++
    return { id: s.id, name, email, is_owner: s.is_owner ? 1 : 0, order_index: s.order_index }
  })
  if (owners > 1) throw new WorkflowError('발신자(소유자) 서명자는 한 명만 지정할 수 있습니다.')

  const sigCount = new Array<number>(cleanSigners.length).fill(0)
  const cleanFields = fields.map((f, i) => {
    const n = i + 1
    if (!Number.isInteger(f?.signer_ref) || f.signer_ref < 0 || f.signer_ref >= cleanSigners.length)
      throw new WorkflowError(`${n}번째 필드의 서명자 지정이 올바르지 않습니다.`)
    if (!Number.isInteger(f.page) || f.page < 1 || f.page > doc.page_count)
      throw new WorkflowError(`${n}번째 필드의 페이지 번호가 올바르지 않습니다.`)
    if (!FIELD_TYPES.includes(f.type)) throw new WorkflowError(`${n}번째 필드의 종류가 올바르지 않습니다.`)
    const nums = [f.x, f.y, f.w, f.h]
    if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v)))
      throw new WorkflowError(`${n}번째 필드의 위치가 올바르지 않습니다.`)
    const eps = 1e-6
    if (f.w <= 0 || f.h <= 0 || f.x < -eps || f.y < -eps || f.x + f.w > 1 + eps || f.y + f.h > 1 + eps)
      throw new WorkflowError(`${n}번째 필드가 페이지 밖에 있습니다.`)
    const clamp = (v: number) => Math.min(1, Math.max(0, v))
    if (f.type === 'signature') sigCount[f.signer_ref]++
    const label = f.label?.trim() ? f.label.trim().slice(0, 100) : null
    return { ...f, x: clamp(f.x), y: clamp(f.y), w: clamp(f.w), h: clamp(f.h), label }
  })
  sigCount.forEach((c, i) => {
    if (c < 1) throw new WorkflowError(`${cleanSigners[i].name} 서명자에게 서명 필드를 1개 이상 배치하세요.`)
  })

  const existing = new Map(getSigners(documentId).map((s) => [s.id, s]))
  tx(() => {
    const d = db()
    d.prepare('UPDATE documents SET title = ?, message = ? WHERE id = ?').run(title, message, documentId)
    d.prepare('DELETE FROM fields WHERE document_id = ?').run(documentId)
    const keep = new Set<string>()
    const ids = cleanSigners.map((s) => {
      const prev = s.id ? existing.get(s.id) : undefined
      if (prev && !keep.has(prev.id)) {
        keep.add(prev.id)
        d.prepare('UPDATE signers SET name = ?, email = ?, is_owner = ?, order_index = ?, status = ? WHERE id = ?').run(
          s.name,
          s.email,
          s.is_owner,
          s.order_index,
          'pending',
          prev.id,
        )
        return prev.id
      }
      const id = newId()
      keep.add(id)
      d.prepare(
        'INSERT INTO signers (id, document_id, name, email, is_owner, order_index, token, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, documentId, s.name, s.email, s.is_owner, s.order_index, newToken(), 'pending')
      return id
    })
    for (const prev of existing.values()) {
      if (!keep.has(prev.id)) d.prepare('DELETE FROM signers WHERE id = ?').run(prev.id)
    }
    const ins = d.prepare(
      'INSERT INTO fields (id, document_id, signer_id, page, x, y, w, h, type, label, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    )
    for (const f of cleanFields) {
      ins.run(newId(), documentId, ids[f.signer_ref], f.page, f.x, f.y, f.w, f.h, f.type, f.label)
    }
  })
  return mustGetBundle(documentId)
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Tells `signer` it is their turn by emailing a sign link. Approval-line behavior:
 * every signer, the owner included, gets the request email only when their turn comes
 * (send for the first, then after each signature for the next).
 */
async function notifySigner(doc: DocumentRow, signer: SignerRow, _opts: { emailOwner?: boolean } = {}): Promise<Notified> {
  const link = signLink(signer.token)
  if (signer.status === 'pending') {
    db().prepare("UPDATE signers SET status = 'sent' WHERE id = ? AND status = 'pending'").run(signer.id)
  }
  const mail = signRequestEmail(doc, signer, link)
  const r = await sendMail({ to: signer.email, ...mail })
  logEvent({
    document_id: doc.id,
    signer_id: signer.id,
    type: r.ok ? 'email_sent' : 'email_failed',
    detail: r.ok ? `서명 요청 → ${signer.email}` : `서명 요청 → ${signer.email}: ${r.error ?? 'unknown error'}`,
  })
  return { signerId: signer.id, link, emailed: r.ok }
}

function nextUnsigned(signers: SignerRow[]): SignerRow | undefined {
  return [...signers].sort((a, b) => a.order_index - b.order_index).find((s) => s.status !== 'signed')
}

export async function sendDocument(documentId: string): Promise<{ notified: Notified[] }> {
  const bundle = mustGetBundle(documentId)
  const doc = bundle.document
  if (doc.status !== 'draft') throw new WorkflowError('초안 상태의 문서만 발송할 수 있습니다.', 409)
  if (bundle.signers.length < 1) throw new WorkflowError('서명자를 1명 이상 추가하세요.')
  for (const s of bundle.signers) {
    if (!bundle.fields.some((f) => f.signer_id === s.id && f.type === 'signature'))
      throw new WorkflowError(`${s.name} 서명자에게 서명 필드를 1개 이상 배치하세요.`)
  }
  const sentAt = nowIso()
  tx(() => {
    const r = db()
      .prepare("UPDATE documents SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'draft'")
      .run(sentAt, documentId)
    if (Number(r.changes) !== 1) throw new WorkflowError('문서 상태가 변경되었습니다. 새로고침 후 다시 시도하세요.', 409)
    logEvent({ document_id: documentId, type: 'sent', detail: `서명자 ${bundle.signers.length}명` })
  })
  const fresh = mustGetDocument(documentId)
  const first = nextUnsigned(getSigners(documentId))
  const notified: Notified[] = []
  if (first) notified.push(await notifySigner(fresh, first))
  return { notified }
}

/**
 * - `sent` with an unsigned signer: re-notifies whoever's turn it is (fresh link with the current APP_URL).
 * - `sent` with everyone signed (sealing failed earlier): retries sealing; returns [] on success.
 * - `completed`: re-sends the completion email (attachment + fresh download link) to every signer.
 *   Useful after a quick-tunnel restart broke the old links. `link` is then the download link.
 */
export async function resendNotification(documentId: string): Promise<Notified[]> {
  const doc = mustGetDocument(documentId)
  if (doc.status === 'completed') return sendCompletionEmails(documentId, 'resend')
  if (doc.status !== 'sent') throw new WorkflowError('진행 중이거나 완료된 문서만 다시 알릴 수 있습니다.', 409)
  const next = nextUnsigned(getSigners(documentId))
  if (!next) {
    // Everyone signed but sealing previously failed: retry finalization (throws on failure).
    await finalizeDocument(documentId, { throwOnFailure: true })
    return []
  }
  return [await notifySigner(doc, next, { emailOwner: true })]
}

// ---------------------------------------------------------------------------
// Signer side
// ---------------------------------------------------------------------------

function turnCheck(doc: DocumentRow, signer: SignerRow, signers: SignerRow[]): { canSign: boolean; reason?: string } {
  if (doc.status === 'draft') return { canSign: false, reason: '아직 발송되지 않은 문서입니다.' }
  if (doc.status === 'voided') return { canSign: false, reason: '무효 처리된 문서입니다.' }
  if (doc.status === 'completed') return { canSign: false, reason: '모든 서명이 완료된 문서입니다.' }
  if (signer.status === 'signed') return { canSign: false, reason: '이미 서명하셨습니다.' }
  const waiting = signers.some((s) => s.order_index < signer.order_index && s.status !== 'signed')
  if (waiting) return { canSign: false, reason: '앞 순서 서명자의 서명을 기다리고 있습니다.' }
  return { canSign: true }
}

export function signerView(
  token: string,
): { bundle: DocumentBundle; signer: SignerRow; canSign: boolean; reason?: string } | undefined {
  const signer = getSignerByToken(token)
  if (!signer) return undefined
  const bundle = getBundle(signer.document_id)
  if (!bundle) return undefined
  const self = bundle.signers.find((s) => s.id === signer.id) ?? signer
  return { bundle, signer: self, ...turnCheck(bundle.document, self, bundle.signers) }
}

export function markViewed(token: string, info: ClientInfo): void {
  const signer = getSignerByToken(token)
  if (!signer) return
  const doc = getDocument(signer.document_id)
  if (!doc || doc.status !== 'sent') return
  if (signer.status !== 'pending' && signer.status !== 'sent') return
  tx(() => {
    const r = db()
      .prepare("UPDATE signers SET status = 'viewed' WHERE id = ? AND status IN ('pending', 'sent')")
      .run(signer.id)
    if (Number(r.changes) === 1) {
      logEvent({ document_id: doc.id, signer_id: signer.id, type: 'viewed', ip: info.ip, user_agent: info.userAgent })
    }
  })
}

/**
 * Validates the signature PNG fully before it is stored, so a bad image can never make sealing
 * fail later: data-URL shape, size, PNG magic, IHDR dimensions (max 3000x1500), and a trial
 * `embedPng` into a scratch PDF (the same decoder sealing uses).
 */
async function validateSignaturePng(dataUrl: unknown): Promise<string> {
  const prefix = 'data:image/png;base64,'
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) throw new WorkflowError('서명 이미지가 올바르지 않습니다.')
  const b64 = dataUrl.slice(prefix.length)
  if (b64.length > Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3) + 4) throw new WorkflowError('서명 이미지가 너무 큽니다 (최대 500KB).', 413)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new WorkflowError('서명 이미지가 올바르지 않습니다.')
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length > MAX_SIGNATURE_BYTES) throw new WorkflowError('서명 이미지가 너무 큽니다 (최대 500KB).', 413)
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 64 || !magic.every((b, i) => bytes[i] === b)) throw new WorkflowError('서명 이미지가 PNG가 아닙니다.')
  checkPngStructure(bytes)
  try {
    // Same decoder + embedding path as sealing (lib/seal.ts), on a throwaway document.
    const scratch = await PDFDocument.create()
    const img = await scratch.embedPng(bytes)
    scratch.addPage([100, 100]).drawImage(img, { x: 0, y: 0, width: 100, height: 50 })
    await scratch.save()
  } catch {
    throw new WorkflowError('서명 이미지를 읽을 수 없습니다. 다시 그려 주세요.')
  }
  return prefix + b64
}

/**
 * Strict PNG check with Node's own zlib, BEFORE pdf-lib sees the bytes: pdf-lib's bundled
 * decoder can loop forever or silently accept a corrupt zlib stream. Requires: chunk CRCs valid,
 * IHDR first, 8-bit, non-interlaced, color type 0/2/3/4/6 (PLTE for 3), IDAT that inflates to
 * exactly height * (1 + width * channels) bytes with row filter types 0..4, and IEND.
 */
function checkPngStructure(bytes: Buffer): void {
  const bad = (): never => {
    throw new WorkflowError('서명 이미지가 올바르지 않습니다.')
  }
  let off = 8
  let width = 0
  let height = 0
  let colorType = -1
  let sawPlte = false
  let sawEnd = false
  const idat: Buffer[] = []
  while (off + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(off)
    const type = bytes.toString('latin1', off + 4, off + 8)
    const end = off + 12 + len
    if (len > bytes.length || end > bytes.length) bad()
    const crc = bytes.readUInt32BE(off + 8 + len)
    if (zlib.crc32(bytes.subarray(off + 4, off + 8 + len)) !== crc) bad()
    const data = bytes.subarray(off + 8, off + 8 + len)
    if (off === 8) {
      if (type !== 'IHDR' || len !== 13) bad()
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const [depth, ct, comp, filter, interlace] = [data[8], data[9], data[10], data[11], data[12]]
      if (width < 1 || height < 1) bad()
      if (width > MAX_SIGNATURE_WIDTH || height > MAX_SIGNATURE_HEIGHT)
        throw new WorkflowError(`서명 이미지 크기가 너무 큽니다 (최대 ${MAX_SIGNATURE_WIDTH}x${MAX_SIGNATURE_HEIGHT}).`)
      if (depth !== 8 || ![0, 2, 3, 4, 6].includes(ct) || comp !== 0 || filter !== 0 || interlace !== 0) bad()
      colorType = ct
    } else if (type === 'PLTE') {
      if (idat.length) bad()
      sawPlte = true
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      sawEnd = true
      break
    }
    off = end
  }
  if (colorType < 0 || !sawEnd || idat.length === 0 || (colorType === 3 && !sawPlte)) bad()
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]
  const stride = 1 + width * channels
  const expected = height * stride
  let raw: Buffer
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected })
  } catch {
    return bad()
  }
  if (raw.length !== expected) bad()
  for (let y = 0; y < height; y++) if (raw[y * stride] > 4) bad()
}

export async function submitSignature(
  token: string,
  input: { signaturePng: string; values: Record<string, string>; consent: true },
  info: ClientInfo,
): Promise<{ completed: boolean }> {
  const signer = getSignerByToken(token)
  if (!signer) throw new WorkflowError('유효하지 않은 서명 링크입니다.', 404)
  if (input?.consent !== true) throw new WorkflowError('전자서명 동의가 필요합니다.')
  const png = await validateSignaturePng(input.signaturePng)
  const values = input.values && typeof input.values === 'object' ? input.values : {}

  const bundle = mustGetBundle(signer.document_id)
  const doc = bundle.document
  const check = turnCheck(doc, signer, bundle.signers)
  if (!check.canSign) throw new WorkflowError(check.reason ?? '서명할 수 없습니다.', 409)

  const today = kstDate()
  const updates: { id: string; value: string }[] = []
  for (const f of bundle.fields.filter((x) => x.signer_id === signer.id && x.type !== 'signature')) {
    const raw = values[f.id]
    let v = typeof raw === 'string' ? raw.replace(/[\r\n\t]+/g, ' ').trim() : ''
    if (v.length > MAX_VALUE_LEN) throw new WorkflowError('입력값이 너무 깁니다.')
    if (!v && f.type === 'date') v = today
    if (!v && f.type === 'name') v = signer.name
    if (!v) throw new WorkflowError(`'${f.label || '텍스트'}' 항목을 입력하세요.`)
    updates.push({ id: f.id, value: v })
  }

  const signedAt = nowIso()
  const allSigned = tx(() => {
    const d = db()
    // Re-check inside the transaction (guards double submits).
    const cur = d.prepare('SELECT status FROM signers WHERE id = ?').get(signer.id) as { status: string } | undefined
    const curDoc = d.prepare('SELECT status FROM documents WHERE id = ?').get(doc.id) as { status: string } | undefined
    if (!cur || cur.status === 'signed') throw new WorkflowError('이미 서명하셨습니다.', 409)
    if (!curDoc || curDoc.status !== 'sent') throw new WorkflowError('서명할 수 없는 문서 상태입니다.', 409)
    const upd = d.prepare('UPDATE fields SET value = ? WHERE id = ? AND signer_id = ?')
    for (const u of updates) upd.run(u.value, u.id, signer.id)
    d.prepare(
      "UPDATE signers SET status = 'signed', signature_png = ?, signed_at = ?, ip = ?, user_agent = ? WHERE id = ?",
    ).run(png, signedAt, info.ip, info.userAgent, signer.id)
    logEvent({
      document_id: doc.id,
      signer_id: signer.id,
      type: 'signed',
      ip: info.ip,
      user_agent: info.userAgent,
      detail: `${signer.name} <${signer.email}>`,
    })
    const left = d
      .prepare("SELECT COUNT(*) AS n FROM signers WHERE document_id = ? AND status != 'signed'")
      .get(doc.id) as { n: number }
    return Number(left.n) === 0
  })

  if (!allSigned) {
    const next = nextUnsigned(getSigners(doc.id))
    if (next) await notifySigner(mustGetDocument(doc.id), next, { emailOwner: true })
    return { completed: false }
  }
  // The signature is stored either way. If sealing fails, the document stays `sent` with every
  // signer signed; the owner is emailed and "알림 재발송" (resendNotification) retries sealing.
  const completed = await finalizeDocument(doc.id)
  return { completed }
}

// ---------------------------------------------------------------------------
// Sealing (one at a time per document) and completion emails
// ---------------------------------------------------------------------------

const lockState = globalThis as unknown as {
  __esignSealLocks?: Map<string, Promise<unknown>>
  __esignBackground?: Set<Promise<unknown>>
}
const sealLocks = (lockState.__esignSealLocks ??= new Map())
const background = (lockState.__esignBackground ??= new Set())

/** Runs `fn` after any in-flight sealing of the same document has finished (in-process lock). */
async function withSealLock<T>(documentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sealLocks.get(documentId) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  sealLocks.set(documentId, tail)
  try {
    return await run
  } finally {
    if (sealLocks.get(documentId) === tail) sealLocks.delete(documentId)
  }
}

/** True while a sealing run for this document is queued or in progress. */
export function isSealing(documentId: string): boolean {
  return sealLocks.has(documentId)
}

/** Tracks a fire-and-forget task so tests (and shutdown code) can wait for it. */
function runInBackground(label: string, task: Promise<unknown>): void {
  const p = task.catch((err) => console.error(`[workflow] background ${label} failed`, err))
  background.add(p)
  void p.finally(() => background.delete(p))
}

/** Resolves when all background tasks (completion emails) started so far have finished. */
export async function flushBackgroundTasks(): Promise<void> {
  while (background.size) await Promise.all([...background])
}

/**
 * Builds the sealed PDF, marks the document completed and starts the completion emails in the
 * background. Returns true when the document is completed (now or already).
 * On sealing failure: logs, emails the owner (once per failure) and returns false, or throws a
 * WorkflowError(500) when `throwOnFailure` (admin retry).
 */
async function finalizeDocument(documentId: string, opts: { throwOnFailure?: boolean } = {}): Promise<boolean> {
  return withSealLock(documentId, async () => {
    const bundle = getBundle(documentId)
    if (!bundle) return false
    if (bundle.document.status === 'completed') return true
    if (bundle.document.status !== 'sent') return false
    if (bundle.signers.some((s) => s.status !== 'signed')) return false
    const completedAt = nowIso()
    const forSeal: DocumentBundle = {
      ...bundle,
      document: { ...bundle.document, status: 'completed', completed_at: completedAt },
    }
    let bytes: Uint8Array
    try {
      bytes = await buildSealedPdf(forSeal)
    } catch (err) {
      console.error('[workflow] sealing failed for', documentId, err)
      const to = ownerEmail(bundle.signers)
      if (to) {
        runInBackground(
          'seal-failed email',
          sendMail({ to, ...sealFailedEmail(bundle.document, adminLink(documentId)) }).then((r) => {
            if (!r.ok) console.error('[workflow] seal-failed email not sent:', r.error)
          }),
        )
      }
      if (opts.throwOnFailure)
        throw new WorkflowError('최종 PDF 생성에 다시 실패했습니다. 서버 로그를 확인하세요.', 500)
      return false
    }
    const hash = sha256(bytes)
    const finalPath = signedPdfPath(documentId)
    fs.mkdirSync(docDir(documentId), { recursive: true })
    const tmp = `${finalPath}.${crypto.randomUUID()}.tmp`
    await fs.promises.writeFile(tmp, bytes)

    // From here on everything is synchronous: re-check status, rename, then record the hash.
    // No other request can run in between, so the file on disk and signed_sha256 always match.
    const cur = getDocument(documentId)
    if (!cur || cur.status !== 'sent') {
      fs.rmSync(tmp, { force: true })
      return cur?.status === 'completed'
    }
    fs.renameSync(tmp, finalPath)
    const done = tx(() => {
      const r = db()
        .prepare(
          "UPDATE documents SET status = 'completed', signed_sha256 = ?, completed_at = ? WHERE id = ? AND status = 'sent'",
        )
        .run(hash, completedAt, documentId)
      if (Number(r.changes) !== 1) return false
      logEvent({ document_id: documentId, type: 'completed', detail: `서명본 SHA-256 ${hash}` })
      return true
    })
    if (!done) return false

    // The signer's request returns now; emails go out in the background (failures are logged as events).
    runInBackground('completion emails', sendCompletionEmails(documentId, 'completed', bytes))
    return true
  })
}

/** Emails the sealed PDF + a download link to every signer. Each result is logged as an event. */
async function sendCompletionEmails(
  documentId: string,
  reason: 'completed' | 'resend',
  sealed?: Uint8Array,
): Promise<Notified[]> {
  const doc = mustGetDocument(documentId)
  if (doc.status !== 'completed') throw new WorkflowError('완료된 문서가 아닙니다.', 409)
  let bytes: Uint8Array
  try {
    bytes = sealed ?? (await fs.promises.readFile(signedPdfPath(documentId)))
  } catch {
    throw new WorkflowError('서명 완료본 파일을 찾을 수 없습니다.', 500)
  }
  const attachment = { filename: safeFilename(doc.title), content: Buffer.from(bytes) }
  const out: Notified[] = []
  for (const s of getSigners(documentId)) {
    const link = downloadLink(s.token)
    const r = await sendMail({ to: s.email, ...completedEmail(doc, s, link), attachments: [attachment] })
    const what = reason === 'resend' ? '완료본 재발송' : '완료본'
    // The document may have been deleted meanwhile; then there is nothing to log into.
    if (getDocument(documentId)) {
      logEvent({
        document_id: documentId,
        signer_id: s.id,
        type: r.ok ? 'email_sent' : 'email_failed',
        detail: r.ok ? `${what} → ${s.email}` : `${what} → ${s.email}: ${r.error ?? 'unknown error'}`,
      })
    }
    out.push({ signerId: s.id, link, emailed: r.ok })
  }
  return out
}

// ---------------------------------------------------------------------------
// Admin actions
// ---------------------------------------------------------------------------

export function voidDocument(documentId: string): void {
  const doc = mustGetDocument(documentId)
  if (doc.status === 'completed') throw new WorkflowError('완료된 문서는 무효 처리할 수 없습니다.', 409)
  if (doc.status === 'voided') return
  tx(() => {
    db().prepare("UPDATE documents SET status = 'voided' WHERE id = ?").run(documentId)
    logEvent({ document_id: documentId, type: 'voided' })
  })
}

/** Allowed for draft, voided and completed documents. A document in progress must be voided first. */
export function deleteDocument(documentId: string): void {
  const doc = mustGetDocument(documentId)
  if (doc.status === 'sent')
    throw new WorkflowError('진행 중인 문서는 삭제할 수 없습니다. 먼저 무효 처리한 뒤 삭제하세요.', 409)
  if (isSealing(documentId))
    throw new WorkflowError('최종 PDF를 만드는 중입니다. 잠시 후 다시 시도하세요.', 409)
  tx(() => {
    db().prepare('DELETE FROM documents WHERE id = ?').run(documentId)
  })
  fs.rmSync(docDir(documentId), { recursive: true, force: true })
}
