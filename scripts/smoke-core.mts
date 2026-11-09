// End-to-end smoke test of Module A (workflow + sealing) without HTTP.
// Run:  node --import ./scripts/ts-register.mjs --conditions=react-server scripts/smoke-core.mts
// (`--conditions=react-server` turns the `server-only` import into a no-op outside Next.)
// Set KEEP=1 to keep the temp data folder; OUT=<path> to copy the sealed PDF somewhere.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-smoke-'))
process.env.DATA_DIR = dataDir
process.env.APP_URL = 'https://esign.example.test'
delete process.env.RESEND_API_KEY
process.env.MAIL_DISABLED = '1' // never send real mail from tests
// RFC 3161: the main document is timestamped by the real TSA (TSA_URL, default DigiCert) unless
// SMOKE_TSA=0. A network failure there is tolerated (logged as timestamp_failed); later documents
// run with TSA_ENABLED=0, and TSA_REQUIRED is tested against an unreachable TSA.
process.env.TSA_ENABLED = process.env.SMOKE_TSA === '0' ? '0' : '1'
process.env.TSA_REQUIRED = '0'
delete process.env.TRUST_PROXY
delete process.env.SIGN_OTP
delete process.env.OTP_TEST_MODE

const { PDFDocument, StandardFonts, degrees, decodePDFRawStream, PDFRawStream, PDFName, PDFDict } = await import('pdf-lib')
const forge = (await import('node-forge')).default
const fontkit = (await import('@pdf-lib/fontkit')).default
const wf = await import('../lib/workflow.ts')
const dbm = await import('../lib/db.ts')

const log = (...a: unknown[]) => console.log('  ✓', ...a)
async function expectWorkflowError(p: Promise<unknown> | (() => unknown), status?: number) {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    assert.ok(e instanceof wf.WorkflowError, `expected WorkflowError, got ${String(e)}`)
    if (status) assert.equal(e.status, status)
    return e.message
  }
  assert.fail('expected WorkflowError')
}

// --- fixtures -------------------------------------------------------------
async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([595.28, 841.89])
  p1.drawText('Sample contract - page 1', { x: 50, y: 780, size: 18, font })
  const p2 = doc.addPage([595.28, 841.89])
  p2.drawText('Sample contract - page 2 (rotated 90)', { x: 50, y: 780, size: 18, font })
  p2.setRotation(degrees(90))
  return doc.save()
}

function crc32(buf: Buffer): number {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** WxH RGBA PNG with a blue scribble on a transparent background (default 300x100). */
function signaturePng(W = 300, H = 100, corruptIdat = false): string {
  const px = Buffer.alloc(W * H * 4)
  for (let x = 10; x < W - 10; x++) {
    const y = Math.round(50 + 30 * Math.sin(x / 18) * Math.cos(x / 47))
    for (let dy = -2; dy <= 2; dy++) {
      const i = ((y + dy) * W + x) * 4
      px[i] = 20
      px[i + 1] = 40
      px[i + 2] = 160
      px[i + 3] = 255
    }
  }
  const raw = Buffer.alloc((W * 4 + 1) * H)
  for (let y = 0; y < H; y++) px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', corruptIdat ? crypto.randomBytes(400) : zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return 'data:image/png;base64,' + png.toString('base64')
}

// --- PAdES verification (manual: forge has no PKCS#7 verify) ---------------
function verifyPades(pdf: Buffer) {
  const s = pdf.toString('latin1')
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(s)
  assert.ok(m, 'no /ByteRange')
  const [a, b, c, d] = m.slice(1).map(Number)
  assert.equal(a, 0)
  assert.equal(c + d, pdf.length, 'ByteRange must cover the whole file')
  const contentsHex = s.slice(b + 1, c - 1) // strip < >
  const signed = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)])
  const der = Buffer.from(contentsHex.replace(/(00)+$/, ''), 'hex')
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(der.toString('binary')), { strict: false })
  const p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData & {
    rawCapture: { authenticatedAttributes: forge.asn1.Asn1[]; signature: string }
  }
  const cert = p7.certificates[0]
  assert.equal(cert.subject.getField('CN').value, 'pdf-esign self-signed')
  const attrs = p7.rawCapture.authenticatedAttributes
  const mdOid = forge.pki.oids.messageDigest
  let md: string | undefined
  for (const attr of attrs) {
    const seq = attr.value as forge.asn1.Asn1[]
    if (forge.asn1.derToOid(seq[0].value as string) === mdOid) {
      md = ((seq[1].value as forge.asn1.Asn1[])[0].value as string)
    }
  }
  assert.ok(md, 'no messageDigest attribute')
  const digest = crypto.createHash('sha256').update(signed).digest()
  assert.equal(Buffer.from(md, 'binary').toString('hex'), digest.toString('hex'), 'messageDigest != SHA-256(ByteRange)')
  const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs)
  const setDer = Buffer.from(forge.asn1.toDer(set).getBytes(), 'binary')
  const pem = forge.pki.certificateToPem(cert)
  const ok = crypto.verify('sha256', setDer, pem, Buffer.from(p7.rawCapture.signature, 'binary'))
  assert.ok(ok, 'RSA signature over signed attributes does not verify')
  // Tamper check: flipping one byte inside the signed range must break the digest.
  const tampered = Buffer.from(signed)
  tampered[100] ^= 0xff
  assert.notEqual(crypto.createHash('sha256').update(tampered).digest('hex'), digest.toString('hex'))
}

