import { beforeEach, describe, expect, it } from 'vitest'
import type { Envelope, InkSignature, RecipientId } from '../src/index.js'
import {
  AuditTrail,
  createEnvelope,
  createSession,
  EnvelopeStore,
  InkSignError,
  isEmpty,
  MemoryIdentityAdapter,
  type SigningSession,
} from '../src/index.js'

const pdf = { kind: 'url' as const, url: 'https://example.com/a.pdf' }

const drawn: InkSignature = {
  source: 'drawn',
  width: 320,
  height: 96,
  paths: ['M 10 50 C 40 10 80 90 120 50'],
}

function build(options: { consent?: boolean; auth?: boolean; delegation?: boolean } = {}) {
  let builder = createEnvelope({ subject: 'Services agreement' })
    .document('msa', { name: 'MSA.pdf', source: pdf, pageCount: 1 })
    .signer('alice', {
      name: 'Alice Chen',
      email: 'alice@example.com',
      ...(options.auth ? { auth: { kind: 'access_code' as const } } : {}),
    })
    .signer('bob', { name: 'Bob Diaz', email: 'bob@example.com' })
    .field({
      alias: 'aliceSig',
      recipient: 'alice',
      type: 'signature',
      page: 0,
      x: 72,
      y: 600,
      required: true,
    })
    .field({ alias: 'aliceDate', recipient: 'alice', type: 'date_signed', page: 0, x: 260, y: 600 })
    .field({ alias: 'aliceName', recipient: 'alice', type: 'full_name', page: 0, x: 72, y: 560 })
    .field({
      alias: 'aliceTitle',
      recipient: 'alice',
      type: 'text',
      page: 0,
      x: 72,
      y: 520,
      label: 'Job title',
      required: true,
      validation: { maxLength: 40 },
    })
    .field({ recipient: 'bob', type: 'signature', page: 0, x: 72, y: 400, required: true })

  builder = builder.settings({
    requireConsent: options.consent ?? false,
    allowDelegation: options.delegation ?? false,
  })

  const envelope = builder.build()
  const sent: Envelope = { ...envelope, status: 'sent', sentAt: Date.now() }
  return { envelope: sent, store: new EnvelopeStore(sent) }
}

function recipientIdFor(envelope: Envelope, name: string): RecipientId {
  const found = envelope.recipients.find((r) => r.name.startsWith(name))
  if (!found) throw new Error(`No recipient named ${name}`)
  return found.id
}

describe('signing session', () => {
  it('starts in the filling stage when consent and auth are off', () => {
    const { envelope, store } = build()
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))
    expect(session.stage).toBe('filling')
  })

  it('refuses to open for a recipient whose turn has not come', () => {
    const { envelope, store } = build()
    expect(() => createSession(store, recipientIdFor(envelope, 'Bob'))).toThrowError(
      /not Bob Diaz's turn/u,
    )
  })

  it('allows an out-of-turn session when routing is explicitly ignored', () => {
    const { envelope, store } = build()
    const session = createSession(store, recipientIdFor(envelope, 'Bob'), { ignoreRouting: true })
    expect(session.stage).toBe('filling')
  })

  it('only exposes fields assigned to this recipient', () => {
    const { envelope, store } = build()
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))
    const types = session.assignedFields().map((f) => f.type)

    expect(types).toContain('signature')
    expect(types).toContain('date_signed')
    // Bob's signature field must not appear.
    expect(session.assignedFields()).toHaveLength(4)
  })

  it('refuses a value for a field assigned to someone else', () => {
    const { envelope, store } = build()
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))
    const bobField = envelope.fields.find((f) => f.recipientId === recipientIdFor(envelope, 'Bob'))

    expect(() => session.setValue(bobField?.id ?? '', { kind: 'ink', value: drawn })).toThrowError(
      InkSignError,
    )
  })

  it('refuses a value of the wrong kind', () => {
    const { envelope, store } = build()
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))
    const signature = session.assignedFields().find((f) => f.type === 'signature')

    expect(() =>
      session.setValue(signature?.id ?? '', { kind: 'text', value: 'Alice' }),
    ).toThrowError(/cannot hold a text value/u)
  })
})

