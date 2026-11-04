import { describe, expect, it } from 'vitest'
import { canRecipientAct, delegate, resolveRouting } from '../src/index.js'
import type { Recipient, RecipientRole, RecipientStatus } from '../src/index.js'

let counter = 0
function person(
  role: RecipientRole,
  routingOrder: number,
  status: RecipientStatus = 'sent',
  extra: Partial<Recipient> = {},
): Recipient {
  counter += 1
  return {
    id: `r${counter}`,
    role,
    name: `Person ${counter}`,
    email: `p${counter}@example.com`,
    routingOrder,
    status,
    ...extra,
  }
}

describe('routing', () => {
  it('opens only the first stage when signing is sequential', () => {
    const first = person('signer', 1)
    const second = person('signer', 2)
    const plan = resolveRouting([first, second])

    expect(plan.activeOrder).toBe(1)
    expect(plan.actionable).toEqual([first.id])
    expect(plan.notified).toEqual([first.id])
  })

  it('opens every recipient sharing a routing order', () => {
    const a = person('signer', 1)
    const b = person('signer', 1)
    const plan = resolveRouting([a, b])

    expect(plan.actionable).toHaveLength(2)
    expect(plan.stages).toHaveLength(1)
  })

  it('advances to the next stage once the first completes', () => {
    const first = person('signer', 1, 'completed')
    const second = person('signer', 2)
    const plan = resolveRouting([first, second])

    expect(plan.activeOrder).toBe(2)
    expect(plan.actionable).toEqual([second.id])
    // Both stages have now been notified.
    expect(plan.notified).toContain(first.id)
    expect(plan.notified).toContain(second.id)
  })

  it('does not let a carbon copy hold up the next stage', () => {
    const signer = person('signer', 1, 'completed')
    const cc = person('carbon_copy', 1, 'sent')
    const next = person('signer', 2)
    const plan = resolveRouting([signer, cc, next])

    expect(plan.activeOrder).toBe(2)
    expect(plan.actionable).toEqual([next.id])
  })

  it('reports no active stage once everyone has finished', () => {
    const plan = resolveRouting([person('signer', 1, 'completed'), person('signer', 2, 'completed')])
    expect(plan.activeOrder).toBeUndefined()
    expect(plan.actionable).toEqual([])
  })

  it('satisfies a signing group when any one member acts', () => {
    const a = person('signer', 1, 'completed', { groupId: 'legal' })
    const b = person('signer', 1, 'sent', { groupId: 'legal' })
    const plan = resolveRouting([a, b])

    // The group is satisfied, so the remaining member is no longer actionable.
    expect(plan.actionable).not.toContain(b.id)
  })

  it('holds a witness until the recipient they attest for has signed', () => {
    const signer = person('signer', 1, 'sent')
    const witness = person('witness', 1, 'sent', { attestsFor: signer.id })

    const before = resolveRouting([signer, witness])
    expect(before.actionable).toEqual([signer.id])

    const after = resolveRouting([{ ...signer, status: 'completed' }, witness])
    expect(after.actionable).toEqual([witness.id])
  })

  it('blocks a recipient whose authentication failed', () => {
    const signer = person('signer', 1, 'auth_failed')
    expect(canRecipientAct(signer.id, [signer])).toBe(false)
  })

  it('handles an empty recipient list', () => {
    const plan = resolveRouting([])
    expect(plan.stages).toEqual([])
    expect(plan.activeOrder).toBeUndefined()
  })
})

describe('delegation', () => {
  it('keeps the original recipient in the list, marked delegated', () => {
    const original = person('signer', 1, 'delivered')
    const result = delegate([original], original.id, {
      id: 'r-new',
      name: 'Deputy',
      email: 'deputy@example.com',
    })

    expect(result).toHaveLength(2)
    expect(result[0]?.status).toBe('delegated')
    expect(result[1]?.name).toBe('Deputy')
    expect(result[1]?.delegatedBy).toBe(original.id)
    // The replacement inherits the turn, not a new one at the end.
    expect(result[1]?.routingOrder).toBe(original.routingOrder)
  })

  it('carries the authentication requirement to the delegate', () => {
    const original = person('signer', 1, 'delivered', { auth: { kind: 'access_code' } })
    const result = delegate([original], original.id, { id: 'r-new', name: 'Deputy' })
    expect(result[1]?.auth).toEqual({ kind: 'access_code' })
  })

  it('leaves the list untouched when the recipient is unknown', () => {
    const original = person('signer', 1)
    const result = delegate([original], 'nobody', { id: 'x', name: 'X' })
    expect(result).toHaveLength(1)
  })

  it('makes the delegate actionable in place of the original', () => {
    const original = person('signer', 1, 'delivered')
    const next = person('signer', 2)
    const result = delegate([original, next], original.id, { id: 'r-new', name: 'Deputy' })

    const plan = resolveRouting(result)
    expect(plan.activeOrder).toBe(1)
    expect(plan.actionable).toEqual(['r-new'])
  })
})
