import 'server-only'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import forge from 'node-forge'
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib'
import { P12Signer } from '@signpdf/signer-p12'
import { SignPdf } from '@signpdf/signpdf'
import { DATA_DIR, originalPdfPath } from './db'
import { fieldFrame } from './pdf'
import { kstDateTime } from './time'
import type { DocumentBundle, EventType, SignerRow } from './types'

// ---------------------------------------------------------------------------
// Font (Noto Sans KR Regular, static TTF, SIL OFL 1.1 — see assets/fonts/OFL.txt)
// ---------------------------------------------------------------------------

export const FONT_PATH = path.join(process.cwd(), 'assets', 'fonts', 'NotoSansKR-Regular.ttf')
let fontBytes: Uint8Array | undefined

function loadFontBytes(): Uint8Array {
  if (!fontBytes) {
    if (!fs.existsSync(FONT_PATH)) throw new Error(`Korean font not found at ${FONT_PATH}`)
    fontBytes = new Uint8Array(fs.readFileSync(FONT_PATH))
  }
  return fontBytes
}

// Font embedding options, verified by rendering the sealed PDF with pdf.js:
// - subset OFF: @pdf-lib/fontkit 1.1.1 subsetting corrupts ~half the glyphs of this font (most Latin
//   letters and many Hangul syllables render blank). Full embed adds ~3 MB (flate-compressed) per PDF.
// - locl/calt off: fontkit applies them inconsistently for this font (digits in Latin runs and
//   spaces in Hangul runs get alternate glyphs that pdf-lib mis-maps -> wrong widths/ToUnicode).
const FONT_SUBSET = false
const FONT_FEATURES = { locl: false, calt: false }

// ---------------------------------------------------------------------------
// Self-signed certificate for the PAdES signature (generated on first use)
// ---------------------------------------------------------------------------

export const CERT_PATH = path.join(DATA_DIR, 'cert.p12')
export const CERT_PASS_PATH = path.join(DATA_DIR, 'cert.pass')

export function ensureCertificate(): { p12: Buffer; passphrase: string } {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(CERT_PASS_PATH)) {
    return { p12: fs.readFileSync(CERT_PATH), passphrase: fs.readFileSync(CERT_PASS_PATH, 'utf8').trim() }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const key = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString())
  const pub = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString())

  const cert = forge.pki.createCertificate()
  cert.publicKey = pub
  cert.serialNumber = '01' + crypto.randomBytes(15).toString('hex')
  const now = new Date()
  cert.validity.notBefore = new Date(now.getTime() - 24 * 3600 * 1000)
  cert.validity.notAfter = new Date(now.getFullYear() + 20, now.getMonth(), now.getDate())
  const attrs = [
    { name: 'commonName', value: 'pdf-esign self-signed' },
    { name: 'organizationName', value: 'pdf-esign' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'subjectKeyIdentifier' },
  ])
  cert.sign(key, forge.md.sha256.create())

  const passphrase = crypto.randomBytes(24).toString('hex')
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], passphrase, {
    algorithm: '3des',
    friendlyName: 'pdf-esign',
  })
  const p12 = Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary')
  fs.writeFileSync(CERT_PATH, p12, { mode: 0o600 })
  fs.writeFileSync(CERT_PASS_PATH, passphrase, { mode: 0o600 })
  return { p12, passphrase }
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function pngBytesFromDataUrl(dataUrl: string): Uint8Array {
  const prefix = 'data:image/png;base64,'
  if (!dataUrl.startsWith(prefix)) throw new Error('signature is not a PNG data URL')
  return new Uint8Array(Buffer.from(dataUrl.slice(prefix.length), 'base64'))
}

/** Largest font size (<= max) at which `text` fits in width × height on one line. */
function fitFontSize(font: PDFFont, text: string, width: number, height: number, max = 14, min = 4): number {
  let size = Math.max(min, Math.min(max, height * 0.7))
  while (size > min && font.widthOfTextAtSize(text, size) > width) size -= 0.25
  return size
}

/** Truncate with an ellipsis so `text` fits `width` at `size`. */
function truncate(font: PDFFont, text: string, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text
  let t = text
  while (t.length > 0 && font.widthOfTextAtSize(t + '…', size) > width) t = t.slice(0, -1)
  return t + '…'
}

