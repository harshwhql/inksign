import { describe, expect, it } from 'vitest'
import type { Envelope } from '../src/index.js'
import {
  canTransitionEnvelope,
  createEnvelope,
  deriveEnvelopeStatus,
  InkSignError,
  isTerminal,
  validateEnvelope,
} from '../src/index.js'

const pdf = { kind: 'url' as const, url: 'https://example.com/nda.pdf' }

function baseEnvelope() {
  return createEnvelope({ subject: 'Mutual NDA' })
    .document('nda', { name: 'NDA.pdf', source: pdf, pageCount: 2 })
    .signer('alice', { name: 'Alice Chen', email: 'alice@example.com' })
    .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 640, required: true })
}

describe('envelope builder', () => {
  it('resolves aliases to generated ids', () => {
    const envelope = baseEnvelope().build()

    expect(envelope.documents).toHaveLength(1)
    expect(envelope.recipients).toHaveLength(1)
    expect(envelope.fields).toHaveLength(1)

    const field = envelope.fields[0]
    expect(field?.documentId).toBe(envelope.documents[0]?.id)
    expect(field?.recipientId).toBe(envelope.recipients[0]?.id)
  })

  it('assigns sequential routing orders in the order recipients were added', () => {
    const envelope = createEnvelope({ subject: 'Sequential' })
      .document('d', { name: 'd.pdf', source: pdf })
      .signer('first', { name: 'First', email: 'first@example.com' })
      .signer('second', { name: 'Second', email: 'second@example.com' })
      .field({ recipient: 'first', type: 'signature' })
      .field({ recipient: 'second', type: 'signature' })
      .build()

    expect(envelope.recipients.map((r) => r.routingOrder)).toEqual([1, 2])
  })

  it('rejects a field assigned to an unknown recipient alias', () => {
    const builder = createEnvelope({ subject: 'Typo' })
      .document('d', { name: 'd.pdf', source: pdf })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .field({ recipient: 'alise', type: 'signature' })

    expect(() => builder.build()).toThrowError(InkSignError)
    try {
      builder.build()
    } catch (error) {
      expect((error as InkSignError).code).toBe('UNKNOWN_RECIPIENT')
      // The message should name the typo and list what was available.
      expect((error as InkSignError).message).toContain('alise')
    }
  })

  it('requires an explicit document when more than one exists', () => {
    const builder = createEnvelope({ subject: 'Two docs' })
      .document('a', { name: 'a.pdf', source: pdf })
      .document('b', { name: 'b.pdf', source: pdf })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .field({ recipient: 'alice', type: 'signature' })

    expect(() => builder.build()).toThrowError(/must name a document/u)
  })

  it('rejects duplicate aliases', () => {
    expect(() =>
      createEnvelope({ subject: 'Dupes' })
        .document('d', { name: 'a.pdf', source: pdf })
        .document('d', { name: 'b.pdf', source: pdf }),
    ).toThrowError(/Duplicate document alias/u)
  })

  it('maps showWhen aliases to field ids', () => {
    const envelope = createEnvelope({ subject: 'Conditional' })
      .document('d', { name: 'd.pdf', source: pdf })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .field({ alias: 'hasAgent', recipient: 'alice', type: 'checkbox', page: 0, x: 72, y: 100 })
      .field({
        alias: 'agentName',
        recipient: 'alice',
        type: 'text',
        page: 0,
        x: 72,
        y: 140,
        showWhen: [{ field: 'hasAgent', operator: 'equals', value: true }],
      })
      .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 600 })
      .build()

    const agentName = envelope.fields.find((f) => f.label === undefined && f.type === 'text')
    const checkbox = envelope.fields.find((f) => f.type === 'checkbox')
    expect(agentName?.conditions?.[0]?.whenField).toBe(checkbox?.id)
  })
})