describe('consent gate', () => {
  it('blocks filling until the disclosure is accepted', () => {
    const { envelope, store } = build({ consent: true })
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))

    expect(session.stage).toBe('consent')
    const field = store.fieldIdsForRecipient(recipientIdFor(envelope, 'Alice'))[0]
    expect(() => session.setValue(field ?? '', { kind: 'ink', value: drawn })).toThrowError(
      /CONSENT_REQUIRED|disclosure/u,
    )
  })

  it('moves to filling and prefills once accepted', async () => {
    const { envelope, store } = build({ consent: true })
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))
    await session.acceptConsent()

    expect(session.stage).toBe('filling')

    const nameField = session.assignedFields().find((f) => f.type === 'full_name')
    expect(session.getValue(nameField?.id ?? '')).toEqual({ kind: 'text', value: 'Alice Chen' })

    const dateField = session.assignedFields().find((f) => f.type === 'date_signed')
    expect(session.getValue(dateField?.id ?? '').kind).toBe('date')
  })

  it('declining the disclosure declines the envelope', async () => {
    const { envelope, store } = build({ consent: true })
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))
    await session.declineConsent('Prefers paper')

    expect(session.stage).toBe('declined')
    expect(store.getMeta().status).toBe('declined')
  })
})

describe('authentication gate', () => {
  it('blocks the ceremony until the access code is correct', async () => {
    const { envelope, store } = build({ auth: true })
    const aliceId = recipientIdFor(envelope, 'Alice')
    const identity = new MemoryIdentityAdapter(new Map([[aliceId, '4821']]))
    const session = createSession(store, aliceId, { adapters: { identity } })

    expect(session.stage).toBe('authenticating')

    expect(await session.authenticate('0000')).toBe(false)
    expect(session.stage).toBe('authenticating')

    expect(await session.authenticate('4821')).toBe(true)
    expect(session.stage).toBe('filling')
  })

  it('reports a clear error when no identity adapter is configured', async () => {
    const { envelope, store } = build({ auth: true })
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))

    await expect(session.authenticate('4821')).rejects.toThrowError(/no identity adapter/u)
  })

  it('records the failure in the audit trail', async () => {
    const { envelope, store } = build({ auth: true })
    const aliceId = recipientIdFor(envelope, 'Alice')
    const identity = new MemoryIdentityAdapter(new Map([[aliceId, '4821']]))
    const trail = new AuditTrail(envelope.id)
    const session = createSession(store, aliceId, { adapters: { identity }, trail })

    await session.authenticate('0000')
    expect(trail.list().some((e) => e.action === 'recipient_auth_failed')).toBe(true)
  })
})

describe('signature adoption', () => {
  let session: SigningSession
  let store: EnvelopeStore

  beforeEach(() => {
    const built = build()
    store = built.store
    session = createSession(store, recipientIdFor(built.envelope, 'Alice'))
  })

  it('applies one drawn signature to every empty ink field', async () => {
    const applied = await session.adoptSignature(drawn)
    expect(applied).toHaveLength(1)

    const signature = session.assignedFields().find((f) => f.type === 'signature')
    expect(session.getValue(signature?.id ?? '').kind).toBe('ink')
  })

  it('leaves initials alone when the signature was drawn', async () => {
    const built = build()
    const aliceId = recipientIdFor(built.envelope, 'Alice')
    const initials = built.envelope.fields[0]
    built.store.addField({
      id: 'fld_initials',
      documentId: initials?.documentId ?? '',
      recipientId: aliceId,
      type: 'initials',
      rect: { page: 0, x: 400, y: 600, width: 44, height: 28 },
    })

    const scoped = createSession(built.store, aliceId)
    const applied = await scoped.adoptSignature(drawn)
    // A drawn full signature is the wrong mark for an initials box.
    expect(applied).not.toContain('fld_initials')
    expect(isEmpty(built.store.getValue('fld_initials'))).toBe(true)
  })

  it('applies a typed signature to initials as well', async () => {
    const built = build()
    const aliceId = recipientIdFor(built.envelope, 'Alice')
    const first = built.envelope.fields[0]
    built.store.addField({
      id: 'fld_initials',
      documentId: first?.documentId ?? '',
      recipientId: aliceId,
      type: 'initials',
      rect: { page: 0, x: 400, y: 600, width: 44, height: 28 },
    })

    const scoped = createSession(built.store, aliceId)
    const applied = await scoped.adoptSignature({
      source: 'typed',
      width: 200,
      height: 60,
      text: 'Alice Chen',
      typeface: 'Caveat',
    })
    expect(applied).toContain('fld_initials')
  })
})