/** Character-level wrap (works for Korean and long tokens like user agents). */
function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const lines: string[] = []
  for (const para of text.split(/\r?\n/)) {
    let line = ''
    for (const ch of Array.from(para)) {
      if (line && font.widthOfTextAtSize(line + ch, size) > width) {
        // Prefer breaking at a recent space when there is one in the line.
        const sp = line.lastIndexOf(' ')
        if (sp > 0 && sp > line.length - 20) {
          lines.push(line.slice(0, sp))
          line = line.slice(sp + 1) + ch
        } else {
          lines.push(line)
          line = ch
        }
      } else line += ch
    }
    lines.push(line)
  }
  return lines
}

function stampImage(page: PDFPage, box: { x: number; y: number; w: number; h: number }, img: PDFImage) {
  const f = fieldFrame(page, box)
  const pad = Math.min(f.width, f.height) * 0.04
  const availW = Math.max(1, f.width - pad * 2)
  const availH = Math.max(1, f.height - pad * 2)
  const scale = Math.min(availW / img.width, availH / img.height)
  const w = img.width * scale
  const h = img.height * scale
  const at = f.toPdf((f.width - w) / 2, (f.height - h) / 2)
  page.drawImage(img, { x: at.x, y: at.y, width: w, height: h, rotate: degrees(f.rotation) })
}

function stampText(page: PDFPage, box: { x: number; y: number; w: number; h: number }, text: string, font: PDFFont) {
  const value = text.replace(/[\r\n]+/g, ' ').trim()
  if (!value) return
  const f = fieldFrame(page, box)
  const padX = Math.min(4, f.width * 0.05)
  const availW = Math.max(1, f.width - padX * 2)
  const size = fitFontSize(font, value, availW, f.height)
  const shown = truncate(font, value, size, availW)
  // Vertically centre using the font's ascent/descent at this size.
  const textH = font.heightAtSize(size, { descender: false })
  const descent = font.heightAtSize(size, { descender: true }) - textH
  const dy = (f.height - textH) / 2 + descent * 0.5
  const at = f.toPdf(padX, Math.max(0, dy))
  page.drawText(shown, { x: at.x, y: at.y, size, font, color: rgb(0.05, 0.05, 0.15), rotate: degrees(f.rotation) })
}

// ---------------------------------------------------------------------------
// Audit certificate
// ---------------------------------------------------------------------------

const EVENT_LABEL: Record<EventType, string> = {
  created: '생성 Created',
  sent: '발송 Sent',
  email_sent: '메일 발송 Email sent',
  email_failed: '메일 실패 Email failed',
  viewed: '열람 Viewed',
  signed: '서명 Signed',
  completed: '완료 Completed',
  voided: '무효 Voided',
}

const A4: [number, number] = [595.28, 841.89]
const M = 44 // margin
const INK = rgb(0.1, 0.1, 0.12)
const MUTED = rgb(0.42, 0.45, 0.5)
const RULE = rgb(0.82, 0.84, 0.87)

class AuditWriter {
  doc: PDFDocument
  font: PDFFont
  page: PDFPage
  y = 0
  pages: PDFPage[] = []

  constructor(doc: PDFDocument, font: PDFFont) {
    this.doc = doc
    this.font = font
    this.page = this.addPage()
  }

  get width() {
    return A4[0] - M * 2
  }

  private addPage(): PDFPage {
    const p = this.doc.addPage(A4)
    this.pages.push(p)
    this.y = A4[1] - M
    return p
  }

  newPage() {
    this.page = this.addPage()
  }

  ensure(h: number) {
    if (this.y - h < M + 14) this.newPage()
  }

  text(s: string, x: number, size: number, color = INK) {
    this.page.drawText(s, { x, y: this.y - size, size, font: this.font, color })
  }

  heading(ko: string, en: string) {
    this.ensure(40)
    this.y -= 10
    this.text(ko, M, 12)
    const w = this.font.widthOfTextAtSize(ko, 12)
    this.text(en, M + w + 6, 9, MUTED)
    this.y -= 18
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + this.width, y: this.y }, thickness: 0.7, color: RULE })
    this.y -= 6
  }

  /** Label/value rows with wrapped values; returns nothing, advances the cursor. */
  rows(rows: [string, string][], labelW: number, size: number, valueW: number) {
    const lh = size * 1.45
    for (const [label, value] of rows) {
      const lines = wrap(this.font, value || '-', size, valueW)
      this.ensure(lines.length * lh + 2)
      this.text(label, M, size, MUTED)
      for (const l of lines) {
        this.text(l, M + labelW, size)
        this.y -= lh
      }
      this.y -= 2
    }
  }

  measureRows(rows: [string, string][], size: number, valueW: number): number {
    let h = 0
    for (const [, v] of rows) h += wrap(this.font, v || '-', size, valueW).length * size * 1.45 + 2
    return h
  }

  footer(docId: string) {
    const total = this.pages.length
    this.pages.forEach((p, i) => {
      const s = `pdf-esign · Audit Certificate · ${docId} · ${i + 1}/${total}`
      p.drawText(s, { x: M, y: M - 18, size: 7, font: this.font, color: MUTED })
    })
  }
}

