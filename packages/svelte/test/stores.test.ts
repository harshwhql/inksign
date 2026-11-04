import {
  createEnvelope,
  createSession,
  type Envelope,
  EnvelopeStore,
  type FieldId,
  type FieldValue,
  type RecipientId,
} from '@inksign/core'
import { describe, expect, it, vi } from 'vitest'
import {
  assignedFields,
  canFinish,
  createInkSignContext,
  envelopeMeta,
  field,
  fieldValue,
  fromBinding,
  pageFields,
  routing,
  sessionProgress,
  sessionStage,
  writableField,
} from '../src/index.js'

const pdf = { kind: 'url' as const, url: 'https://example.com/a.pdf' }

/** An envelope with `count` text fields plus a signature, ready to sign. */
function buildEnvelope(count: number, settings: { requireConsent?: boolean } = {}): Envelope {
  let builder = createEnvelope({ subject: 'Services agreement' })
    .document('d', { name: 'd.pdf', source: pdf, pageCount: 1 })
    .signer('alice', { name: 'Alice Chen', email: 'alice@example.com' })
    .settings({ requireConsent: settings.requireConsent ?? false })
    .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 700, required: true })

  for (let i = 0; i < count; i += 1) {
    builder = builder.field({
      alias: `t${i}`,
      recipient: 'alice',
      type: 'text',
      page: 0,
      x: 72,
      y: 100 + i * 24,
      width: 180,
      height: 18,
      label: `Field ${i}`,
    })
  }

  const envelope = builder.build()
  return { ...envelope, status: 'sent', sentAt: Date.now() }
}

const recipientOf = (envelope: Envelope): RecipientId => envelope.recipients[0]?.id as RecipientId

/** The engine batches notifications to a microtask, so let it drain. */
const settle = (): Promise<void> => new Promise((resolve) => queueMicrotask(() => resolve()))

function context(count = 3, settings: { requireConsent?: boolean } = {}) {
  const envelope = buildEnvelope(count, settings)
  const ctx = createInkSignContext({ envelope, recipientId: recipientOf(envelope) })
  return { envelope, ...ctx }
}

