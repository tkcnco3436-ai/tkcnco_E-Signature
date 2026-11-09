// Preview the audit certificate for an existing document without touching its stored sealed PDF.
// Usage: node --import ./scripts/ts-register.mjs --conditions=react-server scripts/preview-audit.mts <documentId> <out.pdf> [stress]
// "stress" adds fake signers/events to check pagination.
import fs from 'node:fs'
import { getBundle } from '../lib/db.ts'
import { buildSealedPdf } from '../lib/seal.ts'
import type { DocumentBundle } from '../lib/types.ts'

const [id, out, stress] = process.argv.slice(2)
const b = getBundle(id) as DocumentBundle
if (!b) throw new Error('document not found: ' + id)
if (stress) {
  const base = b.signers[0]
  for (let i = 0; i < 4; i++) b.signers.push({ ...base, id: `fake${i}`, name: `추가 서명자 ${i + 1}`, email: `x${i}@example.com`, order_index: b.signers.length })
  const ev = [...b.events]
  for (let i = 0; i < 3; i++) b.events.push(...ev.slice(1))
}
const sealed = await buildSealedPdf(b)
fs.writeFileSync(out, sealed.bytes)
console.log('wrote', out)
if (sealed.timestamp) console.log('timestamp', sealed.timestamp.at.toISOString(), 'from', sealed.timestamp.tsa)
else console.log('no timestamp', sealed.timestampError ?? '(TSA disabled)')
