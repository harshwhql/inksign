import { describe, expect, it } from 'vitest'
import {
  AuditTrail,
  GENESIS_HASH,
  canonicalize,
  createEnvelope,
  digestsEqual,
  seal,
  sha256Text,
  verifySeal,
  verifyTrail,
} from '../src/index.js'
import type { AuditEntry, Envelope } from '../src/index.js'

const pdf = { kind: 'url' as const, url: 'https://example.com/a.pdf' }

function envelope(): Envelope {
  return createEnvelope({ subject: 'Sealed agreement' })
    .document('d', { name: 'd.pdf', source: pdf, pageCount: 1 })
    .signer('alice', { name: 'Alice', email: 'alice@example.com' })
    .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 600 })
    .build()
}

async function populatedTrail(id: string): Promise<AuditTrail> {
  const trail = new AuditTrail(id)
  await trail.append({ action: 'envelope_created' })
  await trail.append({ action: 'envelope_sent' })
  await trail.append({ action: 'recipient_opened', recipientId: 'r1' })
  await trail.append({ action: 'recipient_signed', recipientId: 'r1' })
  return trail
}

describe('audit trail', () => {
  it('chains the first entry to the genesis hash', async () => {
    const trail = new AuditTrail('env_1')
    const entry = await trail.append({ action: 'envelope_created' })
    expect(entry.previousHash).toBe(GENESIS_HASH)
    expect(entry.hash).toHaveLength(64)
  })

  it('links each entry to the one before it', async () => {
    const trail = await populatedTrail('env_1')
    const entries = trail.list()

    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]?.previousHash).toBe(entries[i - 1]?.hash)
    }
  })

  it('verifies an intact chain', async () => {
    const trail = await populatedTrail('env_1')
    const result = await trail.verify()
    expect(result.valid).toBe(true)
    expect(result.head).toBe(trail.head)
  })

  it('detects an edited entry', async () => {
    const trail = await populatedTrail('env_1')
    const entries = [...trail.list()] as AuditEntry[]

    // Change the recipient on an entry, keeping its stored hash.
    entries[2] = { ...(entries[2] as AuditEntry), recipientId: 'someone_else' }

    const result = await verifyTrail(entries)
    expect(result.valid).toBe(false)
    expect(result.brokenAt).toBe(2)
    expect(result.reason).toBe('hash_mismatch')
  })

  it('detects a removed entry', async () => {
    const trail = await populatedTrail('env_1')
    const entries = [...trail.list()] as AuditEntry[]
    entries.splice(1, 1)

    const result = await verifyTrail(entries)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('broken_link')
  })

  it('detects a reordered chain', async () => {
    const trail = await populatedTrail('env_1')
    const entries = [...trail.list()] as AuditEntry[]
    const [a, b] = [entries[1] as AuditEntry, entries[2] as AuditEntry]
    entries[1] = b
    entries[2] = a

    const result = await verifyTrail(entries)
    expect(result.valid).toBe(false)
  })

  it('treats an empty trail as valid', async () => {
    const result = await verifyTrail([])
    expect(result.valid).toBe(true)
    expect(result.reason).toBe('empty')
  })

  it('filters entries by recipient', async () => {
    const trail = await populatedTrail('env_1')
    expect(trail.forRecipient('r1')).toHaveLength(2)
    expect(trail.forRecipient('r2')).toHaveLength(0)
  })
})

describe('canonical serialization', () => {
  it('ignores key order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }))
  })

  it('preserves array order, which is meaningful', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]))
  })

  it('drops undefined values so an absent key and an undefined one agree', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }))
  })

  it('produces the same digest for structurally equal objects', async () => {
    const left = await sha256Text(canonicalize({ x: [1, { y: 2 }], z: 'a' }))
    const right = await sha256Text(canonicalize({ z: 'a', x: [1, { y: 2 }] }))
    expect(digestsEqual(left, right)).toBe(true)
  })

  it('rejects non-finite numbers rather than serializing them as null', () => {
    expect(() => canonicalize({ x: Number.POSITIVE_INFINITY })).toThrowError(/non-finite/u)
  })
})

