// End-to-end test over HTTP against a running server.
// Usage: node scripts/e2e.mjs [baseUrl]   (default http://localhost:3100)
// Reads ADMIN_PASSWORD from env or .env.local. Signs via API with tokens (no email needed).
//
// IMPORTANT: run the server under test with MAIL_DISABLED=1 and its own DATA_DIR, otherwise the
// real RESEND_API_KEY in .env.local sends mail to the test addresses. In PowerShell:
//   $env:MAIL_DISABLED='1'; $env:DATA_DIR="$env:TEMP\esign-e2e"; npx next start -H 127.0.0.1 -p 3195
//   node scripts/e2e.mjs http://localhost:3195
// ($env:RESEND_API_KEY='' does NOT work: it deletes the variable and Next falls back to .env.local.)
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const BASE = process.argv[2] || 'http://localhost:3100'
const envFile = path.join(process.cwd(), '.env.local')
const env = fs.existsSync(envFile)
  ? Object.fromEntries(
      fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    )
  : {}
const PASSWORD = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD

let failures = 0
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) failures++
}

// 60x20 RGBA PNG with a wavy stroke, stands in for a hand-drawn signature.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAAAUCAYAAADRA14pAAAAlUlEQVR4nO3WMRKAIBADQB5h7cP8/z/OSgvnhuHOkABaXAchq6ND2fajfGnkBX7wQmBzZkmwB5XBR8BS0Uxs6wOZEhwFsNA2ApaFtguMDEcU7oG2JxgRjizaLWuKtwLYf2cgwrt/d8j/QdOiaKgYXe2VQSguDZleblYrSH5DQnV6cwALGkVXMzIHKKCwXuri9JEXYM8JJQ9DuuWDIRcAAAAASUVORK5CYII='

/** All-transparent RGBA PNG of the given size, used to test the signature size cap. */
function blankPng(W, H) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc((W * 4 + 1) * H))),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return 'data:image/png;base64,' + png.toString('base64')
}