function drawAuditCertificate(
  out: PDFDocument,
  font: PDFFont,
  bundle: DocumentBundle,
  sigImages: Map<string, PDFImage>,
): PDFPage {
  const { document: d, signers, events } = bundle
  const w = new AuditWriter(out, font)

  // Title
  w.text('전자서명 감사 증명서', M, 20)
  w.y -= 26
  w.text('Certificate of Completion / Audit Trail', M, 10, MUTED)
  w.y -= 22

  w.heading('문서 정보', 'Document')
  w.rows(
    [
      ['문서 제목 / Title', d.title],
      ['문서 ID / Document ID', d.id],
      ['원본 SHA-256 / Original hash', d.original_sha256],
      ['원본 페이지 수 / Pages', String(d.page_count)],
      ['생성 / Created', kstDateTime(d.created_at)],
      ['발송 / Sent', kstDateTime(d.sent_at)],
      ['완료 / Completed', kstDateTime(d.completed_at)],
      ['상태 / Status', d.status],
    ],
    150,
    9,
    w.width - 150,
  )

  w.heading('서명자', 'Signers')
  const thumbW = 120
  const thumbH = 48
  const labelW = 110
  const valueW = w.width - labelW - thumbW - 12
  for (const s of signers) {
    const srows: [string, string][] = [
      ['이름 / Name', `${s.name}${s.is_owner ? '  (발신자 / Owner)' : ''}`],
      ['이메일 / Email', s.email],
      ['순서 / Order', String(s.order_index + 1)],
      ['서명 시각 / Signed at', kstDateTime(s.signed_at)],
      ['IP 주소 / IP', s.ip ?? '-'],
      ['브라우저 / User agent', s.user_agent ?? '-'],
    ]
    const size = 8.5
    w.ensure(Math.max(w.measureRows(srows, size, valueW), thumbH) + 12)
    const top = w.y
    // Signature thumbnail on the right
    const tx = M + w.width - thumbW
    const ty = top - thumbH
    w.page.drawRectangle({ x: tx, y: ty, width: thumbW, height: thumbH, borderColor: RULE, borderWidth: 0.7 })
    const img = sigImages.get(s.id)
    if (img) {
      const sc = Math.min((thumbW - 8) / img.width, (thumbH - 8) / img.height)
      const iw = img.width * sc
      const ih = img.height * sc
      w.page.drawImage(img, { x: tx + (thumbW - iw) / 2, y: ty + (thumbH - ih) / 2, width: iw, height: ih })
    }
    w.rows(srows, labelW, size, valueW)
    w.y = Math.min(w.y, top - thumbH) - 6
    w.page.drawLine({ start: { x: M, y: w.y }, end: { x: M + w.width, y: w.y }, thickness: 0.4, color: RULE })
    w.y -= 6
  }

  w.heading('이벤트 기록', 'Event log')
  const cols = [
    { title: '시각 (KST) / Time', w: 118 },
    { title: '이벤트 / Event', w: 92 },
    { title: '서명자 / Signer', w: 80 },
    { title: 'IP', w: 80 },
    { title: '상세 / Detail', w: w.width - 118 - 92 - 80 - 80 },
  ]
  const size = 7.5
  const lh = size * 1.4
  const drawHeader = () => {
    w.ensure(lh + 4)
    let x = M
    for (const c of cols) {
      w.text(c.title, x, size, MUTED)
      x += c.w
    }
    w.y -= lh + 3
  }
  drawHeader()
  const signerName = new Map(signers.map((s) => [s.id, s.name]))
  for (const e of events) {
    const cells = [
      kstDateTime(e.at).replace(' KST', ''),
      EVENT_LABEL[e.type] ?? e.type,
      e.signer_id ? (signerName.get(e.signer_id) ?? '-') : '-',
      e.ip ?? '-',
      e.detail ?? '',
    ].map((v, i) => wrap(font, v, size, cols[i].w - 6))
    const rowH = Math.max(...cells.map((c) => c.length)) * lh + 3
    if (w.y - rowH < M + 14) {
      w.newPage()
      drawHeader()
    }
    let x = M
    const top = w.y
    cells.forEach((lines, i) => {
      let yy = top
      for (const l of lines) {
        w.page.drawText(l, { x, y: yy - size, size, font, color: INK })
        yy -= lh
      }
      x += cols[i].w
    })
    w.y = top - rowH
    w.page.drawLine({ start: { x: M, y: w.y + 1 }, end: { x: M + w.width, y: w.y + 1 }, thickness: 0.3, color: RULE })
  }

  w.heading('무결성', 'Integrity')
  const statement = [
    '이 문서는 모든 서명자의 서명 완료 후 생성되었으며, 원본 페이지와 서명 값, 본 감사 증명서 전체가 PAdES 전자서명(자체 서명 인증서 "pdf-esign self-signed", SHA-256)으로 봉인되어 있습니다. 봉인 이후 내용이 한 바이트라도 변경되면 PDF 뷰어의 서명 검증이 실패합니다. 최종 파일의 SHA-256 해시는 서버에 기록됩니다.',
    'This document was sealed after all signers completed. The original pages, the stamped values and this certificate are covered by an embedded PAdES digital signature (self-signed certificate "pdf-esign self-signed", SHA-256); any modification after sealing invalidates the signature in PDF viewers. The SHA-256 hash of the final file is recorded on the server.',
  ]
  for (const para of statement) {
    for (const l of wrap(font, para, 8.5, w.width)) {
      w.ensure(13)
      w.text(l, M, 8.5)
      w.y -= 12.5
    }
    w.y -= 6
  }

  w.footer(d.id)
  return w.pages[w.pages.length - 1]
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Builds the final sealed PDF: original pages + stamped field values + audit certificate page(s),
 * signed with a PAdES (adbe.pkcs7.detached) signature. Throws if any step (incl. signing) fails.
 */
export async function buildSealedPdf(bundle: DocumentBundle): Promise<Uint8Array> {
  const original = fs.readFileSync(originalPdfPath(bundle.document.id))
  const pdf = await PDFDocument.load(original, { updateMetadata: false })
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(loadFontBytes(), { subset: FONT_SUBSET, features: FONT_FEATURES })

  const sigImages = new Map<string, PDFImage>()
  for (const s of bundle.signers) {
    if (s.signature_png) sigImages.set(s.id, await pdf.embedPng(pngBytesFromDataUrl(s.signature_png)))
  }
  const signerById = new Map<string, SignerRow>(bundle.signers.map((s) => [s.id, s]))

  const pages = pdf.getPages()
  for (const f of bundle.fields) {
    const page = pages[f.page - 1]
    if (!page) throw new Error(`field ${f.id} references missing page ${f.page}`)
    const signer = signerById.get(f.signer_id)
    if (f.type === 'signature') {
      const img = sigImages.get(f.signer_id)
      if (!img) throw new Error(`signer ${signer?.name ?? f.signer_id} has no signature image`)
      stampImage(page, f, img)
    } else {
      const v = f.value ?? (f.type === 'name' ? (signer?.name ?? '') : '')
      stampText(page, f, v, font)
    }
  }

  const lastPage = drawAuditCertificate(pdf, font, bundle, sigImages)

  pdf.setTitle(bundle.document.title)
  pdf.setProducer('pdf-esign')
  pdf.setModificationDate(new Date())

  const { p12, passphrase } = ensureCertificate()
  pdflibAddPlaceholder({
    pdfDoc: pdf,
    pdfPage: lastPage,
    reason: `Sealed after all signatures (document ${bundle.document.id})`,
    contactInfo: process.env.OWNER_EMAIL || '',
    name: 'pdf-esign self-signed',
    location: process.env.APP_URL || 'pdf-esign',
    signatureLength: 16384,
  })
  const withPlaceholder = await pdf.save({ useObjectStreams: false })
  const signer = new P12Signer(p12, { passphrase })
  const signed = await new SignPdf().sign(Buffer.from(withPlaceholder), signer)
  return new Uint8Array(signed)
}