describe('sealing', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5])

  async function sealed(secret?: string) {
    const env = envelope()
    const trail = await populatedTrail(env.id)
    const values = { [env.fields[0]?.id ?? 'f']: { kind: 'ink', source: 'drawn' } }
    const documents = [{ id: env.documents[0]?.id ?? 'd', bytes }]

    const result = await seal({
      envelope: env,
      values,
      documents,
      trail: trail.list(),
      ...(secret !== undefined ? { secret } : {}),
    })
    return { env, trail, values, documents, result }
  }

  it('produces a digest over every artefact', async () => {
    const { result } = await sealed()
    expect(result.version).toBe(1)
    expect(result.digest).toHaveLength(64)
    expect(result.trailLength).toBe(4)
    expect(Object.keys(result.documentDigests)).toHaveLength(1)
  })

  it('verifies against unchanged artefacts', async () => {
    const { env, trail, values, documents, result } = await sealed()
    const check = await verifySeal(result, {
      envelope: env,
      values,
      documents,
      trail: trail.list(),
    })

    expect(check.valid).toBe(true)
    expect(check.checks.documents).toBe(true)
    expect(check.checks.issuer).toBe('not_checked')
  })

  it('detects altered document bytes and names the document', async () => {
    const { env, trail, values, documents, result } = await sealed()
    const tampered = [{ id: documents[0]?.id ?? 'd', bytes: new Uint8Array([9, 9, 9]) }]

    const check = await verifySeal(result, {
      envelope: env,
      values,
      documents: tampered,
      trail: trail.list(),
    })

    expect(check.valid).toBe(false)
    expect(check.checks.documents).toBe(false)
    expect(check.mismatchedDocuments).toEqual([documents[0]?.id])
    expect(check.reason).toMatch(/Document bytes changed/u)
  })

  it('detects altered field values', async () => {
    const { env, trail, documents, result } = await sealed()
    const check = await verifySeal(result, {
      envelope: env,
      values: { tampered: true },
      documents,
      trail: trail.list(),
    })

    expect(check.valid).toBe(false)
    expect(check.checks.values).toBe(false)
  })

  it('detects a truncated audit trail', async () => {
    const { env, trail, values, documents, result } = await sealed()
    const check = await verifySeal(result, {
      envelope: env,
      values,
      documents,
      trail: trail.list().slice(0, 3),
    })

    expect(check.valid).toBe(false)
    expect(check.checks.trail).toBe(false)
    expect(check.reason).toMatch(/altered or truncated/u)
  })

  it('detects a changed envelope structure', async () => {
    const { env, trail, values, documents, result } = await sealed()
    const mutated: Envelope = { ...env, subject: 'Something else' }

    const check = await verifySeal(result, {
      envelope: mutated,
      values,
      documents,
      trail: trail.list(),
    })

    expect(check.valid).toBe(false)
    expect(check.checks.envelope).toBe(false)
  })

  it('ignores updatedAt, which changes for reasons unrelated to the agreement', async () => {
    const { env, trail, values, documents, result } = await sealed()
    const resaved: Envelope = { ...env, updatedAt: env.updatedAt + 60_000 }

    const check = await verifySeal(result, {
      envelope: resaved,
      values,
      documents,
      trail: trail.list(),
    })

    expect(check.valid).toBe(true)
  })

  it('binds the seal to an issuer secret', async () => {
    const { env, trail, values, documents, result } = await sealed('server-held-secret')
    expect(result.issuerSignature).toHaveLength(64)

    const good = await verifySeal(result, {
      envelope: env,
      values,
      documents,
      trail: trail.list(),
      secret: 'server-held-secret',
    })
    expect(good.valid).toBe(true)
    expect(good.checks.issuer).toBe(true)

    const bad = await verifySeal(result, {
      envelope: env,
      values,
      documents,
      trail: trail.list(),
      secret: 'wrong-secret',
    })
    expect(bad.valid).toBe(false)
    expect(bad.checks.issuer).toBe(false)
  })

  it('refuses to seal over a broken audit trail', async () => {
    const env = envelope()
    const trail = await populatedTrail(env.id)
    const entries = [...trail.list()] as AuditEntry[]
    entries[1] = { ...(entries[1] as AuditEntry), action: 'envelope_voided' }

    await expect(
      seal({ envelope: env, values: {}, documents: [], trail: entries }),
    ).rejects.toThrowError(/audit trail is broken/u)
  })

  it('rejects an unknown seal version', async () => {
    const { env, trail, values, documents, result } = await sealed()
    await expect(
      verifySeal({ ...result, version: 2 as unknown as 1 }, {
        envelope: env,
        values,
        documents,
        trail: trail.list(),
      }),
    ).rejects.toThrowError(/Unsupported seal version/u)
  })
})
