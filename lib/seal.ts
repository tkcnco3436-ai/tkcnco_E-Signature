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
  created: '생성',
  sent: '발송',
  email_sent: '메일 발송',
  email_failed: '메일 실패',
  viewed: '열람',
  signed: '서명',
  completed: '완료',
  voided: '무효',
  otp_sent: '인증번호 발송',
  otp_verified: '본인 확인',
  otp_failed: '인증 실패',
  timestamped: '타임스탬프',
  timestamp_failed: '타임스탬프 실패',
}

// Compact audit certificate. Korean labels only, small type, two-column document info,
// one block per signer. Fits on one A4 page for typical contracts (≈6 signers / 40 events);
// paginates automatically beyond that.
const A4: [number, number] = [595.28, 841.89]
const M = 36 // margin
const INK = rgb(0.1, 0.1, 0.12)
const MUTED = rgb(0.42, 0.45, 0.5)
const RULE = rgb(0.82, 0.84, 0.87)
const BODY = 7.5 // body text size
const LH = 10 // body line height

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
    if (this.y - h < M + 12) this.newPage()
  }

  text(s: string, x: number, size: number, color = INK) {
    this.page.drawText(s, { x, y: this.y - size, size, font: this.font, color })
  }

  rule(thickness = 0.4) {
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + this.width, y: this.y }, thickness, color: RULE })
  }

  heading(title: string) {
    this.ensure(28)
    this.y -= 8
    this.text(title, M, 9.5)
    this.y -= 13
    this.rule(0.7)
    this.y -= 4
  }

  /** One label/value cell with wrapped value. Returns the height used. Does not move the cursor. */
  cell(label: string, value: string, x: number, labelW: number, valueW: number): number {
    const lines = wrap(this.font, value || '-', BODY, valueW)
    this.page.drawText(label, { x, y: this.y - BODY, size: BODY, font: this.font, color: MUTED })
    lines.forEach((l, i) => {
      this.page.drawText(l, { x: x + labelW, y: this.y - BODY - i * LH, size: BODY, font: this.font, color: INK })
    })
    return lines.length * LH
  }

  /** Rows of up to two label/value pairs side by side. A pair with `full` spans the whole width. */
  grid(rows: ([string, string] | [string, string, 'full'])[]) {
    const labelW = 52
    const colW = this.width / 2
    let i = 0
    while (i < rows.length) {
      const a = rows[i]
      const b = rows[i + 1]
      if (a[2] === 'full' || !b || b[2] === 'full') {
        const h = wrap(this.font, a[1] || '-', BODY, this.width - labelW).length * LH
        this.ensure(h + 2)
        this.cell(a[0], a[1], M, labelW, this.width - labelW)
        this.y -= h + 2
        i += 1
      } else {
        const valueW = colW - labelW - 8
        const h = Math.max(
          wrap(this.font, a[1] || '-', BODY, valueW).length,
          wrap(this.font, b[1] || '-', BODY, valueW).length,
        ) * LH
        this.ensure(h + 2)
        this.cell(a[0], a[1], M, labelW, valueW)
        this.cell(b[0], b[1], M + colW, labelW, valueW)
        this.y -= h + 2
        i += 2
      }
    }
  }

  footer(docId: string) {
    const total = this.pages.length
    this.pages.forEach((p, i) => {
      const s = `전자서명 감사 증명서 · ${docId} · ${i + 1}/${total}`
      p.drawText(s, { x: M, y: M - 16, size: 6.5, font: this.font, color: MUTED })
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

  // Title line
  w.text('전자서명 감사 증명서', M, 15)
  const tw = font.widthOfTextAtSize('전자서명 감사 증명서', 15)
  w.text('Audit Trail', M + tw + 8, 8, MUTED)
  w.y -= 22

  w.heading('문서 정보')
  w.grid([
    ['문서 제목', d.title, 'full'],
    ['문서 ID', d.id],
    ['원본 페이지', `${d.page_count}쪽`],
    ['원본 SHA-256', d.original_sha256, 'full'],
    ['생성', kstDateTime(d.created_at)],
    ['발송', kstDateTime(d.sent_at)],
    ['완료', kstDateTime(d.completed_at)],
    ['서명자 수', `${signers.length}명`],
  ])

  w.heading('서명자')
  const thumbW = 96
  const thumbH = 36
  const labelW = 52
  const innerW = w.width - thumbW - 10
  const colW = innerW / 2
  for (const s of signers) {
    const nameLine = `${s.order_index + 1}. ${s.name}${s.is_owner ? ' (발신자)' : ''}`
    const uaLines = wrap(font, s.user_agent ?? '-', BODY, innerW - labelW)
    const blockH = Math.max(LH * 3 + uaLines.length * LH + 4, thumbH + 4)
    w.ensure(blockH + 6)
    const top = w.y
    // signature thumbnail (right)
    const tx = M + w.width - thumbW
    const ty = top - thumbH - 1
    w.page.drawRectangle({ x: tx, y: ty, width: thumbW, height: thumbH, borderColor: RULE, borderWidth: 0.6 })
    const img = sigImages.get(s.id)
    if (img) {
      const sc = Math.min((thumbW - 6) / img.width, (thumbH - 6) / img.height)
      const iw = img.width * sc
      const ih = img.height * sc
      w.page.drawImage(img, { x: tx + (thumbW - iw) / 2, y: ty + (thumbH - ih) / 2, width: iw, height: ih })
    }
    w.text(nameLine, M, 8.5)
    w.y -= LH + 2
    w.cell('이메일', s.email, M, labelW, colW - labelW - 6)
    w.cell('서명 시각', kstDateTime(s.signed_at), M + colW, labelW, colW - labelW - 6)
    w.y -= LH
    w.cell('IP 주소', s.ip ?? '-', M, labelW, colW - labelW - 6)
    w.y -= LH
    w.cell('브라우저', s.user_agent ?? '-', M, labelW, innerW - labelW)
    w.y -= uaLines.length * LH
    w.y = Math.min(w.y, top - thumbH - 2) - 4
    w.rule()
    w.y -= 5
  }

  w.heading('이벤트 기록')
  const cols = [
    { title: '시각 (KST)', w: 92 },
    { title: '이벤트', w: 50 },
    { title: '서명자', w: 80 },
    { title: 'IP', w: 88 },
    { title: '상세', w: w.width - 92 - 50 - 80 - 88 },
  ]
  const drawHeader = () => {
    w.ensure(LH + 3)
    let x = M
    for (const c of cols) {
      w.text(c.title, x, BODY, MUTED)
      x += c.w
    }
    w.y -= LH + 2
  }
  drawHeader()
  const signerName = new Map(signers.map((s) => [s.id, s.name]))
  for (const e of events) {
    // Details already shown elsewhere on the page are dropped to keep rows on one line.
    const detail = e.type === 'created' || e.type === 'signed' || e.type === 'viewed' ? '' : (e.detail ?? '')
    const cells = [
      kstDateTime(e.at).replace(' KST', ''),
      EVENT_LABEL[e.type] ?? e.type,
      e.signer_id ? (signerName.get(e.signer_id) ?? '-') : '-',
      e.ip ?? '-',
      detail,
    ].map((v, i) => wrap(font, v, BODY, cols[i].w - 5))
    const rowH = Math.max(...cells.map((c) => c.length)) * LH + 1
    if (w.y - rowH < M + 12) {
      w.newPage()
      drawHeader()
    }
    let x = M
    const top = w.y
    cells.forEach((lines, i) => {
      let yy = top
      for (const l of lines) {
        w.page.drawText(l, { x, y: yy - BODY, size: BODY, font, color: INK })
        yy -= LH
      }
      x += cols[i].w
    })
    w.y = top - rowH
  }
  w.y -= 2
  w.rule()

  // Integrity note (single Korean paragraph)
  w.y -= 8
  const note =
    '무결성: 이 문서는 모든 서명 완료 후 원본 페이지·서명 값·본 증명서 전체를 PAdES 전자서명(SHA-256)으로 봉인했습니다. 봉인 후 한 바이트라도 바뀌면 PDF 뷰어의 서명 검증이 실패합니다. 최종 파일의 SHA-256은 서버에 기록됩니다.'
  for (const l of wrap(font, note, 7, w.width)) {
    w.ensure(10)
    w.text(l, M, 7, MUTED)
    w.y -= 9.5
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