async function main() {
  // sample PDF
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 2; i++) {
    const p = doc.addPage([595, 842])
    p.drawText(`E2E sample contract - page ${i}`, { x: 50, y: 780, size: 18, font })
  }
  const pdfBytes = await doc.save()

  // wrong password rejected
  let r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) })
  ok(r.status === 401, 'wrong password -> 401')

  r = await fetch(`${BASE}/api/admin/documents/x`)
  ok(r.status === 401, 'admin API without session -> 401')

  r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ password: PASSWORD }) })
  ok(r.status === 403, `cross-origin login -> 403 (${r.status})`)

  r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })
  ok(r.ok, `login -> ${r.status}`)
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ')
  const H = { cookie }

  // upload
  const fd = new FormData()
  fd.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'e2e.pdf')
  fd.append('title', 'E2E 테스트 계약서')
  fd.append('message', '테스트 메시지')
  r = await fetch(`${BASE}/api/admin/documents`, { method: 'POST', headers: H, body: fd })
  const created = await r.json()
  ok(r.ok && created.id, `upload -> ${r.status}`)
  const id = created.id

  // non-PDF upload rejected
  const bad = new FormData()
  bad.append('file', new Blob([Buffer.from('hello')], { type: 'application/pdf' }), 'x.pdf')
  r = await fetch(`${BASE}/api/admin/documents`, { method: 'POST', headers: H, body: bad })
  ok(r.status >= 400 && r.status < 500, `fake PDF rejected -> ${r.status}`)

  // save draft: owner + external
  r = await fetch(`${BASE}/api/admin/documents/${id}`, {
    method: 'PUT',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({
      signers: [
        { name: '홍길동', email: 'owner@example.com', is_owner: true, order_index: 0 },
        { name: '김상대', email: 'other@example.com', is_owner: false, order_index: 1 },
      ],
      fields: [
        { signer_ref: 0, page: 2, x: 0.1, y: 0.75, w: 0.25, h: 0.06, type: 'signature' },
        { signer_ref: 0, page: 2, x: 0.1, y: 0.7, w: 0.2, h: 0.03, type: 'name' },
        { signer_ref: 1, page: 2, x: 0.6, y: 0.75, w: 0.25, h: 0.06, type: 'signature' },
        { signer_ref: 1, page: 2, x: 0.6, y: 0.7, w: 0.2, h: 0.03, type: 'date' },
        { signer_ref: 1, page: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.03, type: 'text', label: '회사명' },
      ],
    }),
  })
  const bundle = await r.json()
  ok(r.ok && bundle.signers?.length === 2, `save draft -> ${r.status}`)
  const [owner, other] = bundle.signers
  const otherFields = bundle.fields.filter((f) => f.signer_id === other.id)
  const textField = otherFields.find((f) => f.type === 'text')

  // signing before send is refused
  r = await fetch(`${BASE}/api/sign/${owner.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signaturePng: PNG, values: {}, consent: true }) })
  ok(r.status >= 400, `sign before send refused -> ${r.status}`)

  r = await fetch(`${BASE}/api/admin/documents/${id}/send`, { method: 'POST', headers: H })
  const sent = await r.json()
  ok(r.ok, `send -> ${r.status} ${JSON.stringify(sent).slice(0, 120)}`)

  // MAIL_DISABLED=1 without OTP_TEST_MODE: email OTP is skipped, signing works without it.
  r = await fetch(`${BASE}/api/sign/${owner.token}`)
  const view0 = await r.json()
  ok(r.ok && view0.otp?.required === false, `GET sign view: otp.required === false with MAIL_DISABLED (${JSON.stringify(view0.otp)})`)

  // CSRF: a state-changing admin call with a foreign Origin is refused even with a valid cookie
  r = await fetch(`${BASE}/api/admin/documents/${id}/resend`, { method: 'POST', headers: { ...H, origin: 'https://evil.example' } })
  ok(r.status === 403, `cross-origin admin POST -> 403 (${r.status})`)
  r = await fetch(`${BASE}/api/admin/documents/${id}`, { method: 'DELETE', headers: { ...H, origin: 'https://evil.example' } })
  ok(r.status === 403, `cross-origin admin DELETE -> 403 (${r.status})`)

  // a document in progress cannot be deleted (must be voided first)
  r = await fetch(`${BASE}/api/admin/documents/${id}`, { method: 'DELETE', headers: H })
  ok(r.status === 409, `delete of sent document -> 409 (${r.status})`)

  // external cannot sign before owner
  r = await fetch(`${BASE}/api/sign/${other.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signaturePng: PNG, values: { [textField.id]: '상대회사' }, consent: true }) })
  ok(r.status >= 400, `out-of-order sign refused -> ${r.status}`)

  // signer view must not leak tokens
  r = await fetch(`${BASE}/api/sign/${other.token}`)
  const viewText = await r.text()
  ok(r.ok && !viewText.includes(owner.token) && !viewText.includes('owner@example.com'), 'signer view hides other token/email')

  r = await fetch(`${BASE}/api/sign/${other.token}/file`)
  ok(r.ok && (await r.arrayBuffer()).byteLength > 100, 'signer can fetch PDF')

  // oversized signature image (3200x10 > 3000x1500 cap) is rejected before saving
  r = await fetch(`${BASE}/api/sign/${owner.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signaturePng: blankPng(3200, 10), values: {}, consent: true }) })
  ok(r.status === 400, `oversized signature PNG -> 400 (${r.status})`)

  // owner signs
  r = await fetch(`${BASE}/api/sign/${owner.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signaturePng: PNG, values: {}, consent: true }) })
  ok(r.ok, `owner signs -> ${r.status} ${r.ok ? '' : await r.text()}`)

  // double sign refused
  r = await fetch(`${BASE}/api/sign/${owner.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signaturePng: PNG, values: {}, consent: true }) })
  ok(r.status >= 400, `double sign refused -> ${r.status}`)

  r = await fetch(`${BASE}/api/sign/${other.token}/download`)
  ok(r.status === 409, `download before completion -> ${r.status}`)

  // external signs
  r = await fetch(`${BASE}/api/sign/${other.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signaturePng: PNG, values: { [textField.id]: '상대회사' }, consent: true }) })
  const fin = r.ok ? await r.json() : await r.text()
  ok(r.ok && fin.completed === true, `external signs -> completed ${JSON.stringify(fin)}`)

  r = await fetch(`${BASE}/api/sign/${other.token}/download`)
  const sealed = Buffer.from(await r.arrayBuffer())
  ok(r.ok && sealed.subarray(0, 5).toString() === '%PDF-', `sealed download -> ${r.status}, ${sealed.length} bytes`)
  ok(sealed.includes(Buffer.from('/ByteRange')), 'sealed PDF has PAdES signature (/ByteRange)')
  const loaded = await PDFDocument.load(sealed, { ignoreEncryption: true })
  // 2 original pages + audit certificate (1 or more pages, it paginates)
  ok(loaded.getPageCount() >= 3, `sealed page count >= 3 (2 + audit) -> ${loaded.getPageCount()}`)
  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync(path.join('data', 'e2e-sealed.pdf'), sealed)

  r = await fetch(`${BASE}/api/admin/documents/${id}`, { headers: H })
  const final = await r.json()
  ok(final.document.status === 'completed' && final.document.signed_sha256, 'admin bundle completed with signed_sha256')

  r = await fetch(`${BASE}/api/admin/documents/${id}/file?kind=signed`, { headers: H })
  ok(r.ok, `admin sealed download -> ${r.status}`)

  // completed document: resend re-sends the completion mail (fresh download links) to every signer
  r = await fetch(`${BASE}/api/admin/documents/${id}/resend`, { method: 'POST', headers: H })
  const rs = await r.json()
  ok(
    r.ok && rs.notifiedAll?.length === 2 && rs.notifiedAll.every((n) => n.link.endsWith('/download')),
    `resend on completed -> ${r.status}, ${rs.notifiedAll?.length} links`,
  )

  // a draft can be deleted; same-origin DELETE is allowed
  const fd2 = new FormData()
  fd2.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'del.pdf')
  fd2.append('title', 'E2E delete')
  r = await fetch(`${BASE}/api/admin/documents`, { method: 'POST', headers: H, body: fd2 })
  const d2 = await r.json()
  r = await fetch(`${BASE}/api/admin/documents/${d2.id}`, { method: 'DELETE', headers: { ...H, origin: new URL(BASE).origin } })
  ok(r.ok, `delete draft (same-origin) -> ${r.status}`)

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS  (sealed copy: data/e2e-sealed.pdf)')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