// --- embedded font sanity: subset glyphs must have outlines -----------------
async function checkEmbeddedFont(pdfBytes: Uint8Array) {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false })
  let checked = 0
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue
    const ff = obj.lookup(PDFName.of('FontFile2'))
    if (!(ff instanceof PDFRawStream)) continue
    const bytes = decodePDFRawStream(ff).decode()
    const f = fontkit.create(Buffer.from(bytes)) as unknown as {
      numGlyphs: number
      getGlyph(id: number): { path: { commands: unknown[] } }
    }
    let withPath = 0
    for (let g = 1; g < f.numGlyphs; g++) {
      try {
        if (f.getGlyph(g).path.commands.length > 0) withPath++
      } catch {
        /* undecodable glyph counts as missing */
      }
    }
    assert.ok(f.numGlyphs > 50, `embedded font has only ${f.numGlyphs} glyphs`)
    assert.ok(withPath / (f.numGlyphs - 1) > 0.85, `only ${withPath}/${f.numGlyphs - 1} glyphs have outlines`)
    log(`embedded font: ${f.numGlyphs} glyphs, ${withPath} with outlines`)
    checked++
  }
  assert.ok(checked >= 1, 'no embedded TrueType font found')
}

// --- run --------------------------------------------------------------------
console.log(`smoke-core: DATA_DIR=${dataDir}`)
const pdfBytes = await samplePdf()
const sig = signaturePng()
const info = { ip: '203.0.113.7', userAgent: 'smoke-test/1.0 (Windows NT 10.0) Chrome/130' }

await expectWorkflowError(wf.createDocument({ title: 'x', pdf: new TextEncoder().encode('not a pdf') }), 400)
log('createDocument rejects non-PDF')

const doc = await wf.createDocument({ title: '용역 계약서 (smoke)', pdf: pdfBytes, message: '검토 후 서명 부탁드립니다.\n<script>x</script>' })
assert.equal(doc.page_count, 2)
assert.equal(doc.status, 'draft')
log('createDocument', doc.id)

const signers = [
  { name: '김태경', email: 'owner@example.com', is_owner: true, order_index: 0 },
  { name: '홍길동', email: 'hong@example.com', is_owner: false, order_index: 1 },
]
const fields = [
  { signer_ref: 0, page: 1, x: 0.1, y: 0.75, w: 0.3, h: 0.08, type: 'signature' as const },
  { signer_ref: 0, page: 1, x: 0.1, y: 0.84, w: 0.2, h: 0.03, type: 'date' as const, label: '날짜' },
  { signer_ref: 0, page: 1, x: 0.35, y: 0.84, w: 0.2, h: 0.03, type: 'name' as const },
  { signer_ref: 1, page: 1, x: 0.55, y: 0.75, w: 0.3, h: 0.08, type: 'signature' as const },
  { signer_ref: 1, page: 1, x: 0.55, y: 0.65, w: 0.35, h: 0.04, type: 'text' as const, label: '회사명' },
  { signer_ref: 1, page: 2, x: 0.6, y: 0.1, w: 0.3, h: 0.1, type: 'signature' as const },
  { signer_ref: 1, page: 2, x: 0.6, y: 0.22, w: 0.3, h: 0.04, type: 'name' as const },
]

