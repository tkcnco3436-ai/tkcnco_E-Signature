// HTTP test of the email-OTP signing flow.
// Server must run with MAIL_DISABLED=1 OTP_TEST_MODE=1 (codes are printed as "[otp] <email> <code>"),
// and its stdout must go to the log file given as the 2nd argument.
// Usage: node scripts/e2e-otp.mjs <baseUrl> <serverLogPath>
import fs from 'node:fs'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'

const [BASE, LOG] = process.argv.slice(2)
const env = Object.fromEntries(
  fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)
let failures = 0
const ok = (c, m) => (console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`), c || failures++)
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAAAUCAYAAADRA14pAAAAlUlEQVR4nO3WMRKAIBADQB5h7cP8/z/OSgvnhuHOkABaXAchq6ND2fajfGnkBX7wQmBzZkmwB5XBR8BS0Uxs6wOZEhwFsNA2ApaFtguMDEcU7oG2JxgRjizaLWuKtwLYf2cgwrt/d8j/QdOiaKgYXe2VQSguDZleblYrSH5DQnV6cwALGkVXMzIHKKCwXuri9JEXYM8JJQ9DuuWDIRcAAAAASUVORK5CYII='
const json = (b) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
const codeFor = (email) => {
  const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter((l) => l.includes('[otp]') && l.includes(email))
  return lines.length ? lines[lines.length - 1].match(/(\d{6})\s*$/)?.[1] : undefined
}

let r = await fetch(`${BASE}/api/auth/login`, json({ password: env.ADMIN_PASSWORD }))
const H = { cookie: (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ') }
const pdf = await PDFDocument.create()
pdf.addPage([595, 842])
const fd = new FormData()
fd.append('file', new Blob([await pdf.save()], { type: 'application/pdf' }), 'otp.pdf')
fd.append('title', 'OTP 테스트')
r = await fetch(`${BASE}/api/admin/documents`, { method: 'POST', headers: H, body: fd })
const { id } = await r.json()
r = await fetch(`${BASE}/api/admin/documents/${id}`, {
  method: 'PUT',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({
    signers: [{ name: '외부서명자', email: 'otp-signer@example.com', is_owner: false, order_index: 0 }],
    fields: [{ signer_ref: 0, page: 1, x: 0.1, y: 0.7, w: 0.25, h: 0.06, type: 'signature' }],
  }),
})
const token = (await r.json()).signers[0].token
await fetch(`${BASE}/api/admin/documents/${id}/send`, { method: 'POST', headers: H })

r = await fetch(`${BASE}/api/sign/${token}`)
const view = await r.json()
ok(view.otp?.required === true, `otp required -> ${JSON.stringify(view.otp)}`)
r = await fetch(`${BASE}/api/sign/${token}`, json({ signaturePng: PNG, values: {}, consent: true }))
ok(r.status === 403, `sign without OTP -> ${r.status}`)
r = await fetch(`${BASE}/api/sign/${token}/otp`, { method: 'POST' })
ok(r.status === 200, `request code -> ${r.status}`)
r = await fetch(`${BASE}/api/sign/${token}/otp`, { method: 'POST' })
ok(r.status === 429, `resend within cooldown -> ${r.status}`)
const code = codeFor('otp-signer@example.com')
ok(!!code, 'code printed to server log')
const wrong = code === '000000' ? '111111' : '000000'
r = await fetch(`${BASE}/api/sign/${token}/otp/verify`, json({ code: wrong }))
const w = await r.json()
ok(r.status === 400 && w.remaining === 4, `wrong code -> ${r.status} remaining ${w.remaining}`)
r = await fetch(`${BASE}/api/sign/${token}/otp/verify`, json({ code }))
ok(r.status === 200, `correct code -> ${r.status}`)
r = await fetch(`${BASE}/api/sign/${token}`, json({ signaturePng: PNG, values: {}, consent: true }))
const done = await r.json()
ok(r.ok && done.completed === true, `sign after OTP -> ${r.status} ${JSON.stringify(done)}`)
r = await fetch(`${BASE}/api/admin/documents/${id}`, { headers: H })
const b = await r.json()
ok(!!b.document.timestamp_at, `timestamp_at stored -> ${b.document.timestamp_at} (${b.document.timestamp_tsa})`)
ok(b.events.some((e) => e.type === 'otp_verified'), 'otp_verified event logged')
r = await fetch(`${BASE}/api/sign/${token}/download`)
fs.mkdirSync('data', { recursive: true })
fs.writeFileSync(path.join('data', 'e2e-otp-sealed.pdf'), Buffer.from(await r.arrayBuffer()))
ok(r.ok, `sealed download -> ${r.status} (data/e2e-otp-sealed.pdf)`)
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
