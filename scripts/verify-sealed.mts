// Verifies the PAdES signature of a sealed PDF and its RFC 3161 signature timestamp (if any).
// Usage: node --import ./scripts/ts-register.mjs --conditions=react-server scripts/verify-sealed.mts <sealed.pdf> [--require-timestamp]
// Exit code 0 = every check passed. Also importable: `verifySealed(bytes)` returns the report or throws.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { children, content, intHex, octets, oidOf, parseTimeStampToken, readTlv, whole, type Tlv } from '../lib/tsa.ts'

const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4'
const OID_TS_TOKEN = '1.2.840.113549.1.9.16.2.14'
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2'
const HASHES: Record<string, string> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
}
const RSA_PSS = '1.2.840.113549.1.1.10'

function fail(msg: string): never {
  throw new Error('FAIL: ' + msg)
}

interface SignerCheck {
  digestAlg: string
  sigAlgOid: string
  certSubject: string
  certIssuer: string
  keyType: string
  signatureValue: Buffer
  unsignedAttrs: Map<string, Tlv[]>
  certs: crypto.X509Certificate[]
}

/** Verifies the (single) SignerInfo of a SignedData over `contentBytes`. Throws on any mismatch. */
function verifySignedData(buf: Buffer, sd: Tlv, contentBytes: Buffer, label: string): SignerCheck {
  const parts = children(buf, sd)
  const certs: crypto.X509Certificate[] = []
  const certTlv = parts.find((p) => p.tag === 0xa0)
  if (certTlv) for (const c of children(buf, certTlv)) if (c.tag === 0x30) certs.push(new crypto.X509Certificate(whole(buf, c)))
  const signerInfos = parts[parts.length - 1]
  if (signerInfos.tag !== 0x31) fail(`${label}: signerInfos missing`)
  const sis = children(buf, signerInfos)
  if (sis.length !== 1) fail(`${label}: expected 1 SignerInfo, got ${sis.length}`)
  const si = children(buf, sis[0])
  const sid = si[1]
  const digestAlg = HASHES[oidOf(buf, children(buf, si[2])[0])] ?? fail(`${label}: unknown digest algorithm`)
  let i = 3
  const signedAttrs = si[i].tag === 0xa0 ? si[i++] : null
  const sigAlgOid = oidOf(buf, children(buf, si[i++])[0])
  if (sigAlgOid === RSA_PSS) fail(`${label}: RSA-PSS not supported by this script`)
  const sigTlv = si[i++]
  if (sigTlv.tag !== 0x04) fail(`${label}: signature is not an OCTET STRING`)
  const signatureValue = Buffer.from(content(buf, sigTlv))
  const unsignedAttrs = new Map<string, Tlv[]>()
  if (si[i]?.tag === 0xa1) {
    for (const a of children(buf, si[i])) {
      const [t, vals] = children(buf, a)
      unsignedAttrs.set(oidOf(buf, t), children(buf, vals))
    }
  }

  let toVerify: Buffer
  if (signedAttrs) {
    let md: Buffer | null = null
    for (const a of children(buf, signedAttrs)) {
      const [t, vals] = children(buf, a)
      const oid = oidOf(buf, t)
      if (oid === OID_MESSAGE_DIGEST) md = octets(buf, children(buf, vals)[0])
    }
    if (!md) fail(`${label}: no messageDigest attribute`)
    const actual = crypto.createHash(digestAlg).update(contentBytes).digest()
    if (!md.equals(actual)) fail(`${label}: messageDigest != ${digestAlg}(content)`)
    console.log(`  ✓ ${label}: messageDigest == ${digestAlg}(content) (${actual.toString('hex').slice(0, 16)}…)`)
    // Signature is over the DER of signedAttrs with the [0] IMPLICIT tag replaced by SET (0x31).
    toVerify = Buffer.from(whole(buf, signedAttrs))
    toVerify[0] = 0x31
  } else {
    toVerify = contentBytes
  }

  // Candidate certs: matching serial (issuerAndSerialNumber) first, else all.
  let candidates = certs
  if (sid.tag === 0x30) {
    const serial = intHex(buf, children(buf, sid)[1]).toUpperCase()
    const bySerial = certs.filter((c) => c.serialNumber.replace(/^0+/, '').toUpperCase() === serial)
    if (bySerial.length) candidates = bySerial
  }
  const cert = candidates.find((c) => {
    try {
      return crypto.verify(digestAlg, toVerify, c.publicKey, signatureValue)
    } catch {
      return false
    }
  })
  if (!cert) fail(`${label}: signature does not verify with any embedded certificate`)
  const keyType = cert.publicKey.asymmetricKeyType ?? '?'
  console.log(`  ✓ ${label}: ${keyType.toUpperCase()} signature (${digestAlg}) over ${signedAttrs ? 'signedAttrs' : 'content'} verifies with embedded cert`)
  return {
    digestAlg,
    sigAlgOid,
    certSubject: cert.subject.replace(/\n/g, ', '),
    certIssuer: cert.issuer.replace(/\n/g, ', '),
    keyType,
    signatureValue,
    unsignedAttrs,
    certs,
  }
}