describe('finishing', () => {
  it('reports what is blocking rather than failing silently', () => {
    const { envelope, store } = build()
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))

    const blocking = session.blockingReason()
    expect(blocking?.code).toBe('REQUIRED_FIELDS_INCOMPLETE')
    expect(blocking?.message).toMatch(/required field/u)
    expect(session.canFinish()).toBe(false)
  })

  it('completes once every required field is filled', async () => {
    const { envelope, store } = build()
    const aliceId = recipientIdFor(envelope, 'Alice')
    const session = createSession(store, aliceId)

    await session.adoptSignature(drawn)
    const title = session.assignedFields().find((f) => f.label === 'Job title')
    session.setValue(title?.id ?? '', { kind: 'text', value: 'General Counsel' })

    expect(session.canFinish()).toBe(true)
    await session.finish()

    expect(session.stage).toBe('completed')
    expect(store.requireRecipient(aliceId).status).toBe('completed')
    // Bob has not signed, so the envelope is only partially signed.
    expect(store.getMeta().status).toBe('partially_signed')
  })

  it('completes the envelope once the last signer finishes', async () => {
    const { envelope, store } = build()
    const aliceId = recipientIdFor(envelope, 'Alice')
    const bobId = recipientIdFor(envelope, 'Bob')

    const alice = createSession(store, aliceId)
    await alice.adoptSignature(drawn)
    const title = alice.assignedFields().find((f) => f.label === 'Job title')
    alice.setValue(title?.id ?? '', { kind: 'text', value: 'General Counsel' })
    await alice.finish()

    const bob = createSession(store, bobId)
    await bob.adoptSignature(drawn)
    await bob.finish()

    expect(store.getMeta().status).toBe('completed')
    expect(store.getMeta().completedAt).toBeTypeOf('number')
  })

  it('refuses to finish with a value that fails validation', async () => {
    const { envelope, store } = build()
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))

    await session.adoptSignature(drawn)
    const title = session.assignedFields().find((f) => f.label === 'Job title')
    // Over the 40 character limit.
    session.setValue(title?.id ?? '', { kind: 'text', value: 'x'.repeat(41) })

    expect(session.canFinish()).toBe(false)
    await expect(session.finish()).rejects.toThrowError(/at most 40 characters/u)
  })

  it('refuses a second finish on the same session', async () => {
    const { envelope, store } = build()
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))
    await session.adoptSignature(drawn)
    const title = session.assignedFields().find((f) => f.label === 'Job title')
    session.setValue(title?.id ?? '', { kind: 'text', value: 'GC' })
    await session.finish()

    await expect(session.finish()).rejects.toThrowError(/already completed/u)
  })
})

