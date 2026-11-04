/**
 * Identifier generation with no runtime dependencies.
 *
 * IDs are lexicographically sortable by creation time, which keeps lists in a
 * stable order without a separate sort key and makes index locality good when
 * they are used as database keys.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RANDOM_LENGTH = 16
const TIME_LENGTH = 10

type RandomSource = (bytes: Uint8Array) => void

const randomSource: RandomSource = resolveRandomSource()

function resolveRandomSource(): RandomSource {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto
  if (globalCrypto && typeof globalCrypto.getRandomValues === 'function') {
    return (bytes) => {
      globalCrypto.getRandomValues(bytes)
    }
  }
  // Deterministic fallback for exotic runtimes without WebCrypto. IDs stay
  // unique enough for in-memory use, but production runtimes all expose
  // getRandomValues, so this path is effectively unreachable in the browser
  // and on Node 18 or later.
  return (bytes) => {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = (Math.random() * 256) | 0
    }
  }
}

function encodeTime(time: number): string {
  let remaining = time
  let out = ''
  for (let i = TIME_LENGTH - 1; i >= 0; i -= 1) {
    const mod = remaining % 32
    out = ALPHABET[mod] + out
    remaining = (remaining - mod) / 32
  }
  return out
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LENGTH)
  randomSource(bytes)
  let out = ''
  for (let i = 0; i < RANDOM_LENGTH; i += 1) {
    // Non-null: the loop bound equals the array length.
    out += ALPHABET[(bytes[i] as number) % 32]
  }
  return out
}

/**
 * Creates a 26-character sortable identifier, optionally namespaced.
 *
 * @param prefix Short tag such as `env` or `fld`, joined with an underscore.
 */
export function createId(prefix?: string): string {
  const id = encodeTime(Date.now()) + encodeRandom()
  return prefix ? `${prefix}_${id}` : id
}

export const envelopeId = (): string => createId('env')
export const documentId = (): string => createId('doc')
export const recipientId = (): string => createId('rcp')
export const fieldId = (): string => createId('fld')
export const sessionId = (): string => createId('ses')
export const eventId = (): string => createId('evt')

/**
 * Extracts the creation time encoded in an ID, or `undefined` when the value
 * was not produced by `createId`.
 */
export function idCreatedAt(id: string): number | undefined {
  const body = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id
  if (body.length !== TIME_LENGTH + RANDOM_LENGTH) return undefined
  let time = 0
  for (let i = 0; i < TIME_LENGTH; i += 1) {
    const index = ALPHABET.indexOf(body[i] as string)
    if (index < 0) return undefined
    time = time * 32 + index
  }
  return time
}
