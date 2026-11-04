import { describe, expect, it, vi } from 'vitest'
import { EnvelopeStore, TopicNotifier, createEnvelope, signal } from '../src/index.js'
import type { Envelope, Field } from '../src/index.js'

const pdf = { kind: 'url' as const, url: 'https://example.com/a.pdf' }

/** Builds an envelope with `count` text fields spread over 10 pages. */
function wideEnvelope(count: number): Envelope {
  let builder = createEnvelope({ subject: 'Wide' })
    .document('d', { name: 'd.pdf', source: pdf, pageCount: 10 })
    .signer('alice', { name: 'Alice', email: 'alice@example.com' })
    .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 700 })

  for (let i = 0; i < count; i += 1) {
    builder = builder.field({
      alias: `t${i}`,
      recipient: 'alice',
      type: 'text',
      page: i % 10,
      x: 72,
      y: 100 + (i % 20) * 20,
      width: 160,
      height: 18,
    })
  }
  return builder.build()
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe('topic notifier', () => {
  it('notifies only the listeners of the marked topic', async () => {
    const notifier = new TopicNotifier()
    const a = vi.fn()
    const b = vi.fn()
    notifier.subscribe('a', a)
    notifier.subscribe('b', b)

    notifier.mark('a')
    await flush()

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('calls a listener once even when several of its topics change', async () => {
    const notifier = new TopicNotifier()
    const listener = vi.fn()
    notifier.subscribe('a', listener)
    notifier.subscribe('b', listener)

    notifier.mark('a')
    notifier.mark('b')
    await flush()

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('collapses a burst of writes in a batch into one notification', async () => {
    const notifier = new TopicNotifier()
    const listener = vi.fn()
    notifier.subscribe('a', listener)

    notifier.batch(() => {
      for (let i = 0; i < 100; i += 1) notifier.mark('a')
    })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('collapses nested batches into the outermost one', () => {
    const notifier = new TopicNotifier()
    const listener = vi.fn()
    notifier.subscribe('a', listener)

    notifier.batch(() => {
      notifier.mark('a')
      notifier.batch(() => {
        notifier.mark('a')
      })
      expect(listener).not.toHaveBeenCalled()
    })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops notifying after unsubscribe and drops the bucket', async () => {
    const notifier = new TopicNotifier()
    const listener = vi.fn()
    const off = notifier.subscribe('a', listener)

    off()
    notifier.mark('a')
    await flush()

    expect(listener).not.toHaveBeenCalled()
    expect(notifier.listenerCount).toBe(0)
  })

  it('survives a listener that unsubscribes during the flush', () => {
    const notifier = new TopicNotifier()
    const calls: string[] = []
    let offB = () => {}

    notifier.subscribe('a', () => {
      calls.push('a')
      offB()
    })
    offB = notifier.subscribe('a', () => {
      calls.push('b')
    })

    notifier.batch(() => notifier.mark('a'))
    // Both were collected before the flush began, so both ran exactly once.
    expect(calls).toHaveLength(2)
  })
})

describe('envelope store', () => {
  it('indexes fields by page in reading order', () => {
    const envelope = createEnvelope({ subject: 'Ordering' })
      .document('d', { name: 'd.pdf', source: pdf, pageCount: 1 })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .field({ alias: 'lower', recipient: 'alice', type: 'text', page: 0, x: 72, y: 400 })
      .field({ alias: 'upperRight', recipient: 'alice', type: 'text', page: 0, x: 300, y: 100 })
      .field({ alias: 'upperLeft', recipient: 'alice', type: 'text', page: 0, x: 72, y: 100 })
      .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 700 })
      .build()

    const store = new EnvelopeStore(envelope)
    const ids = store.fieldIdsForPage(envelope.documents[0]?.id ?? '', 0)
    const ys = ids.map((id) => store.requireField(id).rect.y)

    // Top to bottom, then left to right.
    expect(ys).toEqual([100, 100, 400, 700])
    const firstTwo = ids.slice(0, 2).map((id) => store.requireField(id).rect.x)
    expect(firstTwo).toEqual([72, 300])
  })

  it('honours an explicit tab order over geometry', () => {
    const envelope = createEnvelope({ subject: 'Tab order' })
      .document('d', { name: 'd.pdf', source: pdf, pageCount: 1 })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .field({ recipient: 'alice', type: 'text', page: 0, x: 72, y: 100, tabOrder: 2 })
      .field({ recipient: 'alice', type: 'text', page: 0, x: 72, y: 400, tabOrder: 1 })
      .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 700, tabOrder: 3 })
      .build()

    const store = new EnvelopeStore(envelope)
    const ids = store.fieldIdsForPage(envelope.documents[0]?.id ?? '', 0)
    expect(ids.map((id) => store.requireField(id).rect.y)).toEqual([400, 100, 700])
  })

  it('returns an identity-stable array until the page changes', () => {
    const envelope = wideEnvelope(50)
    const store = new EnvelopeStore(envelope)
    const documentId = envelope.documents[0]?.id ?? ''

    const first = store.fieldIdsForPage(documentId, 0)
    const second = store.fieldIdsForPage(documentId, 0)
    // Same reference, so a framework can bail out of re-rendering.
    expect(first).toBe(second)

    const target = first[0] as string
    store.setValue(target, { kind: 'text', value: 'typed' })
    // A value change does not alter the id list, so the identity holds.
    expect(store.fieldIdsForPage(documentId, 0)).toBe(first)

    store.removeField(target)
    expect(store.fieldIdsForPage(documentId, 0)).not.toBe(first)
  })

  it('notifies only the written field, not its 399 neighbours', async () => {
    const envelope = wideEnvelope(400)
    const store = new EnvelopeStore(envelope)
    const ids = store.fieldIds()

    const listeners = ids.map(() => vi.fn())
    ids.forEach((id, i) => store.subscribeValue(id, listeners[i] as () => void))

    store.setValue(ids[7] as string, { kind: 'text', value: 'hello' })
    await flush()

    expect(listeners[7]).toHaveBeenCalledTimes(1)
    const others = listeners.filter((_, i) => i !== 7)
    expect(others.every((fn) => fn.mock.calls.length === 0)).toBe(true)
  })

  it('does not notify when the value is unchanged', async () => {
    const envelope = wideEnvelope(5)
    const store = new EnvelopeStore(envelope)
    const id = store.fieldIds()[1] as string
    const listener = vi.fn()
    store.subscribeValue(id, listener)

    store.setValue(id, { kind: 'text', value: 'same' })
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)

    store.setValue(id, { kind: 'text', value: 'same' })
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reindexes when a field moves to another page', () => {
    const envelope = wideEnvelope(5)
    const store = new EnvelopeStore(envelope)
    const documentId = envelope.documents[0]?.id ?? ''
    const id = store.fieldIdsForPage(documentId, 1)[0] as string

    store.updateField(id, { rect: { ...store.requireField(id).rect, page: 3 } })

    expect(store.fieldIdsForPage(documentId, 1)).not.toContain(id)
    expect(store.fieldIdsForPage(documentId, 3)).toContain(id)
  })

  it('reindexes when a field is reassigned to another recipient', () => {
    const envelope = createEnvelope({ subject: 'Reassign' })
      .document('d', { name: 'd.pdf', source: pdf, pageCount: 1 })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .signer('bob', { name: 'Bob', email: 'bob@example.com' })
      .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 600 })
      .field({ recipient: 'bob', type: 'signature', page: 0, x: 300, y: 600 })
      .build()

    const store = new EnvelopeStore(envelope)
    const [alice, bob] = envelope.recipients
    const aliceField = store.fieldIdsForRecipient(alice?.id ?? '')[0] as string

    store.updateField(aliceField, { recipientId: bob?.id })

    expect(store.fieldIdsForRecipient(alice?.id ?? '')).not.toContain(aliceField)
    expect(store.fieldIdsForRecipient(bob?.id ?? '')).toContain(aliceField)
  })

  it('drops the value when a field is removed', () => {
    const envelope = wideEnvelope(3)
    const store = new EnvelopeStore(envelope)
    const id = store.fieldIds()[1] as string

    store.setValue(id, { kind: 'text', value: 'x' })
    store.removeField(id)

    expect(store.getField(id)).toBeUndefined()
    expect(store.getValue(id)).toEqual({ kind: 'empty' })
  })

  it('rejects a value for an unknown field', () => {
    const store = new EnvelopeStore(wideEnvelope(1))
    expect(() => store.setValue('nope', { kind: 'text', value: 'x' })).toThrowError(
      /No field with id nope/u,
    )
  })

  it('round-trips through toEnvelope', () => {
    const envelope = wideEnvelope(10)
    const store = new EnvelopeStore(envelope)
    const out = store.toEnvelope()

    expect(out.id).toBe(envelope.id)
    expect(out.fields).toHaveLength(envelope.fields.length)
    expect(out.recipients).toHaveLength(envelope.recipients.length)
    // Round-tripping through the store must survive JSON.
    expect(() => JSON.stringify(out)).not.toThrow()
  })

  it('freezes entities so callers cannot mutate shared state', () => {
    const store = new EnvelopeStore(wideEnvelope(1))
    const field = store.requireField(store.fieldIds()[0] as string) as Field
    expect(Object.isFrozen(field)).toBe(true)
  })

  it('treats an empty value as clearing the entry', () => {
    const store = new EnvelopeStore(wideEnvelope(2))
    const id = store.fieldIds()[1] as string

    store.setValue(id, { kind: 'text', value: 'x' })
    expect(store.valueEntries()).toHaveLength(1)

    store.setValue(id, { kind: 'empty' })
    expect(store.valueEntries()).toHaveLength(0)
  })
})

describe('signal', () => {
  it('notifies subscribers on change', async () => {
    const count = signal(0)
    const listener = vi.fn()
    count.subscribe(listener)

    count.set(1)
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(count.get()).toBe(1)
  })

  it('skips notification when the value is identical', async () => {
    const count = signal(0)
    const listener = vi.fn()
    count.subscribe(listener)

    count.set(0)
    await flush()
    expect(listener).not.toHaveBeenCalled()
  })

  it('supports functional updates', () => {
    const count = signal(5)
    count.update((n) => n * 2)
    expect(count.get()).toBe(10)
  })
})
