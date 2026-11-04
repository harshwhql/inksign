import { InkSignError } from '../errors.js'

/**
 * Hashing built on WebCrypto, which is native in browsers (secure contexts,
 * so https and localhost) and in Node 18 or later. No polyfill is bundled:
 * shipping a second JavaScript SHA-256 would double the surface that has to be
 * trusted for the audit chain to mean anything.
 */

function subtle(): SubtleCrypto {
  const crypto = (globalThis as { crypto?: Crypto }).crypto
  if (!crypto?.subtle) {
    throw new InkSignError(
      'UNSUPPORTED',
      'WebCrypto is not available. InkSign needs a secure context (https or localhost) in the browser, or Node 18 or later.',
    )
  }
  return crypto.subtle
}

const encoder = new TextEncoder()

const HEX = '0123456789abcdef'

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] as number
    out += HEX[byte >> 4]
    out += HEX[byte & 15]
  }
  return out
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new InkSignError('DIGEST_MISMATCH', 'Hex string must have an even length', {
      length: hex.length,
    })
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** SHA-256 of raw bytes, as lowercase hex. */
export async function sha256(data: Uint8Array | ArrayBuffer): Promise<string> {
  const buffer = data instanceof Uint8Array ? toArrayBuffer(data) : data
  const hash = await subtle().digest('SHA-256', buffer)
  return toHex(new Uint8Array(hash))
}

/** SHA-256 of a UTF-8 string, as lowercase hex. */
export async function sha256Text(text: string): Promise<string> {
  return sha256(encoder.encode(text))
}

/**
 * SHA-256 of a JSON-serializable value, using a canonical form so that key
 * order and whitespace cannot change the digest. Two structurally equal
 * objects always hash the same, which is what lets a verifier recompute the
 * chain from stored records.
 */
export async function sha256Json(value: unknown): Promise<string> {
  return sha256Text(canonicalize(value))
}

/**
 * Deterministic JSON: object keys sorted, `undefined` dropped, no whitespace.
 * Arrays keep their order, since order is meaningful there.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'

  const type = typeof value
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new InkSignError('UNSUPPORTED', 'Cannot canonicalize a non-finite number', { value })
    }
    return JSON.stringify(value)
  }
  if (type === 'string' || type === 'boolean') return JSON.stringify(value)
  if (type === 'bigint') return JSON.stringify((value as bigint).toString())
  if (type === 'undefined' || type === 'function' || type === 'symbol') return 'null'

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (value instanceof Uint8Array) return JSON.stringify(toHex(value))

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`
}

/**
 * Constant-time comparison of two hex digests, so verification does not leak
 * how much of a forged digest was correct.
 */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * HMAC-SHA-256, as lowercase hex. Used to bind a seal to a server-held secret
 * so that a verifier can distinguish a seal this system issued from one a
 * client fabricated.
 */
export async function hmacSha256(key: string | Uint8Array, message: string): Promise<string> {
  const rawKey = typeof key === 'string' ? encoder.encode(key) : key
  const imported = await subtle().importKey(
    'raw',
    toArrayBuffer(rawKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await subtle().sign('HMAC', imported, toArrayBuffer(encoder.encode(message)))
  return toHex(new Uint8Array(signature))
}

/**
 * Copies into a fresh buffer. A `Uint8Array` can be a view onto a larger
 * pool (which Node's Buffer usually is), so handing `.buffer` straight to
 * WebCrypto would hash neighbouring memory.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