describe('store contract', () => {
  it('calls the subscriber immediately with the current value', () => {
    const { store } = context()
    const id = store.fieldIds()[1] as FieldId
    const seen: FieldValue[] = []

    fieldValue(store, id).subscribe((value) => seen.push(value))

    // Svelte requires a synchronous first call, or `$store` would be
    // undefined on the first render.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ kind: 'empty' })
  })

  it('pushes updates after a write', async () => {
    const { store, session } = context()
    const id = store.fieldIds().find((each) => store.requireField(each).type === 'text') as FieldId
    const seen: FieldValue[] = []

    fieldValue(store, id).subscribe((value) => seen.push(value))
    session?.setValue(id, { kind: 'text', value: 'General Counsel' })
    await settle()

    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual({ kind: 'text', value: 'General Counsel' })
  })

  it('stops pushing after unsubscribe', async () => {
    const { store, session } = context()
    const id = store.fieldIds().find((each) => store.requireField(each).type === 'text') as FieldId
    const run = vi.fn()

    const unsubscribe = fieldValue(store, id).subscribe(run)
    expect(run).toHaveBeenCalledTimes(1)

    unsubscribe()
    session?.setValue(id, { kind: 'text', value: 'x' })
    await settle()

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('releases the underlying subscription when the last subscriber leaves', () => {
    const { store } = context()
    const id = store.fieldIds()[1] as FieldId
    const before = store.listenerCount

    const store$ = fieldValue(store, id)
    const offA = store$.subscribe(() => {})
    const offB = store$.subscribe(() => {})

    // One engine listener regardless of how many Svelte subscribers there are.
    expect(store.listenerCount).toBe(before + 1)

    offA()
    expect(store.listenerCount).toBe(before + 1)

    offB()
    // A subscription that outlives its subscribers is a leak on a long document.
    expect(store.listenerCount).toBe(before)
  })

  it('does not push when the value is unchanged', async () => {
    const { store, session } = context()
    const id = store.fieldIds().find((each) => store.requireField(each).type === 'text') as FieldId
    const run = vi.fn()

    fieldValue(store, id).subscribe(run)
    session?.setValue(id, { kind: 'text', value: 'same' })
    await settle()
    expect(run).toHaveBeenCalledTimes(2)

    session?.setValue(id, { kind: 'text', value: 'same' })
    await settle()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('supports several independent subscribers', async () => {
    const { store, session } = context()
    const id = store.fieldIds().find((each) => store.requireField(each).type === 'text') as FieldId
    const a = vi.fn()
    const b = vi.fn()

    const store$ = fieldValue(store, id)
    store$.subscribe(a)
    store$.subscribe(b)

    session?.setValue(id, { kind: 'text', value: 'x' })
    await settle()

    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(2)
  })
})

describe('fine-grained subscriptions', () => {
  /**
   * The central performance claim: writing one field must not notify the
   * others. A regression that reintroduces whole-envelope invalidation fails
   * here rather than in production on someone's 300 field contract.
   */
  it('notifies only the field that changed', async () => {
    const { store, session } = context(30)
    const ids = store.fieldIds()
    const calls = new Map<FieldId, number>()

    for (const id of ids) {
      calls.set(id, 0)
      fieldValue(store, id).subscribe(() => {
        calls.set(id, (calls.get(id) ?? 0) + 1)
      })
    }

    // Every subscriber got its initial call.
    expect([...calls.values()].every((count) => count === 1)).toBe(true)

    const target = ids.find((id) => store.requireField(id).type === 'text') as FieldId
    session?.setValue(target, { kind: 'text', value: 'typed into one field' })
    await settle()

    expect(calls.get(target)).toBe(2)

    const moved = ids.filter((id) => id !== target && calls.get(id) !== 1)
    expect(moved).toEqual([])
  })

  it('keeps notification counts flat across many writes', async () => {
    const { store, session } = context(20)
    const ids = store.fieldIds()
    const calls = new Map<FieldId, number>()

    for (const id of ids) {
      calls.set(id, 0)
      fieldValue(store, id).subscribe(() => {
        calls.set(id, (calls.get(id) ?? 0) + 1)
      })
    }

    const target = ids.find((id) => store.requireField(id).type === 'text') as FieldId

    for (let i = 0; i < 20; i += 1) {
      session?.setValue(target, { kind: 'text', value: `value ${i}` })
      await settle()
    }

    for (const id of ids.filter((each) => each !== target)) {
      expect(calls.get(id)).toBe(1)
    }
    expect(calls.get(target)).toBe(21)
  })

  it('leaves the page field list alone when a value changes', async () => {
    const { envelope, store, session } = context(5)
    const documentId = envelope.documents[0]?.id as string
    const run = vi.fn()

    pageFields(store, documentId, 0).subscribe(run)
    expect(run).toHaveBeenCalledTimes(1)

    const target = store.fieldIds().find((id) => store.requireField(id).type === 'text') as FieldId
    session?.setValue(target, { kind: 'text', value: 'x' })
    await settle()

    // Filling a field does not alter which fields are on the page.
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('pushes the page field list when a field is removed', async () => {
    const { envelope, store } = context(5)
    const documentId = envelope.documents[0]?.id as string
    const run = vi.fn()

    pageFields(store, documentId, 0).subscribe(run)
    store.removeField(store.fieldIds()[1] as FieldId)
    await settle()

    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('fromBinding', () => {
  it('opens the subscription lazily and closes it eagerly', () => {
    let open = 0
    const binding = fromBinding(
      () => {
        open += 1
        return () => {
          open -= 1
        }
      },
      () => 'value',
    )

    expect(open).toBe(0)
    const off = binding.subscribe(() => {})
    expect(open).toBe(1)
    off()
    expect(open).toBe(0)
  })
})

describe('session stores', () => {
  it('reports the consent stage and advances on acceptance', async () => {
    const { session } = context(1, { requireConsent: true })
    const seen: string[] = []

    sessionStage(session as NonNullable<typeof session>).subscribe((stage) => seen.push(stage))
    expect(seen).toEqual(['consent'])

    await session?.acceptConsent()
    await settle()

    expect(seen).toEqual(['consent', 'filling'])
  })

  it('tracks progress over required fields', async () => {
    const { store, session } = context(2)
    const seen: number[] = []

    sessionProgress(session as NonNullable<typeof session>).subscribe((progress) =>
      seen.push(progress.requiredRemaining),
    )
    expect(seen).toEqual([1])

    const signature = store
      .fieldIds()
      .find((id) => store.requireField(id).type === 'signature') as FieldId
    session?.setValue(signature, {
      kind: 'ink',
      value: { source: 'drawn', width: 300, height: 90, paths: ['M 0 0 L 10 10'] },
    })
    await settle()

    expect(seen).toEqual([1, 0])
  })

  it('does not push progress when the numbers have not moved', async () => {
    const { store, session } = context(3)
    const run = vi.fn()

    sessionProgress(session as NonNullable<typeof session>).subscribe(run)
    expect(run).toHaveBeenCalledTimes(1)

    const text = store.fieldIds().find((id) => store.requireField(id).type === 'text') as FieldId

    // The first write moves `filled` from 0 to 1, which is a real change.
    session?.setValue(text, { kind: 'text', value: 'a' })
    await settle()
    expect(run).toHaveBeenCalledTimes(2)

    // Every keystroke after that leaves all three counts where they were, so
    // the identical object is reused and nothing is pushed. Without that, a
    // progress bar would be invalidated on every character typed.
    for (const value of ['ab', 'abc', 'abcd']) {
      session?.setValue(text, { kind: 'text', value })
      await settle()
    }

    expect(run).toHaveBeenCalledTimes(2)
  })

  it('reports what is blocking and clears it when satisfied', async () => {
    const { store, session } = context(1)
    const seen: (string | undefined)[] = []

    canFinish(session as NonNullable<typeof session>).subscribe((state) => seen.push(state.code))
    expect(seen[0]).toBe('REQUIRED_FIELDS_INCOMPLETE')

    const signature = store
      .fieldIds()
      .find((id) => store.requireField(id).type === 'signature') as FieldId
    session?.setValue(signature, {
      kind: 'ink',
      value: { source: 'drawn', width: 300, height: 90, paths: ['M 0 0 L 10 10'] },
    })
    await settle()

    expect(seen[seen.length - 1]).toBeUndefined()
  })

  it('tracks the visible assigned fields as conditions change', async () => {
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
        showWhen: [{ field: 'viaAgent', operator: 'equals', value: true }],
      })
      .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 600 })
      .build()

    const sent: Envelope = { ...envelope, status: 'sent' }
    const store = new EnvelopeStore(sent)
    const session = createSession(store, sent.recipients[0]?.id as RecipientId)

    const counts: number[] = []
    assignedFields(session, store).subscribe((fields) => counts.push(fields.length))

    expect(counts[0]).toBe(2)

    const checkbox = store
      .fieldIds()
      .find((id) => store.requireField(id).type === 'checkbox') as FieldId
    session.setValue(checkbox, { kind: 'boolean', value: true })
    await settle()

    expect(counts[counts.length - 1]).toBe(3)
  })
})

describe('other stores', () => {
  it('exposes the field definition', () => {
    const { store } = context()
    const id = store.fieldIds()[0] as FieldId
    let seen: { id: string } | undefined

    field(store, id).subscribe((value) => {
      seen = value
    })
    expect(seen?.id).toBe(id)
  })

  it('exposes envelope metadata and pushes on a status change', async () => {
    const { store } = context()
    const seen: string[] = []

    envelopeMeta(store).subscribe((meta) => seen.push(meta.status))
    expect(seen).toEqual(['sent'])

    store.setStatus('completed')
    await settle()

    expect(seen).toEqual(['sent', 'completed'])
  })

  it('exposes the routing plan', () => {
    const { envelope, store } = context()
    let actionable: readonly string[] = []

    routing(store).subscribe((plan) => {
      actionable = plan.actionable
    })

    expect(actionable).toEqual([recipientOf(envelope)])
  })
})

describe('writableField', () => {
  it('reads through and writes through the session', async () => {
    const { store, session } = context()
    const id = store.fieldIds().find((each) => store.requireField(each).type === 'text') as FieldId

    const binding = writableField(session as NonNullable<typeof session>, store, id)
    const seen: FieldValue[] = []
    binding.subscribe((value) => seen.push(value))

    binding.set({ kind: 'text', value: 'General Counsel' })
    await settle()

    expect(store.getValue(id)).toEqual({ kind: 'text', value: 'General Counsel' })
    expect(seen[seen.length - 1]).toEqual({ kind: 'text', value: 'General Counsel' })
  })

  it('supports update and clear', async () => {
    const { store, session } = context()
    const id = store.fieldIds().find((each) => store.requireField(each).type === 'text') as FieldId
    const binding = writableField(session as NonNullable<typeof session>, store, id)

    binding.set({ kind: 'text', value: 'a' })
    binding.update((current) => ({
      kind: 'text',
      value: current.kind === 'text' ? `${current.value}b` : 'b',
    }))
    await settle()
    expect(store.getValue(id)).toEqual({ kind: 'text', value: 'ab' })

    binding.clear()
    await settle()
    expect(store.getValue(id)).toEqual({ kind: 'empty' })
  })

  it('still enforces the session rules', () => {
    const { store, session } = context()
    const signature = store
      .fieldIds()
      .find((id) => store.requireField(id).type === 'signature') as FieldId
    const binding = writableField(session as NonNullable<typeof session>, store, signature)

    // Writing through the binding does not bypass the type check.
    expect(() => binding.set({ kind: 'text', value: 'Alice' })).toThrowError(/cannot hold a text/u)
  })
})

describe('context', () => {
  it('builds a context with a session', () => {
    const { store, session, theme } = context()
    expect(session).toBeDefined()
    expect(store.fieldIds().length).toBeGreaterThan(0)
    expect(theme.scheme).toBe('light')
  })

  it('builds a context without a session for a sender preview', () => {
    const envelope = buildEnvelope(1)
    const ctx = createInkSignContext({ envelope })
    expect(ctx.session).toBeUndefined()
  })

  it('reports an out-of-turn session rather than throwing', () => {
    const envelope = createEnvelope({ subject: 'Sequential' })
      .document('d', { name: 'd.pdf', source: pdf, pageCount: 1 })
      .signer('first', { name: 'First', email: 'first@example.com' })
      .signer('second', { name: 'Second', email: 'second@example.com' })
      .field({ recipient: 'first', type: 'signature', page: 0, x: 72, y: 600 })
      .field({ recipient: 'second', type: 'signature', page: 0, x: 300, y: 600 })
      .build()

    const onSessionError = vi.fn()
    const ctx = createInkSignContext({
      envelope: { ...envelope, status: 'sent' },
      recipientId: envelope.recipients[1]?.id as RecipientId,
      onSessionError,
    })

    expect(ctx.session).toBeUndefined()
    expect(onSessionError).toHaveBeenCalledTimes(1)
    expect(onSessionError.mock.calls[0]?.[0]?.code).toBe('NOT_YOUR_TURN')
  })
})
