// RFC 3161 time-stamp client (TimeStampReq / TimeStampResp) and a minimal DER reader.
// No `server-only` import so scripts/verify-sealed.mts can reuse the DER helpers.
import crypto from 'node:crypto'
import forge from 'node-forge'

export const DEFAULT_TSA_URL = 'http://timestamp.digicert.com'
const TIMEOUT_MS = 15_000

const OID_SHA256 = '2.16.840.1.101.3.4.2.1'
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2'
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4'

function flag(name: string, def: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase()
  if (!v) return def
  return !['0', 'false', 'off', 'no'].includes(v)
}

/** TSA settings from env, read on every call (TSA_URL, TSA_ENABLED default on, TSA_REQUIRED default off). */
export function tsaConfig(): { enabled: boolean; required: boolean; url: string } {
  return {
    enabled: flag('TSA_ENABLED', true),
    required: flag('TSA_REQUIRED', false),
    url: process.env.TSA_URL?.trim() || DEFAULT_TSA_URL,
  }
}

// ---------------------------------------------------------------------------
// Minimal DER reader (keeps exact byte ranges, so signed bytes are never re-encoded)
// ---------------------------------------------------------------------------

export interface Tlv {
  tag: number // first identifier octet (low-tag-number form only)
  start: number // offset of the tag byte
  contentStart: number
  end: number // offset after the content
}

export function readTlv(buf: Buffer, offset = 0): Tlv {
  if (offset + 2 > buf.length) throw new Error('DER: truncated')
  const tag = buf[offset]
  if ((tag & 0x1f) === 0x1f) throw new Error('DER: high tag numbers not supported')
  let p = offset + 1
  let len = buf[p++]
  if (len === 0x80) throw new Error('DER: indefinite length not supported')
  if (len & 0x80) {
    const n = len & 0x7f
    if (n > 4 || p + n > buf.length) throw new Error('DER: bad length')
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++]
  }
  const end = p + len
  if (end > buf.length) throw new Error('DER: length beyond buffer')
  return { tag, start: offset, contentStart: p, end }
}

export function children(buf: Buffer, t: Tlv): Tlv[] {
  const out: Tlv[] = []
  let p = t.contentStart
  while (p < t.end) {
    const c = readTlv(buf, p)
    out.push(c)
    p = c.end
  }
  if (p !== t.end) throw new Error('DER: child overrun')
  return out
}

export const content = (buf: Buffer, t: Tlv) => buf.subarray(t.contentStart, t.end)
export const whole = (buf: Buffer, t: Tlv) => buf.subarray(t.start, t.end)
export const oidOf = (buf: Buffer, t: Tlv) => {
  if (t.tag !== 0x06) throw new Error('DER: expected OID')
  return forge.asn1.derToOid(forge.util.createBuffer(content(buf, t).toString('binary')))
}
/** Unsigned big-endian INTEGER as lowercase hex without leading zeros. */
export const intHex = (buf: Buffer, t: Tlv) => {
  if (t.tag !== 0x02) throw new Error('DER: expected INTEGER')
  return content(buf, t).toString('hex').replace(/^(00)+/, '') || '0'
}
/** OCTET STRING value (primitive, or BER-constructed chunks concatenated). */
export function octets(buf: Buffer, t: Tlv): Buffer {
  if (t.tag === 0x04) return Buffer.from(content(buf, t))
  if (t.tag === 0x24) return Buffer.concat(children(buf, t).map((c) => octets(buf, c)))
  throw new Error('DER: expected OCTET STRING')
}

// ---------------------------------------------------------------------------
// Time-stamp token parsing
// ---------------------------------------------------------------------------

export interface TstInfo {
  hashOid: string
  hashedMessage: Buffer
  serialHex: string
  genTime: Date
  nonceHex: string | null
  policy: string
}

/** Parses a TimeStampToken (DER ContentInfo/SignedData) and returns its TSTInfo plus raw parts. */
export function parseTimeStampToken(token: Buffer): {
  tstInfo: TstInfo
  eContent: Buffer
  signedData: Tlv
} {
  const ci = readTlv(token)
  if (ci.end !== token.length) throw new Error('token: trailing bytes')
  const [ctype, explicit] = children(token, ci)
  if (oidOf(token, ctype) !== OID_SIGNED_DATA) throw new Error('token: not SignedData')
  const sd = children(token, explicit)[0]
  const sdParts = children(token, sd)
  const encap = sdParts[2]
  const [eType, eExplicit] = children(token, encap)
  if (oidOf(token, eType) !== OID_TST_INFO) throw new Error('token: eContentType is not TSTInfo')
  const eContent = octets(token, children(token, eExplicit)[0])
  return { tstInfo: parseTstInfo(eContent), eContent, signedData: sd }
}

