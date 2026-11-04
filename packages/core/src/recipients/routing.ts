import type { Recipient, RecipientId, RecipientRole } from '../types.js'

/** Roles that must take an action before routing can advance. */
const BLOCKING_ROLES: ReadonlySet<RecipientRole> = new Set<RecipientRole>([
  'signer',
  'in_person_signer',
  'approver',
  'editor',
  'intermediary',
  'agent',
  'witness',
  'notary',
])

/** Roles that only receive the document. */
const PASSIVE_ROLES: ReadonlySet<RecipientRole> = new Set<RecipientRole>([
  'carbon_copy',
  'certified_delivery',
])

export function isBlockingRole(role: RecipientRole): boolean {
  return BLOCKING_ROLES.has(role)
}

export function isPassiveRole(role: RecipientRole): boolean {
  return PASSIVE_ROLES.has(role)
}

function isFinished(recipient: Recipient): boolean {
  return (
    recipient.status === 'completed' ||
    recipient.status === 'signed' ||
    recipient.status === 'delegated' ||
    recipient.status === 'declined'
  )
}

/** One rung of the routing ladder. Everyone in a stage acts in parallel. */
export interface RoutingStage {
  routingOrder: number
  recipientIds: readonly RecipientId[]
  /** Stage has no outstanding blocking recipient. */
  complete: boolean
}

export interface RoutingPlan {
  stages: readonly RoutingStage[]
  /** Routing order of the stage currently able to act, or `undefined` when done. */
  activeOrder: number | undefined
  /** Recipients who may act right now. */
  actionable: readonly RecipientId[]
  /** Recipients who should have received the document by now. */
  notified: readonly RecipientId[]
}

/**
 * Resolves who can act, given the recipients and their current statuses.
 *
 * Routing works in stages: recipients sharing a `routingOrder` act in
 * parallel, and the next stage opens only once every blocking recipient in the
 * current stage has finished. Three refinements sit on top:
 *
 * - Passive recipients (carbon copy, certified delivery) are notified when
 *   their stage opens but never hold it up.
 * - A signing group is satisfied by any one of its members, so the rest become
 *   non-actionable as soon as one acts.
 * - A witness or notary cannot act before the recipient they attest for, even
 *   when they share a routing order.
 */
export function resolveRouting(recipients: readonly Recipient[]): RoutingPlan {
  if (recipients.length === 0) {
    return { stages: [], activeOrder: undefined, actionable: [], notified: [] }
  }

  const byOrder = new Map<number, Recipient[]>()
  for (const recipient of recipients) {
    const bucket = byOrder.get(recipient.routingOrder)
    if (bucket) bucket.push(recipient)
    else byOrder.set(recipient.routingOrder, [recipient])
  }

  const orders = Array.from(byOrder.keys()).sort((a, b) => a - b)
  const stages: RoutingStage[] = []
  const notified: RecipientId[] = []
  let activeOrder: number | undefined
  let actionable: readonly RecipientId[] = []

  // Groups already satisfied by a member who acted.
  const satisfiedGroups = new Set<string>()
  for (const recipient of recipients) {
    if (recipient.groupId && isFinished(recipient)) satisfiedGroups.add(recipient.groupId)
  }

  for (const order of orders) {
    const stageRecipients = byOrder.get(order) as Recipient[]
    const blocking = stageRecipients.filter((r) => isBlockingRole(r.role))
    const complete = blocking.every(isFinished)

    stages.push({
      routingOrder: order,
      recipientIds: stageRecipients.map((r) => r.id),
      complete,
    })

    // Every stage up to and including the active one has been notified.
    if (activeOrder === undefined) {
      for (const recipient of stageRecipients) notified.push(recipient.id)
    }

    if (activeOrder === undefined && !complete) {
      activeOrder = order
      actionable = stageRecipients
        .filter((r) => canActInStage(r, recipients, satisfiedGroups))
        .map((r) => r.id)
    }
  }

  return { stages, activeOrder, actionable, notified }
}

function canActInStage(
  recipient: Recipient,
  all: readonly Recipient[],
  satisfiedGroups: ReadonlySet<string>,
): boolean {
  if (!isBlockingRole(recipient.role)) return false
  if (isFinished(recipient)) return false
  if (recipient.status === 'auth_failed') return false

  // Another member of the group already acted for everyone.
  if (recipient.groupId && satisfiedGroups.has(recipient.groupId)) return false

  // Attestation roles wait for their principal, even within the same stage.
  if (recipient.attestsFor !== undefined) {
    const principal = all.find((r) => r.id === recipient.attestsFor)
    if (principal && !isFinished(principal)) return false
  }

  return true
}

/** True when this recipient may act right now. */
export function canRecipientAct(
  recipientId: RecipientId,
  recipients: readonly Recipient[],
): boolean {
  return resolveRouting(recipients).actionable.includes(recipientId)
}

/**
 * Recipients to notify on the next dispatch: those in the active stage who
 * have not yet been sent the envelope.
 */
export function pendingNotifications(recipients: readonly Recipient[]): readonly RecipientId[] {
  const plan = resolveRouting(recipients)
  const byId = new Map(recipients.map((r) => [r.id, r]))
  return plan.notified.filter((id) => byId.get(id)?.status === 'created')
}

/**
 * Reassigns a recipient's turn to a new person, as used by delegation and by
 * the intermediary and agent roles.
 *
 * The original recipient is marked `delegated` rather than removed, so the
 * audit trail keeps the full chain of who passed the envelope to whom.
 */
export function delegate(
  recipients: readonly Recipient[],
  from: RecipientId,
  to: { id: RecipientId; name: string; email?: string; phone?: string },
): readonly Recipient[] {
  const original = recipients.find((r) => r.id === from)
  if (!original) return recipients

  const replacement: Recipient = {
    id: to.id,
    role: original.role,
    name: to.name,
    routingOrder: original.routingOrder,
    status: 'created',
    delegatedBy: from,
    ...(to.email !== undefined ? { email: to.email } : {}),
    ...(to.phone !== undefined ? { phone: to.phone } : {}),
    ...(original.auth !== undefined ? { auth: original.auth } : {}),
    ...(original.groupId !== undefined ? { groupId: original.groupId } : {}),
    ...(original.attestsFor !== undefined ? { attestsFor: original.attestsFor } : {}),
  }

  const out: Recipient[] = []
  for (const recipient of recipients) {
    if (recipient.id === from) {
      out.push({ ...recipient, status: 'delegated' })
      out.push(replacement)
    } else {
      out.push(recipient)
    }
  }
  return out
}