export interface VerifyReport {
  signer: string
  cmsBytes: number
  placeholderBytes: number
  timestamp: null | { genTime: Date; tsaSubject: string; tsaIssuer: string; tokenBytes: number; policy: string; serial: string }
}

export function verifySealed(pdf: Buffer): VerifyReport {
  const s = pdf.toString('latin1')
  const all = [...s.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)]
  if (!all.length) fail('no /ByteRange')
  const m = all[all.length - 1]
  const [a, b, c, d] = m.slice(1).map(Number)
  if (a !== 0 || c + d !== pdf.length) fail('ByteRange does not cover the whole file')
  if (pdf[b] !== 0x3c || pdf[c - 1] !== 0x3e) fail('/Contents is not a hex string at the ByteRange gap')
  console.log(`  ✓ ByteRange [0 ${b} ${c} ${d}] covers the whole file (${pdf.length} bytes)`)
  const signed = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)])
  const hex = s.slice(b + 1, c - 1)
  const placeholderBytes = hex.length / 2
  const padded = Buffer.from(hex, 'hex')
  const ci = readTlv(padded)
  const cms = padded.subarray(0, ci.end)
  if (padded.subarray(ci.end).some((x) => x !== 0)) fail('non-zero bytes after the CMS in /Contents')
  const [ctype, explicit] = children(cms, readTlv(cms))
  if (oidOf(cms, ctype) !== OID_SIGNED_DATA) fail('CMS is not SignedData')
  console.log(`  ✓ CMS SignedData ${cms.length} bytes in a ${placeholderBytes}-byte placeholder`)
  const sd = children(cms, explicit)[0]
  const main = verifySignedData(cms, sd, signed, 'PDF signature')
  console.log(`    signer: ${main.certSubject}`)

  const tsAttr = main.unsignedAttrs.get(OID_TS_TOKEN)
  if (!tsAttr) {
    console.log('  - no signature timestamp (id-aa-signatureTimeStampToken absent)')
    return { signer: main.certSubject, cmsBytes: cms.length, placeholderBytes, timestamp: null }
  }
  const token = Buffer.from(whole(cms, tsAttr[0]))
  const { tstInfo, eContent, signedData } = parseTimeStampToken(token)
  const hashName = HASHES[tstInfo.hashOid] ?? fail('timestamp: unknown imprint hash')
  const imprint = crypto.createHash(hashName).update(main.signatureValue).digest()
  if (!imprint.equals(tstInfo.hashedMessage)) fail('timestamp: messageImprint != hash(SignerInfo.signature)')
  console.log(`  ✓ timestamp: messageImprint == ${hashName}(SignerInfo signature value)`)
  const tsa = verifySignedData(token, signedData, eContent, 'TSA token')
  console.log(`  ✓ timestamp: genTime ${tstInfo.genTime.toISOString()} · serial ${tstInfo.serialHex} · policy ${tstInfo.policy}`)
  console.log(`    TSA signer: ${tsa.certSubject}`)
  console.log(`    TSA issuer: ${tsa.certIssuer}`)
  console.log(`    token ${token.length} bytes, ${tsa.certs.length} cert(s) embedded`)
  return {
    signer: main.certSubject,
    cmsBytes: cms.length,
    placeholderBytes,
    timestamp: {
      genTime: tstInfo.genTime,
      tsaSubject: tsa.certSubject,
      tsaIssuer: tsa.certIssuer,
      tokenBytes: token.length,
      policy: tstInfo.policy,
      serial: tstInfo.serialHex,
    },
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: verify-sealed.mts <sealed.pdf> [--require-timestamp]')
    process.exit(2)
  }
  try {
    console.log('verify', file)
    const r = verifySealed(fs.readFileSync(file))
    if (process.argv.includes('--require-timestamp') && !r.timestamp) fail('no timestamp but --require-timestamp given')
    console.log('verify-sealed: ALL CHECKS PASSED')
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }
}