export function parseTstInfo(der: Buffer): TstInfo {
  const seq = readTlv(der)
  const f = children(der, seq)
  // version, policy, messageImprint, serialNumber, genTime, [accuracy], [ordering], [nonce], [tsa], [extensions]
  const policy = oidOf(der, f[1])
  const [alg, hashed] = children(der, f[2])
  const hashOid = oidOf(der, children(der, alg)[0])
  const serialHex = intHex(der, f[3])
  if (f[4].tag !== 0x18) throw new Error('TSTInfo: genTime is not GeneralizedTime')
  const genTime = forge.asn1.generalizedTimeToDate(content(der, f[4]).toString('latin1'))
  let nonceHex: string | null = null
  for (const x of f.slice(5)) {
    if (x.tag === 0x02) {
      nonceHex = intHex(der, x) // the only INTEGER after genTime is the nonce
      break
    }
  }
  return { hashOid, hashedMessage: octets(der, hashed), serialHex, genTime, nonceHex, policy }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function buildRequest(digest: Buffer, nonce: Buffer): Buffer {
  const a = forge.asn1
  const req = a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
    a.create(a.Class.UNIVERSAL, a.Type.INTEGER, false, a.integerToDer(1).getBytes()),
    a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
      a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
        a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer(OID_SHA256).getBytes()),
        a.create(a.Class.UNIVERSAL, a.Type.NULL, false, ''),
      ]),
      a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, digest.toString('binary')),
    ]),
    a.create(a.Class.UNIVERSAL, a.Type.INTEGER, false, nonce.toString('binary')),
    a.create(a.Class.UNIVERSAL, a.Type.BOOLEAN, false, String.fromCharCode(0xff)), // certReq TRUE
  ])
  return Buffer.from(a.toDer(req).getBytes(), 'binary')
}

/**
 * Requests an RFC 3161 time-stamp over a SHA-256 digest. Returns the DER TimeStampToken
 * (ContentInfo) and its genTime. Throws on network error, timeout (15 s), a rejected status,
 * or a token whose messageImprint / nonce does not match the request.
 */
export async function requestTimestamp(
  digest: Buffer,
  url: string = tsaConfig().url,
): Promise<{ token: Buffer; genTime: Date }> {
  if (digest.length !== 32) throw new Error('requestTimestamp expects a SHA-256 digest')
  // 8-byte positive, minimally encoded nonce (top bit clear, second bit set).
  const nonce = crypto.randomBytes(8)
  nonce[0] = (nonce[0] & 0x7f) | 0x40
  const body = buildRequest(digest, nonce)

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  let res: Response
  let resp: Buffer
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply' },
      body: new Uint8Array(body),
      signal: ac.signal,
    })
    resp = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    if (ac.signal.aborted) throw new Error(`TSA ${url}: timeout after ${TIMEOUT_MS / 1000}s`)
    throw new Error(`TSA ${url}: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`TSA ${url}: HTTP ${res.status}`)

  const top = readTlv(resp)
  const parts = children(resp, top)
  const statusParts = children(resp, parts[0])
  const status = Number.parseInt(intHex(resp, statusParts[0]), 16)
  if (status !== 0 && status !== 1) {
    const text = statusParts[1]?.tag === 0x30 ? children(resp, statusParts[1]).map((t) => content(resp, t).toString('utf8')).join(' ') : ''
    throw new Error(`TSA ${url}: status ${status}${text ? ` (${text})` : ''}`)
  }
  if (!parts[1]) throw new Error(`TSA ${url}: granted but no token`)
  const token = Buffer.from(whole(resp, parts[1]))

  const { tstInfo } = parseTimeStampToken(token)
  if (tstInfo.hashOid !== OID_SHA256) throw new Error(`TSA ${url}: unexpected hash algorithm ${tstInfo.hashOid}`)
  if (!tstInfo.hashedMessage.equals(digest)) throw new Error(`TSA ${url}: messageImprint mismatch`)
  const want = nonce.toString('hex').replace(/^(00)+/, '')
  if (tstInfo.nonceHex !== want) throw new Error(`TSA ${url}: nonce mismatch`)
  return { token, genTime: tstInfo.genTime }
}
