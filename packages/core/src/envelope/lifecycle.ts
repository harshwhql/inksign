import { InkSignError } from '../errors.js'
import type { EnvelopeStatus, RecipientStatus } from '../types.js'

/**
 * Allowed envelope transitions. Anything absent from this table is rejected,
 * which keeps a late webhook or a replayed request from resurrecting a
 * completed envelope.
 */
const ENVELOPE_TRANSITIONS: Readonly<Record<EnvelopeStatus, readonly EnvelopeStatus[]>> =
  Object.freeze({
    draft: ['sent', 'voided'],
    sent: ['delivered', 'partially_signed', 'completed', 'declined', 'voided', 'expired'],
    delivered: ['partially_signed', 'completed', 'declined', 'voided', 'expired'],
    partially_signed: ['partially_signed', 'completed', 'declined', 'voided', 'expired'],
    // Terminal states.
    completed: [],
    declined: [],
    voided: [],
    expired: [],
  })

const RECIPIENT_TRANSITIONS: Readonly<Record<RecipientStatus, readonly RecipientStatus[]>> =
  Object.freeze({
    created: ['sent', 'declined', 'delegated', 'auth_failed'],
    sent: ['delivered', 'declined', 'delegated', 'auth_failed'],
    delivered: ['signed', 'completed', 'declined', 'delegated', 'auth_failed'],
    signed: ['completed', 'declined'],
    auth_failed: ['sent', 'delivered', 'declined'],
    // Terminal states.
    completed: [],
    declined: [],
    delegated: [],
  })

export function canTransitionEnvelope(from: EnvelopeStatus, to: EnvelopeStatus): boolean {
  return ENVELOPE_TRANSITIONS[from].includes(to)
}

export function assertEnvelopeTransition(from: EnvelopeStatus, to: EnvelopeStatus): void {
  if (canTransitionEnvelope(from, to)) return
  throw new InkSignError(
    'INVALID_TRANSITION',
    `An envelope cannot move from ${from} to ${to}`,
    { from, to, allowed: ENVELOPE_TRANSITIONS[from] },
  )
}

export function canTransitionRecipient(from: RecipientStatus, to: RecipientStatus): boolean {
  return RECIPIENT_TRANSITIONS[from].includes(to)
}

export function assertRecipientTransition(from: RecipientStatus, to: RecipientStatus): void {
  if (canTransitionRecipient(from, to)) return
  throw new InkSignError(
    'INVALID_TRANSITION',
    `A recipient cannot move from ${from} to ${to}`,
    { from, to, allowed: RECIPIENT_TRANSITIONS[from] },
  )
}

const TERMINAL_ENVELOPE: ReadonlySet<EnvelopeStatus> = new Set<EnvelopeStatus>([
  'completed',
  'declined',
  'voided',
  'expired',
])

/** True when no further action can change the envelope. */
export function isTerminal(status: EnvelopeStatus): boolean {
  return TERMINAL_ENVELOPE.has(status)
}

/** True when recipients may still act on the envelope. */
export function isActionable(status: EnvelopeStatus): boolean {
  return status === 'sent' || status === 'delivered' || status === 'partially_signed'
}

export function assertActionable(status: EnvelopeStatus): void {
  if (isActionable(status)) return
  const code = status === 'expired' ? 'ENVELOPE_EXPIRED' : 'ENVELOPE_CLOSED'
  throw new InkSignError(code, `The envelope is ${status} and cannot accept input`, { status })
}

/**
 * Derives the envelope status from its recipients.
 *
 * Precedence is deliberate: one decline closes the envelope regardless of how
 * many others have already signed, because the agreement is not unanimous.
 */
export function deriveEnvelopeStatus(
  current: EnvelopeStatus,
  recipients: readonly { role: string; status: RecipientStatus }[],
): EnvelopeStatus {
  if (isTerminal(current)) return current
  if (current === 'draft') return 'draft'

  if (recipients.some((r) => r.status === 'declined')) return 'declined'

  // Carbon-copy and certified-delivery recipients never block completion.
  const actors = recipients.filter(
    (r) => r.role !== 'carbon_copy' && r.role !== 'certified_delivery',
  )
  if (actors.length === 0) return 'completed'

  const done = actors.filter((r) => r.status === 'completed' || r.status === 'signed')
  if (done.length === actors.length) return 'completed'
  if (done.length > 0) return 'partially_signed'

  if (recipients.some((r) => r.status === 'delivered')) return 'delivered'
  return current
}