await expectWorkflowError(() => wf.saveDraft(doc.id, { signers, fields: fields.filter((f) => f.signer_ref === 0) }))
log('saveDraft rejects signer without signature field')
await expectWorkflowError(() =>
  wf.saveDraft(doc.id, { signers: signers.map((s) => ({ ...s, is_owner: true })), fields }),
)
log('saveDraft rejects two owners')
await expectWorkflowError(() =>
  wf.saveDraft(doc.id, { signers: signers.map((s) => ({ ...s, order_index: 0 })), fields }),
)
log('saveDraft rejects duplicate order_index')
await expectWorkflowError(() =>
  wf.saveDraft(doc.id, { signers: [{ ...signers[0] }, { ...signers[1], email: 'bad@' }], fields }),
)
log('saveDraft rejects invalid email')

let bundle = wf.saveDraft(doc.id, { signers, fields })
assert.equal(bundle.signers.length, 2)
assert.equal(bundle.fields.length, 7)
// Saving again with ids keeps tokens stable.
const tokensBefore = bundle.signers.map((s) => s.token)
bundle = wf.saveDraft(doc.id, {
  title: '용역 계약서 (smoke)',
  signers: bundle.signers.map((s) => ({ id: s.id, name: s.name, email: s.email, is_owner: !!s.is_owner, order_index: s.order_index })),
  fields,
})
assert.deepEqual(bundle.signers.map((s) => s.token), tokensBefore)
log('saveDraft (twice, tokens stable)')

const [owner, ext] = bundle.signers
assert.equal(wf.signLink(owner.token), `https://esign.example.test/sign/${owner.token}`)

const sent = await wf.sendDocument(doc.id)
assert.equal(sent.notified.length, 1)
assert.equal(sent.notified[0].signerId, owner.id)
assert.equal(sent.notified[0].emailed, false)
await expectWorkflowError(wf.sendDocument(doc.id), 409)
log('sendDocument -> owner notified via link only')

await expectWorkflowError(() => wf.saveDraft(doc.id, { signers, fields }), 409)
log('saveDraft blocked after send')

const extView = wf.signerView(ext.token)
assert.ok(extView && !extView.canSign && extView.reason)
await expectWorkflowError(wf.submitSignature(ext.token, { signaturePng: sig, values: {}, consent: true }, info), 409)
log('external signer blocked until owner signs:', extView.reason)

assert.equal(wf.signerView('f'.repeat(64)), undefined)
const ownerView = wf.signerView(owner.token)
assert.ok(ownerView?.canSign)
wf.markViewed(owner.token, info)
wf.markViewed(owner.token, info) // second view: no duplicate event
assert.equal(dbm.getEvents(doc.id).filter((e) => e.type === 'viewed').length, 1)
log('signerView / markViewed')

await expectWorkflowError(
  wf.submitSignature(owner.token, { signaturePng: 'data:image/jpeg;base64,AAAA', values: {}, consent: true }, info),
)
await expectWorkflowError(
  wf.submitSignature(owner.token, { signaturePng: sig, values: {}, consent: false as unknown as true }, info),
)
log('submitSignature rejects bad PNG / missing consent')
assert.match(
  (await expectWorkflowError(wf.submitSignature(owner.token, { signaturePng: signaturePng(3200, 100), values: {}, consent: true }, info), 400))!,
  /크기/,
)
await expectWorkflowError(wf.submitSignature(owner.token, { signaturePng: signaturePng(300, 100, true), values: {}, consent: true }, info), 400)
assert.equal(dbm.getSigners(doc.id).find((s) => s.id === owner.id)!.status, 'viewed')
log('submitSignature rejects oversized (3200x100) and undecodable PNGs before saving')

const r1 = await wf.submitSignature(owner.token, { signaturePng: sig, values: {}, consent: true }, info)
assert.equal(r1.completed, false)
await expectWorkflowError(wf.submitSignature(owner.token, { signaturePng: sig, values: {}, consent: true }, info), 409)
const afterOwner = dbm.getBundle(doc.id)!
const ownerDate = afterOwner.fields.find((f) => f.signer_id === owner.id && f.type === 'date')!
assert.match(ownerDate.value ?? '', /^\d{4}-\d{2}-\d{2}$/)
assert.equal(afterOwner.fields.find((f) => f.signer_id === owner.id && f.type === 'name')!.value, '김태경')
assert.ok(afterOwner.events.some((e) => e.type === 'email_failed' && e.signer_id === ext.id))
log('owner signed (date auto-filled', ownerDate.value + '), next signer notified (email_failed logged, no key)')

const extFields = afterOwner.fields.filter((f) => f.signer_id === ext.id)
const textField = extFields.find((f) => f.type === 'text')!
await expectWorkflowError(wf.submitSignature(ext.token, { signaturePng: sig, values: {}, consent: true }, info))
log('external: required text field enforced')

