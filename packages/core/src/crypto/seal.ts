import { type AuditEntry, GENESIS_HASH, verifyTrail } from '../audit/trail.js'
import { InkSignError } from '../errors.js'
import type { Envelope, EnvelopeId, Timestamp } from '../types.js'
import { canonicalize, digestsEqual, hmacSha256, sha256, sha256Json, sha256Text } from './digest.js'

/**
 * A seal binds together the finished documents, the values that were applied,
 * and the audit trail, under a single digest.
 *
 * What it proves and what it does not is worth being precise about, because
 * the difference matters if a signature is ever challenged:
 *
 * - It proves the sealed artefacts have not changed since the seal was made.
 *   Alter a byte of the PDF or an entry of the trail and verification fails.
 * - With `secret` supplied, it also proves the seal was issued by a holder of
 *   that secret, so a client cannot fabricate one. Keep the secret on a
 *   server. A secret shipped to the browser proves nothing.
 * - It does not prove when the seal was made. A local clock is not evidence.
 *   Supply `timestamp` from an RFC 3161 authority through the clock adapter
 *   when the signing time has to stand up on its own.
 * - It is not a PKI digital signature and makes no claim to be one. There is
 *   no certificate chain and no identity bound by a certificate authority. For
 *   PAdES or similar, seal with this and then have a qualified service apply
 *   the certified signature over the result.
 */
export interface Seal {
  /** Seal format version, so a verifier can reject what it does not know. */
  version: 1
  envelopeId: EnvelopeId
  /** When the seal was created, from the configured clock. */
  sealedAt: Timestamp
  /** Digest of the envelope's structure: documents, recipients and fields. */
  envelopeDigest: string
  /** Digest of every captured value, in canonical form. */
  valuesDigest: string
  /** Digest of the final document bytes, keyed by document ID. */
  documentDigests: Readonly<Record<string, string>>
  /** Head of the audit chain at the moment of sealing. */
  trailHead: string
  /** Number of audit entries covered, so truncation is detectable. */
  trailLength: number
  /** Digest over all of the above. This is the value to publish. */
  digest: string
  /** HMAC of `digest` under the issuer's secret, when one was supplied. */
  issuerSignature?: string
  /** Trusted timestamp token, when one was obtained. */
  timestampToken?: string
  timestampAuthority?: string
}

export interface SealInput {
  envelope: Envelope
  /** Captured values, as field ID to value. */
  values: Readonly<Record<string, unknown>>
  /** Final document bytes after fields were flattened in. */
  documents: readonly { id: string; bytes: Uint8Array }[]
  trail: readonly AuditEntry[]
  sealedAt?: Timestamp
  /** Server-held secret. Omit only when the seal stays inside one trust zone. */
  secret?: string | Uint8Array
  timestamp?: { token: string; authority: string; at: number }
}

/**
 * The structural part of an envelope, excluding timestamps that change on
 * every save. Sealing `updatedAt` would make the digest unstable for reasons
 * that have nothing to do with the agreement.
 */
function sealableEnvelope(envelope: Envelope): Record<string, unknown> {
  return {
    id: envelope.id,
    subject: envelope.subject,
    message: envelope.message,
    settings: envelope.settings,
    documents: envelope.documents.map((document) => ({
      id: document.id,
      name: document.name,
      pageCount: document.pageCount,
      digest: document.digest,
    })),
    recipients: envelope.recipients.map((recipient) => ({
      id: recipient.id,
      role: recipient.role,
      name: recipient.name,
      email: recipient.email,
      routingOrder: recipient.routingOrder,
      status: recipient.status,
      completedAt: recipient.completedAt,
    })),
    fields: envelope.fields.map((field) => ({
      id: field.id,
      documentId: field.documentId,
      recipientId: field.recipientId,
      type: field.type,
      rect: field.rect,
      label: field.label,
      validation: field.validation,
    })),
  }
}