describe('envelope validation', () => {
  it('accepts a well-formed envelope', () => {
    const result = validateEnvelope(baseEnvelope().build())
    expect(result.valid).toBe(true)
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
  })

  it('rejects an unassigned signature field', () => {
    const envelope = createEnvelope({ subject: 'Orphan' })
      .document('d', { name: 'd.pdf', source: pdf })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .field({ type: 'signature', page: 0, x: 10, y: 10 })
      .build({ validate: false })

    const result = validateEnvelope(envelope)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.code === 'FIELD_NOT_ASSIGNED')).toBe(true)
  })

  it('rejects a required field nobody owns, which could never complete', () => {
    const envelope = createEnvelope({ subject: 'Unfillable' })
      .document('d', { name: 'd.pdf', source: pdf })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .field({ recipient: 'alice', type: 'signature', page: 0, x: 10, y: 10 })
      .field({ type: 'text', page: 0, x: 10, y: 60, required: true })
      .build({ validate: false })

    const result = validateEnvelope(envelope)
    expect(result.valid).toBe(false)
    expect(
      result.issues.some(
        (i) => i.code === 'FIELD_NOT_ASSIGNED' && i.message.includes('never complete'),
      ),
    ).toBe(true)
  })

  it('rejects a field placed past the last page', () => {
    const envelope = createEnvelope({ subject: 'Off the end' })
      .document('d', { name: 'd.pdf', source: pdf, pageCount: 2 })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .field({ recipient: 'alice', type: 'signature', page: 5, x: 10, y: 10 })
      .build({ validate: false })

    const result = validateEnvelope(envelope)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.message.includes('page 6 of a 2-page'))).toBe(true)
  })

  it('rejects a field assigned to a carbon copy recipient', () => {
    const envelope = createEnvelope({ subject: 'CC with a field' })
      .document('d', { name: 'd.pdf', source: pdf })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .carbonCopy('watcher', { name: 'Watcher', email: 'watcher@example.com' })
      .field({ recipient: 'alice', type: 'signature', page: 0, x: 10, y: 10 })
      .field({ recipient: 'watcher', type: 'text', page: 0, x: 10, y: 60 })
      .build({ validate: false })

    const result = validateEnvelope(envelope)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.message.includes('only receives a copy'))).toBe(true)
  })

  it('rejects an invalid validation pattern rather than failing at signing time', () => {
    const envelope = createEnvelope({ subject: 'Bad regex' })
      .document('d', { name: 'd.pdf', source: pdf })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .field({ recipient: 'alice', type: 'signature', page: 0, x: 10, y: 10 })
      .field({
        recipient: 'alice',
        type: 'text',
        page: 0,
        x: 10,
        y: 60,
        validation: { pattern: '([unclosed' },
      })
      .build({ validate: false })

    const result = validateEnvelope(envelope)
    expect(result.issues.some((i) => i.message.includes('invalid validation pattern'))).toBe(true)
  })

  it('warns about a signer with nothing to do', () => {
    const envelope = createEnvelope({ subject: 'Idle signer' })
      .document('d', { name: 'd.pdf', source: pdf })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .signer('bob', { name: 'Bob', email: 'bob@example.com' })
      .field({ recipient: 'alice', type: 'signature', page: 0, x: 10, y: 10 })
      .build({ validate: false })

    const result = validateEnvelope(envelope)
    // A warning, not an error: it is legal, just probably a mistake.
    expect(result.valid).toBe(true)
    expect(
      result.issues.some((i) => i.severity === 'warning' && i.message.includes('nothing to do')),
    ).toBe(true)
  })

  it('detects a conditional visibility cycle', () => {
    const envelope = createEnvelope({ subject: 'Cycle' })
      .document('d', { name: 'd.pdf', source: pdf })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .field({ alias: 'a', recipient: 'alice', type: 'checkbox', page: 0, x: 10, y: 10 })
      .field({ alias: 'b', recipient: 'alice', type: 'checkbox', page: 0, x: 10, y: 40 })
      .build({ validate: false })

    const [a, b] = envelope.fields
    const cyclic: Envelope = {
      ...envelope,
      fields: [
        {
          ...(a as NonNullable<typeof a>),
          conditions: [{ whenField: b?.id ?? '', operator: 'filled' }],
        },
        {
          ...(b as NonNullable<typeof b>),
          conditions: [{ whenField: a?.id ?? '', operator: 'filled' }],
        },
      ],
    }

    const result = validateEnvelope(cyclic)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.code === 'CONDITION_CYCLE')).toBe(true)
  })
})

describe('lifecycle', () => {
  it('forbids resurrecting a terminal envelope', () => {
    expect(canTransitionEnvelope('completed', 'sent')).toBe(false)
    expect(canTransitionEnvelope('voided', 'sent')).toBe(false)
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('sent')).toBe(false)
  })

  it('allows the normal forward path', () => {
    expect(canTransitionEnvelope('draft', 'sent')).toBe(true)
    expect(canTransitionEnvelope('sent', 'delivered')).toBe(true)
    expect(canTransitionEnvelope('delivered', 'completed')).toBe(true)
  })

  it('treats one decline as closing the envelope even when others signed', () => {
    const status = deriveEnvelopeStatus('partially_signed', [
      { role: 'signer', status: 'completed' },
      { role: 'signer', status: 'declined' },
    ])
    expect(status).toBe('declined')
  })

  it('ignores carbon copies when deciding completion', () => {
    const status = deriveEnvelopeStatus('sent', [
      { role: 'signer', status: 'completed' },
      { role: 'carbon_copy', status: 'sent' },
    ])
    expect(status).toBe('completed')
  })

  it('reports partial signing while a signer is outstanding', () => {
    const status = deriveEnvelopeStatus('sent', [
      { role: 'signer', status: 'completed' },
      { role: 'signer', status: 'delivered' },
    ])
    expect(status).toBe('partially_signed')
  })
})
