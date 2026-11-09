import { PDFDocument, type PDFPage } from 'pdf-lib'

export const MAX_PDF_BYTES = 20 * 1024 * 1024

export class PdfValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfValidationError'
  }
}

/**
 * Validates an uploaded PDF: size, `%PDF-` magic, parses with pdf-lib, rejects encrypted files.
 * Returns the page count. Throws PdfValidationError with a Korean user-facing message.
 */
export async function validatePdf(bytes: Uint8Array): Promise<{ pageCount: number }> {
  if (!bytes || bytes.length === 0) throw new PdfValidationError('빈 파일입니다.')
  if (bytes.length > MAX_PDF_BYTES) throw new PdfValidationError('PDF 파일은 20MB 이하여야 합니다.')
  // Magic must appear at the very start (allow a few leading junk bytes like a BOM, as some tools do).
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1')
  const at = head.indexOf('%PDF-')
  if (at < 0 || at > 8) throw new PdfValidationError('PDF 파일이 아닙니다.')
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (/encrypt/i.test(msg)) throw new PdfValidationError('암호화된 PDF는 지원하지 않습니다.')
    throw new PdfValidationError('PDF 파일을 읽을 수 없습니다.')
  }
  if (doc.isEncrypted) throw new PdfValidationError('암호화된 PDF는 지원하지 않습니다.')
  const pageCount = doc.getPageCount()
  if (pageCount < 1) throw new PdfValidationError('페이지가 없는 PDF입니다.')
  return { pageCount }
}

/** Page rotation normalized to 0 | 90 | 180 | 270 (clockwise, as displayed). */
export function pageRotation(page: PDFPage): 0 | 90 | 180 | 270 {
  const a = page.getRotation().angle
  const r = (((Math.round(a / 90) * 90) % 360) + 360) % 360
  return r as 0 | 90 | 180 | 270
}

/**
 * A field box expressed in PDF user space, ready for drawing upright content as seen by the viewer.
 *
 * Normalized coordinates (0..1, origin top-left) are relative to the page *as displayed*
 * (crop box, with /Rotate applied — which is what pdf.js renders in the browser).
 * `origin` is the PDF-space point of the box's visual bottom-left corner. Local axes:
 * visual "right" = (cos θ, sin θ), visual "up" = (-sin θ, cos θ), θ = rotation.
 * Draw with pdf-lib `rotate: degrees(rotation)` anchored at `toPdf(dx, dy)`.
 */
export interface FieldFrame {
  originX: number
  originY: number
  width: number // points, along visual "right"
  height: number // points, along visual "up"
  rotation: 0 | 90 | 180 | 270
  /** PDF-space point for a local offset (dx right, dy up) from the box's visual bottom-left. */
  toPdf(dx: number, dy: number): { x: number; y: number }
}

type Box = { x: number; y: number; width: number; height: number }

/** Rect with non-negative width/height (PDF allows any two opposite corners). */
function normalizeBox(b: Box): Box {
  const x1 = Math.min(b.x, b.x + b.width)
  const x2 = Math.max(b.x, b.x + b.width)
  const y1 = Math.min(b.y, b.y + b.height)
  const y2 = Math.max(b.y, b.y + b.height)
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

/**
 * The page area pdf.js renders: CropBox ∩ MediaBox (both normalized), falling back to the
 * MediaBox when the intersection is empty — same rule as pdf.js `Page.view`.
 */
export function visibleBox(page: PDFPage): Box {
  const media = normalizeBox(page.getMediaBox())
  const crop = normalizeBox(page.getCropBox())
  const x1 = Math.max(media.x, crop.x)
  const y1 = Math.max(media.y, crop.y)
  const x2 = Math.min(media.x + media.width, crop.x + crop.width)
  const y2 = Math.min(media.y + media.height, crop.y + crop.height)
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return media
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

/** Converts a point given in displayed-page points (u from left, v from top) to PDF user space. */
export function displayToPdf(page: PDFPage, u: number, v: number): { x: number; y: number } {
  const crop = visibleBox(page)
  const r = pageRotation(page)
  const { x: cx, y: cy, width: cw, height: ch } = crop
  switch (r) {
    case 0:
      return { x: cx + u, y: cy + ch - v }
    case 90:
      return { x: cx + v, y: cy + u }
    case 180:
      return { x: cx + cw - u, y: cy + v }
    case 270:
      return { x: cx + cw - v, y: cy + ch - u }
  }
}

/** Displayed page size in points (width/height swap for 90/270). */
export function displaySize(page: PDFPage): { width: number; height: number } {
  const { width, height } = visibleBox(page)
  const r = pageRotation(page)
  return r === 90 || r === 270 ? { width: height, height: width } : { width, height }
}

export function fieldFrame(page: PDFPage, box: { x: number; y: number; w: number; h: number }): FieldFrame {
  const disp = displaySize(page)
  const rotation = pageRotation(page)
  const width = box.w * disp.width
  const height = box.h * disp.height
  const u0 = box.x * disp.width
  const vBottom = (box.y + box.h) * disp.height
  const origin = displayToPdf(page, u0, vBottom)
  const rad = (rotation * Math.PI) / 180
  const cos = Math.round(Math.cos(rad))
  const sin = Math.round(Math.sin(rad))
  return {
    originX: origin.x,
    originY: origin.y,
    width,
    height,
    rotation,
    toPdf(dx: number, dy: number) {
      return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos }
    },
  }
}
