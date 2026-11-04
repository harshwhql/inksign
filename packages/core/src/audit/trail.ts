import { canonicalize, digestsEqual, sha256Text } from '../crypto/digest.js'
import { eventId } from '../id.js'
import type { DocumentId, EnvelopeId, FieldId, RecipientId, Timestamp } from '../types.js'

/** Things worth recording. Every entry in a trail carries one of these. */
export type AuditAction =
  | 'envelope_created'
  | 'envelope_sent'
  | 'envelope_completed'
  | 'envelope_voided'
  | 'envelope_expired'
  | 'document_added'
  | 'document_viewed'
  | 'document_downloaded'
  | 'document_printed'
  | 'recipient_added'
  | 'recipient_notified'
  | 'recipient_opened'
  | 'recipient_authenticated'
  | 'recipient_auth_failed'
  | 'consent_accepted'
  | 'consent_declined'
  | 'signature_adopted'
  | 'field_filled'
  | 'field_cleared'
  | 'recipient_signed'
  | 'recipient_declined'
  | 'recipient_delegated'
  | 'reminder_sent'
  | 'envelope_sealed'
  | 'seal_verified'

/**
 * Context captured alongside an action. Collected by the host application, not
 * the library: a browser cannot observe its own IP address, and guessing one
 * would put an unverifiable claim into a legal record.
 */
export interface AuditContext {
  ipAddress?: string
  userAgent?: string
  /** Geolocation, only when the recipient granted it. */
  location?: { latitude: number; longitude: number; accuracy?: number }
  timeZone?: string
  /** Opaque device or session identifier supplied by the host. */
  deviceId?: string
}

export interface AuditEntry {
  id: string
  action: AuditAction
  at: Timestamp
  envelopeId: EnvelopeId
  recipientId?: RecipientId
  documentId?: DocumentId
  fieldId?: FieldId
  /** Short human-readable summary, already localized by the caller. */
  summary?: string
  context?: AuditContext
  /** Action-specific detail. Never holds signature image data. */
  detail?: Readonly<Record<string, unknown>>
  /** Digest of the previous entry, or 64 zeros for the first. */
  previousHash: string
  /** Digest of this entry's content together with `previousHash`. */
  hash: string
}

export const GENESIS_HASH = '0'.repeat(64)

/** The part of an entry that gets hashed. `hash` itself is excluded. */
type HashableEntry = Omit<AuditEntry, 'hash'>

async function hashEntry(entry: HashableEntry): Promise<string> {
  return sha256Text(canonicalize(entry))
}

/**
 * An append-only, hash-chained log.
 *
 * Each entry commits to the one before it, so removing or editing any entry
 * invalidates every digest after it. That makes tampering detectable without a
 * trusted third party, though note what it does and does not prove: it shows
 * the log is internally consistent, not that it was not rewritten wholesale.
 * Pair it with `sealTrail` and a server-held secret for that.
 */
export class AuditTrail {
  private readonly entries: AuditEntry[] = []

  constructor(
    private readonly envelopeId: EnvelopeId,
    existing: readonly AuditEntry[] = [],
  ) {
    this.entries.push(...existing)
  }

  /** Appends an entry and returns it, with the chain digests filled in. */
  async append(input: AuditInput): Promise<AuditEntry> {
    const previous = this.entries[this.entries.length - 1]
    const previousHash = previous ? previous.hash : GENESIS_HASH

    const hashable: HashableEntry = {
      id: eventId(),
      action: input.action,
      at: input.at ?? Date.now(),
      envelopeId: this.envelopeId,
      previousHash,
      ...(input.recipientId !== undefined ? { recipientId: input.recipientId } : {}),
      ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
      ...(input.fieldId !== undefined ? { fieldId: input.fieldId } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    }

    const entry: AuditEntry = { ...hashable, hash: await hashEntry(hashable) }
    this.entries.push(entry)
    return entry
  }

  /** Entries in order, oldest first. */
  list(): readonly AuditEntry[] {
    return this.entries
  }

  get length(): number {
    return this.entries.length
  }

  /** Digest of the most recent entry, which commits to the whole chain. */
  get head(): string {
    const last = this.entries[this.entries.length - 1]
    return last ? last.hash : GENESIS_HASH
  }

  filter(predicate: (entry: AuditEntry) => boolean): readonly AuditEntry[] {
    return this.entries.filter(predicate)
  }

  forRecipient(id: RecipientId): readonly AuditEntry[] {
    return this.entries.filter((entry) => entry.recipientId === id)
  }

  /** Recomputes every digest and reports the first entry that does not match. */
  async verify(): Promise<TrailVerification> {
    return verifyTrail(this.entries)
  }

  toJSON(): readonly AuditEntry[] {
    return this.entries
  }
}

export interface AuditInput {
  action: AuditAction
  at?: Timestamp
  recipientId?: RecipientId
  documentId?: DocumentId
  fieldId?: FieldId
  summary?: string
  context?: AuditContext
  detail?: Readonly<Record<string, unknown>>
}

export interface TrailVerification {
  valid: boolean
  /** Index of the first bad entry, or `undefined` when the chain is intact. */
  brokenAt?: number
  reason?: 'hash_mismatch' | 'broken_link' | 'empty'
  /** Digest of the last entry, when the chain is intact. */
  head?: string
}

/**
 * Verifies a chain independently of the class, so a server or an auditor can
 * check a trail it loaded from storage.
 */
export async function verifyTrail(entries: readonly AuditEntry[]): Promise<TrailVerification> {
  if (entries.length === 0) return { valid: true, reason: 'empty', head: GENESIS_HASH }

  let previousHash = GENESIS_HASH
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] as AuditEntry

    if (!digestsEqual(entry.previousHash, previousHash)) {
      return { valid: false, brokenAt: i, reason: 'broken_link' }
    }

    const { hash, ...hashable } = entry
    const recomputed = await hashEntry(hashable)
    if (!digestsEqual(recomputed, hash)) {
      return { valid: false, brokenAt: i, reason: 'hash_mismatch' }
    }

    previousHash = entry.hash
  }

  return { valid: true, head: previousHash }
}