describe('declining and delegating', () => {
  it('declines the envelope with a reason', async () => {
    const { envelope, store } = build()
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))
    await session.decline('Terms are unacceptable')

    expect(session.stage).toBe('declined')
    expect(store.getMeta().status).toBe('declined')
    expect(store.getMeta().voidReason).toBe('Terms are unacceptable')
  })

  it('refuses to delegate when the envelope does not allow it', async () => {
    const { envelope, store } = build({ delegation: false })
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))
    await expect(session.delegate({ name: 'Deputy' })).rejects.toThrowError(
      /does not allow delegation/u,
    )
  })

  it('delegates when allowed', async () => {
    const { envelope, store } = build({ delegation: true })
    const aliceId = recipientIdFor(envelope, 'Alice')
    const session = createSession(store, aliceId)
    await session.delegate({ name: 'Deputy', email: 'deputy@example.com' })

    expect(session.stage).toBe('delegated')
    expect(store.requireRecipient(aliceId).status).toBe('delegated')
  })
})

describe('conditional fields', () => {
  function conditional() {
    const envelope = createEnvelope({ subject: 'Conditional' })
      .document('d', { name: 'd.pdf', source: pdf, pageCount: 1 })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .settings({ requireConsent: false })
      .field({ alias: 'viaAgent', recipient: 'alice', type: 'checkbox', page: 0, x: 72, y: 100 })
      .field({
        alias: 'agentName',
        recipient: 'alice',
        type: 'text',
        page: 0,
        x: 72,
        y: 140,
        label: 'Agent name',
        required: true,
        showWhen: [{ field: 'viaAgent', operator: 'equals', value: true }],
      })
      .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 600, required: true })
      .build()

    const sent: Envelope = { ...envelope, status: 'sent' }
    return { envelope: sent, store: new EnvelopeStore(sent) }
  }

  it('hides a conditional field and does not require it', async () => {
    const { envelope, store } = conditional()
    const session = createSession(store, envelope.recipients[0]?.id ?? '')
    await session.adoptSignature(drawn)

    const labels = session.assignedFields().map((f) => f.label)
    expect(labels).not.toContain('Agent name')
    // The hidden required field must not block finishing.
    expect(session.canFinish()).toBe(true)
  })

  it('shows and requires the field once the condition is met', async () => {
    const { envelope, store } = conditional()
    const session = createSession(store, envelope.recipients[0]?.id ?? '')
    await session.adoptSignature(drawn)

    const checkbox = session.assignedFields().find((f) => f.type === 'checkbox')
    session.setValue(checkbox?.id ?? '', { kind: 'boolean', value: true })

    expect(session.assignedFields().map((f) => f.label)).toContain('Agent name')
    expect(session.canFinish()).toBe(false)
    expect(session.blockingReason()?.code).toBe('REQUIRED_FIELDS_INCOMPLETE')
  })

  it('refuses to write to a hidden field', async () => {
    const { envelope, store } = conditional()
    const session = createSession(store, envelope.recipients[0]?.id ?? '')
    const agentField = envelope.fields.find((f) => f.label === 'Agent name')

    expect(() =>
      session.setValue(agentField?.id ?? '', { kind: 'text', value: 'Someone' }),
    ).toThrowError(/hidden by a condition/u)
  })
})

describe('progress', () => {
  it('tracks required completion rather than raw field count', async () => {
    const { envelope, store } = build()
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))

    expect(session.progress().ratio).toBe(0)
    expect(session.progress().requiredRemaining).toBe(2)

    await session.adoptSignature(drawn)
    expect(session.progress().requiredRemaining).toBe(1)
    expect(session.progress().ratio).toBe(0.5)

    const title = session.assignedFields().find((f) => f.label === 'Job title')
    session.setValue(title?.id ?? '', { kind: 'text', value: 'GC' })
    expect(session.progress().ratio).toBe(1)
  })

  it('names the next required field in reading order, not document order', () => {
    const { envelope, store } = build()
    const session = createSession(store, recipientIdFor(envelope, 'Alice'))

    // The job title sits at y=520, above the signature at y=600, so it comes
    // first even though the signature was declared first.
    expect(session.nextRequiredField()?.label).toBe('Job title')

    const title = session.assignedFields().find((f) => f.label === 'Job title')
    session.setValue(title?.id ?? '', { kind: 'text', value: 'GC' })
    expect(session.nextRequiredField()?.type).toBe('signature')
  })
})