const r2 = await wf.submitSignature(
  ext.token,
  { signaturePng: sig, values: { [textField.id]: '태경씨앤코 주식회사' }, consent: true },
  { ip: '198.51.100.23', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
)
assert.equal(r2.completed, true)
await wf.flushBackgroundTasks() // completion emails run in the background

const final = dbm.getBundle(doc.id)!
assert.equal(final.document.status, 'completed')
assert.ok(final.document.completed_at)
const signedFile = fs.readFileSync(dbm.signedPdfPath(doc.id))
assert.equal(final.document.signed_sha256, dbm.sha256(signedFile))
assert.equal(signedFile.subarray(0, 5).toString('latin1'), '%PDF-')
assert.ok(signedFile.includes('/ByteRange'), 'missing /ByteRange')
assert.ok(signedFile.includes('/adbe.pkcs7.detached'), 'missing SubFilter')
const reopened = await PDFDocument.load(signedFile, { updateMetadata: false })
// Audit certificate paginates (1+ pages) as the event log grows.
assert.ok(reopened.getPageCount() >= doc.page_count + 1, 'expected original pages + audit page(s)')
assert.ok(final.events.filter((e) => e.type === 'email_failed').length >= 3) // next-signer + 2 completion mails
log(`completed: ${signedFile.length} bytes, ${reopened.getPageCount()} pages, sha256 ${final.document.signed_sha256}`)

if (process.env.OUT) {
  fs.writeFileSync(process.env.OUT, signedFile)
  console.log('  sealed PDF copied to', process.env.OUT)
}

verifyPades(signedFile)
log('PAdES: ByteRange covers file, messageDigest matches, RSA signature verifies with embedded cert')
{
  const { verifySealed } = await import('./verify-sealed.mts')
  const report = verifySealed(signedFile)
  const evTypes = final.events.map((e) => e.type)
  if (final.document.timestamp_at) {
    assert.ok(report.timestamp, 'timestamp_at set but no token in the CMS')
    assert.equal(report.timestamp.genTime.toISOString(), final.document.timestamp_at)
    assert.equal(final.document.timestamp_tsa, process.env.TSA_URL || 'http://timestamp.digicert.com')
    assert.ok(evTypes.includes('timestamped') && !evTypes.includes('timestamp_failed'))
    log(`RFC 3161 timestamp ${final.document.timestamp_at} (token ${report.timestamp.tokenBytes} B, TSA ${report.timestamp.tsaSubject})`)
  } else {
    assert.equal(report.timestamp, null)
    assert.equal(final.document.timestamp_tsa, null)
    if (process.env.TSA_ENABLED === '1') {
      assert.ok(evTypes.includes('timestamp_failed'), 'TSA failure must be logged')
      console.log('  ! TSA unreachable, sealed without timestamp:', final.events.find((e) => e.type === 'timestamp_failed')?.detail)
    }
  }
}
process.env.TSA_ENABLED = '0' // no more network calls below

await checkEmbeddedFont(signedFile)

// Text extraction (checks Korean ToUnicode mapping) via pdfjs-dist.
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const loaded = await pdfjs.getDocument({ data: new Uint8Array(signedFile), isEvalSupported: false }).promise
const pageText = async (n: number) =>
  (await (await loaded.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join('')
const t1 = await pageText(1)
const t2 = await pageText(2)
const t3 = await pageText(3)
assert.ok(t1.includes('태경씨앤코 주식회사'), 'page 1 missing stamped Korean text: ' + t1)
assert.ok(t1.includes('김태경'), 'page 1 missing owner name')
assert.ok(t2.includes('홍길동'), 'page 2 (rotated) missing name')
for (const needle of ['전자서명 감사 증명서', doc.id, doc.original_sha256, '홍길동', 'hong@example.com', '198.51.100.23', 'PAdES'])
  assert.ok(t3.includes(needle), `audit page missing "${needle}"`)
log('text extraction: stamped Korean values + audit page content present')

// Session token + http helpers
const sess = await import('../lib/session.ts')
const http = await import('../lib/http.ts')
const secret = 'x'.repeat(40)
const tok = await sess.signSessionToken(secret)
assert.ok(await sess.verifySessionToken(secret, tok))
assert.ok(!(await sess.verifySessionToken('y'.repeat(40), tok)))
assert.ok(!(await sess.verifySessionToken(secret, tok.slice(0, -2) + (tok.endsWith('A') ? 'BB' : 'AA'))))
assert.ok(!(await sess.verifySessionToken(secret, await sess.signSessionToken(secret, Date.now() - 8 * 86400e3))))
const pwfA = await sess.passwordFingerprint(secret, 'password-one-123')
const pwfB = await sess.passwordFingerprint(secret, 'password-two-456')
assert.match(pwfA, /^[0-9a-f]{16}$/)
const tokA = await sess.signSessionToken(secret, Date.now(), pwfA)
assert.ok(await sess.verifySessionToken(secret, tokA, pwfA))
assert.ok(!(await sess.verifySessionToken(secret, tokA, pwfB)), 'password change must revoke session')
assert.ok(!(await sess.verifySessionToken(secret, tok, pwfA)), 'token without fingerprint must fail when one is required')
assert.ok(sess.adminPasswordProblem('short-pw'))
assert.equal(sess.adminPasswordProblem('long-enough-pw'), null)
const spoof = { 'x-forwarded-for': '1.2.3.4, 10.0.0.1', 'cf-connecting-ip': '9.9.9.9', 'x-real-ip': '8.8.8.8', 'user-agent': 'u'.repeat(400) }
const ci = http.clientInfo(new Request('http://x', { headers: spoof }))
assert.equal(ci.ip, null, 'TRUST_PROXY=none must ignore forwarding headers')
assert.equal(ci.userAgent?.length, 300)
assert.equal(http.rateKey(new Request('http://x', { headers: spoof })), 'local')
process.env.TRUST_PROXY = 'cloudflare'
assert.equal(http.clientInfo(new Request('http://x', { headers: spoof })).ip, '9.9.9.9')
assert.equal(http.clientInfo(new Request('http://x', { headers: { 'x-forwarded-for': '1.2.3.4' } })).ip, null)
assert.equal(http.clientInfo(new Request('http://x', { headers: { 'cf-connecting-ip': '<script>' } })).ip, null)
delete process.env.TRUST_PROXY
const post = (h: Record<string, string>) => new Request('http://esign.local/api/admin/x', { method: 'POST', headers: h })
assert.ok(http.csrfOk(post({ host: 'esign.local' })))
assert.ok(http.csrfOk(post({ host: 'esign.local', origin: 'http://esign.local' })))
assert.ok(http.csrfOk(post({ host: '127.0.0.1:3100', origin: 'https://esign.example.test' })), 'APP_URL origin allowed')
assert.ok(!http.csrfOk(post({ host: 'esign.local', origin: 'https://evil.example' })))
assert.ok(!http.csrfOk(post({ host: 'esign.local', origin: 'null' })))
assert.ok(http.csrfOk(new Request('http://esign.local/x', { headers: { host: 'esign.local', origin: 'https://evil.example' } })), 'GET not checked')
assert.deepEqual([1, 2].map(() => http.rateLimit('cnt', 5, 60_000)), [true, true])
assert.equal(http.rateCount('cnt'), 2)
assert.deepEqual([1, 2, 3].map(() => http.rateLimit('k', 2, 60_000)), [true, true, false])
log('session token sign/verify/tamper/expiry/password fingerprint, clientInfo/TRUST_PROXY, CSRF origin, rateLimit')

// Crop box: inverted rect normalized and intersected with the media box (pdf.js Page.view rule).
{
  const pdfm = await import('../lib/pdf.ts')
  const d = await PDFDocument.create()
  const p = d.addPage([600, 800])
  p.setCropBox(500, 700, -400, -600) // inverted: corners (500,700) and (100,100)
  assert.deepEqual(pdfm.visibleBox(p), { x: 100, y: 100, width: 400, height: 600 })
  p.setCropBox(-50, -50, 300, 2000) // sticks out of the media box
  assert.deepEqual(pdfm.visibleBox(p), { x: 0, y: 0, width: 250, height: 800 })
  p.setCropBox(1000, 1000, 10, 10) // no overlap -> media box
  assert.deepEqual(pdfm.visibleBox(p), { x: 0, y: 0, width: 600, height: 800 })
  log('visibleBox: crop box normalized + intersected with media box')
}

// Resend on a completed document re-sends the completion mail to every signer.
const resent = await wf.resendNotification(doc.id)
assert.equal(resent.length, 2)
assert.ok(resent.every((n) => n.link.includes('/api/sign/') && n.link.endsWith('/download')))
assert.ok(dbm.getEvents(doc.id).some((e) => e.detail?.startsWith('완료본 재발송')))
log('resendNotification(completed) -> completion mail to all signers with fresh download links')

// Owner signing second gets a "your turn" mail (admin link, no token).
{
  const d3 = await wf.createDocument({ title: 'owner second', pdf: pdfBytes })
  const b3 = wf.saveDraft(d3.id, {
    signers: [
      { name: '홍길동', email: 'hong@example.com', is_owner: false, order_index: 0 },
      { name: '김태경', email: 'owner@example.com', is_owner: true, order_index: 1 },
    ],
    fields: [
      { signer_ref: 0, page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.08, type: 'signature' },
      { signer_ref: 1, page: 1, x: 0.5, y: 0.1, w: 0.3, h: 0.08, type: 'signature' },
    ],
  })
  await wf.sendDocument(d3.id)
  await expectWorkflowError(() => wf.deleteDocument(d3.id), 409)
  log('deleteDocument refuses a sent document (409)')
  await wf.submitSignature(b3.signers[0].token, { signaturePng: sig, values: {}, consent: true }, info)
  // Approval line: the owner (2nd) gets the same sign-request email once signer 1 is done.
  const ev = dbm.getEvents(d3.id).find((e) => e.signer_id === b3.signers[1].id && e.detail?.includes('서명 요청 → owner@example.com'))
  assert.ok(ev, 'owner sign request missing')
  log('owner (2nd) gets sign-request email when their turn comes')
  // Concurrent finalize attempts: only one sealing, one completed event.
  const signing = wf.submitSignature(b3.signers[1].token, { signaturePng: sig, values: {}, consent: true }, info)
  while (dbm.getSigners(d3.id).some((s) => s.status !== 'signed')) await new Promise((r) => setImmediate(r))
  assert.ok(wf.isSealing(d3.id), 'seal lock should be held while sealing')
  await expectWorkflowError(() => wf.deleteDocument(d3.id), 409)
  const retry = wf.resendNotification(d3.id) // admin retry while the first sealing is running
  const [r3, again] = await Promise.all([signing, retry])
  await wf.flushBackgroundTasks()
  assert.equal(r3.completed, true)
  assert.deepEqual(again, [])
  assert.ok(!wf.isSealing(d3.id))
  assert.equal(dbm.getEvents(d3.id).filter((e) => e.type === 'completed').length, 1)
  assert.equal(dbm.getDocument(d3.id)!.signed_sha256, dbm.sha256(fs.readFileSync(dbm.signedPdfPath(d3.id))))
  assert.deepEqual(fs.readdirSync(dbm.docDir(d3.id)).filter((n) => n.endsWith('.tmp')), [])
  wf.deleteDocument(d3.id) // completed: allowed
  log('concurrent finalize: single completed event, hash matches file, no temp files; completed doc deletable')
}

// TSA_REQUIRED: an unreachable TSA makes sealing fail (document stays sent); the admin retry seals.
{
  Object.assign(process.env, { TSA_ENABLED: '1', TSA_REQUIRED: '1', TSA_URL: 'http://127.0.0.1:9/tsr' })
  const d4 = await wf.createDocument({ title: 'tsa required', pdf: pdfBytes })
  const b4 = wf.saveDraft(d4.id, {
    signers: [{ name: '김태경', email: 'owner@example.com', is_owner: true, order_index: 0 }],
    fields: [{ signer_ref: 0, page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.08, type: 'signature' }],
  })
  await wf.sendDocument(d4.id)
  const r4 = await wf.submitSignature(b4.signers[0].token, { signaturePng: sig, values: {}, consent: true }, info)
  await wf.flushBackgroundTasks()
  assert.equal(r4.completed, false)
  assert.equal(dbm.getDocument(d4.id)!.status, 'sent')
  assert.ok(!fs.existsSync(dbm.signedPdfPath(d4.id)))
  Object.assign(process.env, { TSA_ENABLED: '0', TSA_REQUIRED: '0' })
  delete process.env.TSA_URL
  assert.deepEqual(await wf.resendNotification(d4.id), [])
  await wf.flushBackgroundTasks()
  const done4 = dbm.getBundle(d4.id)!
  assert.equal(done4.document.status, 'completed')
  assert.equal(done4.document.timestamp_at, null)
  assert.ok(!done4.events.some((e) => e.type === 'timestamped' || e.type === 'timestamp_failed'))
  const { verifySealed } = await import('./verify-sealed.mts')
  assert.equal(verifySealed(fs.readFileSync(dbm.signedPdfPath(d4.id))).timestamp, null)
  log('TSA_REQUIRED + unreachable TSA -> sealing fails, stays sent; retry with TSA_ENABLED=0 seals without timestamp')
}

// Void/delete guards
await expectWorkflowError(() => wf.voidDocument(doc.id), 409)
const doc2 = await wf.createDocument({ title: 'to delete', pdf: pdfBytes })
wf.voidDocument(doc2.id)
assert.equal(dbm.getDocument(doc2.id)!.status, 'voided')
wf.deleteDocument(doc2.id)
assert.equal(dbm.getDocument(doc2.id), undefined)
assert.ok(!fs.existsSync(dbm.docDir(doc2.id)))
log('void/delete')

// Email OTP identity check
{
  const otp = await import('../lib/otp.ts')
  async function expectOtpError(p: Promise<unknown> | (() => unknown), status: number) {
    try {
      await (typeof p === 'function' ? p() : p)
    } catch (e) {
      assert.ok(e instanceof otp.OtpError, `expected OtpError, got ${String(e)}`)
      assert.equal(e.status, status, e.message)
      return e
    }
    assert.fail(`expected OtpError ${status}`)
  }

  // Skipped: MAIL_DISABLED without OTP_TEST_MODE, SIGN_OTP=off, or mail not configured.
  assert.equal(otp.otpRequired(), false, 'MAIL_DISABLED without OTP_TEST_MODE must skip OTP')
  assert.throws(() => otp.__otpTestPeek('x'), /OTP_TEST_MODE/)
  process.env.RESEND_API_KEY = 're_dummy_never_used'
  process.env.MAIL_FROM = 'Test <noreply@example.test>'
  assert.equal(otp.otpRequired(), false, 'MAIL_DISABLED wins over configured mail')
  delete process.env.MAIL_DISABLED // only otpRequired() runs here; nothing is sent
  try {
    assert.equal(otp.otpRequired(), true, 'mail configured -> OTP required')
    process.env.SIGN_OTP = 'off'
    assert.equal(otp.otpRequired(), false, 'SIGN_OTP=off')
    delete process.env.SIGN_OTP
    delete process.env.MAIL_FROM
    assert.equal(otp.otpRequired(), false, 'no MAIL_FROM -> mail not configured -> skipped')
  } finally {
    process.env.MAIL_DISABLED = '1'
    delete process.env.RESEND_API_KEY
    delete process.env.MAIL_FROM
    delete process.env.SIGN_OTP
  }
  assert.equal(otp.maskEmail('hl0713@tkcnco.com'), 'hl****@tkcnco.com')
  assert.equal(otp.maskEmail('a@b.co'), 'a****@b.co')
  log('OTP skipped without mail / SIGN_OTP=off / MAIL_DISABLED; required with mail configured; email masking')

  process.env.OTP_TEST_MODE = '1'
  process.env.SESSION_SECRET = 's'.repeat(40)
  assert.equal(otp.otpRequired(), true)
  const d4 = await wf.createDocument({ title: 'otp test', pdf: pdfBytes })
  const b4 = wf.saveDraft(d4.id, {
    signers: [{ name: '이몽룡', email: 'lee@example.com', is_owner: false, order_index: 0 }],
    fields: [{ signer_ref: 0, page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.08, type: 'signature' }],
  })
  const s4 = b4.signers[0]
  const t4 = s4.token
  await expectWorkflowError(wf.requestSignerOtp(t4, info), 409)
  log('OTP send refused before the document is sent (409)')
  await wf.sendDocument(d4.id)
  const signer4 = () => dbm.getSigners(d4.id)[0]
  const sign4 = () => wf.submitSignature(t4, { signaturePng: sig, values: {}, consent: true }, info)
  const setSigner = (sql: string, ...args: (string | null)[]) => dbm.db().prepare(`UPDATE signers SET ${sql} WHERE id = ?`).run(...args, s4.id)
  const pastIso = (ms: number) => new Date(Date.now() - ms).toISOString()

  assert.deepEqual(otp.otpStatus(signer4()), { required: true, verified: false, email_masked: 'le****@example.com' })
  assert.equal(await expectWorkflowError(sign4(), 403), '이메일 인증이 필요합니다.')
  log('sign blocked without OTP (403)')

  await expectOtpError(() => wf.verifySignerOtp(t4, '123456', info), 410)
  const sent1 = await wf.requestSignerOtp(t4, info)
  assert.deepEqual(sent1, { expires_in: 300, resend_in: 30 })
  assert.ok(!JSON.stringify(sent1).match(/\d{6}/), 'code never returned')
  const cd = await expectOtpError(wf.requestSignerOtp(t4, info), 429)
  assert.ok(cd.retryAfter! >= 1 && cd.retryAfter! <= 60, `retryAfter ${cd.retryAfter}`)
  log(`resend cooldown 429 (retry after ${cd.retryAfter}s)`)

  let code = otp.__otpTestPeek(s4.id)!
  assert.match(code, /^\d{6}$/)
  assert.notEqual(signer4().otp_hash, code)
  const wrong = (c: string) => String((Number(c) + 1) % 1_000_000).padStart(6, '0')
  const w1 = await expectOtpError(() => wf.verifySignerOtp(t4, wrong(code), info), 400)
  assert.equal(w1.remaining, 4)
  assert.equal(signer4().otp_attempts, 1)
  await expectOtpError(() => wf.verifySignerOtp(t4, '12ab', info), 400)
  assert.equal(signer4().otp_attempts, 1, 'malformed code does not use an attempt')
  for (const left of [3, 2, 1]) assert.equal((await expectOtpError(() => wf.verifySignerOtp(t4, wrong(code), info), 400)).remaining, left)
  const w5 = await expectOtpError(() => wf.verifySignerOtp(t4, wrong(code), info), 429)
  assert.equal(w5.remaining, 0)
  assert.equal(signer4().otp_hash, null)
  await expectOtpError(() => wf.verifySignerOtp(t4, code, info), 429) // correct code no longer works
  assert.equal(dbm.getEvents(d4.id).filter((e) => e.type === 'otp_failed').length, 5)
  log('wrong code decrements remaining attempts; 5 wrong -> code invalidated (429), correct code then rejected')

  setSigner('otp_sent_at = ?', pastIso(61_000))
  await wf.requestSignerOtp(t4, info)
  assert.equal(signer4().otp_attempts, 0)
  code = otp.__otpTestPeek(s4.id)!
  setSigner('otp_expires_at = ?', pastIso(1000))
  await expectOtpError(() => wf.verifySignerOtp(t4, code, info), 410)
  log('expired code -> 410')

  for (let i = 0; i < 3; i++) {
    setSigner('otp_sent_at = ?', pastIso(61_000))
    await wf.requestSignerOtp(t4, info) // sends #3..#5 within the hour
  }
  setSigner('otp_sent_at = ?', pastIso(61_000))
  const lim = await expectOtpError(wf.requestSignerOtp(t4, info), 429)
  assert.match(lim.message, /횟수/)
  assert.equal(dbm.getEvents(d4.id).filter((e) => e.type === 'otp_sent').length, 5)
  log('max 5 sends per hour -> 429')

  code = otp.__otpTestPeek(s4.id)!
  const ok = wf.verifySignerOtp(t4, code, { ip: '192.0.2.9', userAgent: 'otp-ua' })
  assert.ok(ok.verified_at)
  assert.equal(signer4().otp_hash, null)
  assert.equal(otp.otpStatus(signer4()).verified, true)
  const ev = dbm.getEvents(d4.id).find((e) => e.type === 'otp_verified')!
  assert.equal(ev.ip, '192.0.2.9')
  assert.equal(ev.user_agent, 'otp-ua')
  // Verification older than 30 minutes no longer counts.
  setSigner('otp_verified_at = ?', pastIso(31 * 60_000))
  await expectWorkflowError(sign4(), 403)
  setSigner('otp_verified_at = ?', ok.verified_at)
  const r4 = await sign4()
  assert.equal(r4.completed, true)
  await wf.flushBackgroundTasks()
  const pdfjs4 = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const sealed4 = await pdfjs4.getDocument({ data: new Uint8Array(fs.readFileSync(dbm.signedPdfPath(d4.id))), isEvalSupported: false }).promise
  let audit4 = ''
  for (let n = 1; n <= sealed4.numPages; n++)
    audit4 += (await (await sealed4.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join('')
  assert.ok(audit4.includes('이메일 OTP 인증'), 'audit page missing OTP row')
  log('verify ok -> sign ok (30 min window enforced); audit certificate shows 이메일 OTP 인증')

  delete process.env.OTP_TEST_MODE
  assert.throws(() => otp.__otpTestPeek(s4.id))
}

dbm.db().close()
if (!process.env.KEEP) fs.rmSync(dataDir, { recursive: true, force: true })
console.log('smoke-core: ALL PASSED')