/** Produces a seal over a completed envelope. */
export async function seal(input: SealInput): Promise<Seal> {
  const { envelope, values, documents, trail } = input

  const trailCheck = await verifyTrail(trail)
  if (!trailCheck.valid) {
    throw new InkSignError(
      'SEAL_INVALID',
      `Cannot seal an envelope whose audit trail is broken at entry ${trailCheck.brokenAt}`,
      { brokenAt: trailCheck.brokenAt, reason: trailCheck.reason },
    )
  }

  const documentDigests: Record<string, string> = {}
  for (const document of documents) {
    documentDigests[document.id] = await sha256(document.bytes)
  }

  const envelopeDigest = await sha256Json(sealableEnvelope(envelope))
  const valuesDigest = await sha256Json(values)
  const trailHead = trailCheck.head ?? GENESIS_HASH

  const body = {
    version: 1 as const,
    envelopeId: envelope.id,
    sealedAt: input.sealedAt ?? Date.now(),
    envelopeDigest,
    valuesDigest,
    documentDigests,
    trailHead,
    trailLength: trail.length,
  }

  const digest = await sha256Text(canonicalize(body))

  const result: Seal = { ...body, digest }

  if (input.secret !== undefined) {
    result.issuerSignature = await hmacSha256(input.secret, digest)
  }
  if (input.timestamp) {
    result.timestampToken = input.timestamp.token
    result.timestampAuthority = input.timestamp.authority
  }

  return result
}

export interface SealVerification {
  valid: boolean
  /** Which checks passed. Present even when `valid` is false, to localize the fault. */
  checks: {
    digest: boolean
    envelope: boolean
    values: boolean
    documents: boolean
    trail: boolean
    issuer: boolean | 'not_checked'
  }
  /** Documents whose bytes do not match the seal. */
  mismatchedDocuments: readonly string[]
  reason?: string
}

/**
 * Verifies a seal against the artefacts it covers.
 *
 * Every check runs even after one fails, so the report says exactly what was
 * tampered with rather than stopping at the first problem.
 */
export async function verifySeal(
  sealed: Seal,
  input: Omit<SealInput, 'sealedAt' | 'timestamp'>,
): Promise<SealVerification> {
  if (sealed.version !== 1) {
    throw new InkSignError('SEAL_INVALID', `Unsupported seal version ${sealed.version}`, {
      version: sealed.version,
    })
  }

  const body = {
    version: sealed.version,
    envelopeId: sealed.envelopeId,
    sealedAt: sealed.sealedAt,
    envelopeDigest: sealed.envelopeDigest,
    valuesDigest: sealed.valuesDigest,
    documentDigests: sealed.documentDigests,
    trailHead: sealed.trailHead,
    trailLength: sealed.trailLength,
  }

  const recomputed = await sha256Text(canonicalize(body))
  const digestOk = digestsEqual(recomputed, sealed.digest)

  const envelopeOk = digestsEqual(
    await sha256Json(sealableEnvelope(input.envelope)),
    sealed.envelopeDigest,
  )
  const valuesOk = digestsEqual(await sha256Json(input.values), sealed.valuesDigest)

  const mismatched: string[] = []
  for (const document of input.documents) {
    const expected = sealed.documentDigests[document.id]
    const actual = await sha256(document.bytes)
    if (expected === undefined || !digestsEqual(expected, actual)) mismatched.push(document.id)
  }
  const sealedIds = Object.keys(sealed.documentDigests)
  const documentsOk = mismatched.length === 0 && sealedIds.length === input.documents.length

  const trailCheck = await verifyTrail(input.trail)
  const trailOk =
    trailCheck.valid &&
    input.trail.length === sealed.trailLength &&
    digestsEqual(trailCheck.head ?? GENESIS_HASH, sealed.trailHead)

  let issuerOk: boolean | 'not_checked' = 'not_checked'
  if (input.secret !== undefined) {
    if (sealed.issuerSignature === undefined) {
      issuerOk = false
    } else {
      const expected = await hmacSha256(input.secret, sealed.digest)
      issuerOk = digestsEqual(expected, sealed.issuerSignature)
    }
  }

  const checks = {
    digest: digestOk,
    envelope: envelopeOk,
    values: valuesOk,
    documents: documentsOk,
    trail: trailOk,
    issuer: issuerOk,
  }

  const valid = digestOk && envelopeOk && valuesOk && documentsOk && trailOk && issuerOk !== false

  return {
    valid,
    checks,
    mismatchedDocuments: mismatched,
    ...(valid ? {} : { reason: explain(checks, mismatched) }),
  }
}

function explain(checks: SealVerification['checks'], mismatched: readonly string[]): string {
  if (!checks.digest) return 'The seal digest does not match its contents, so the seal was altered'
  if (!checks.envelope) return 'The envelope structure changed after it was sealed'
  if (!checks.values) return 'The captured field values changed after they were sealed'
  if (!checks.documents) {
    return mismatched.length > 0
      ? `Document bytes changed after sealing: ${mismatched.join(', ')}`
      : 'The set of sealed documents does not match'
  }
  if (!checks.trail) return 'The audit trail was altered or truncated after sealing'
  if (checks.issuer === false) return 'The issuer signature is missing or does not match'
  return 'Verification failed'
}
