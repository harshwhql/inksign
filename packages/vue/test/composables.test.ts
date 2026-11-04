// @vitest-environment jsdom
import { createEnvelope, type Envelope, type FieldId, type RecipientId } from '@inksign/core'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import {
  InkSignProvider,
  provideInkSign,
  useFieldValue,
  useInkSign,
  useSessionProgress,
  useSessionStage,
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

/**
 * Lets both queues drain.
 *
 * The engine batches notifications to a microtask, then the binding writes a
 * ref, which schedules a Vue update. One `nextTick` only covers the second
 * half, so a write would look like it had no effect.
 */
async function settle(): Promise<void> {
  await flushPromises()
  await nextTick()
}

/** Mounts `inner` under a provider for the given envelope. */
function mountWithProvider(
  envelope: Envelope,
  recipientId: RecipientId | undefined,
  inner: unknown,
) {
  const Root = defineComponent({
    setup() {
      provideInkSign({ envelope, recipientId })
      return () => h(inner as never)
    },
  })
  return mount(Root)
}

describe('provider', () => {
  it('exposes the store and session', () => {
    const envelope = buildEnvelope(1)
    let seen: { hasSession: boolean; fieldCount: number } | undefined

    const Probe = defineComponent({
      setup() {
        const { store, session } = useInkSign()
        seen = { hasSession: session !== undefined, fieldCount: store.fieldIds().length }
        return () => null
      },
    })

    mountWithProvider(envelope, recipientOf(envelope), Probe)

    expect(seen?.hasSession).toBe(true)
    expect(seen?.fieldCount).toBe(2)
  })

  it('renders without a session for a sender preview', () => {
    const envelope = buildEnvelope(1)
    let hasSession = true

    const Probe = defineComponent({
      setup() {
        hasSession = useInkSign().session !== undefined
        return () => null
      },
    })

    mountWithProvider(envelope, undefined, Probe)
    expect(hasSession).toBe(false)
  })

  it('reports an out-of-turn session rather than throwing', () => {
    const envelope = createEnvelope({ subject: 'Sequential' })
      .document('d', { name: 'd.pdf', source: pdf, pageCount: 1 })
      .signer('first', { name: 'First', email: 'first@example.com' })
      .signer('second', { name: 'Second', email: 'second@example.com' })
      .field({ recipient: 'first', type: 'signature', page: 0, x: 72, y: 600 })
      .field({ recipient: 'second', type: 'signature', page: 0, x: 300, y: 600 })
      .build()

    const sent: Envelope = { ...envelope, status: 'sent' }
    const onSessionError = vi.fn()

    const wrapper = mount(InkSignProvider, {
      props: {
        envelope: sent,
        recipientId: sent.recipients[1]?.id as RecipientId,
        onSessionError,
      },
      slots: { default: () => h('div', 'rendered anyway') },
    })

    expect(onSessionError).toHaveBeenCalledTimes(1)
    expect(onSessionError.mock.calls[0]?.[0]?.code).toBe('NOT_YOUR_TURN')
    expect(wrapper.text()).toContain('rendered anyway')
  })

  it('throws a clear error when a composable is used outside the provider', () => {
    const Orphan = defineComponent({
      setup() {
        useInkSign()
        return () => null
      },
    })

    expect(() => mount(Orphan)).toThrowError(/InkSignProvider|provideInkSign/u)
  })
})

describe('fine-grained subscriptions', () => {
  /**
   * The central performance claim: writing one field must not update the
   * others. Each probe counts its own renders, so a regression that
   * reintroduces whole-tree invalidation fails here rather than in production
   * on someone's 300 field contract.
   */
  it('re-renders only the field that changed', async () => {
    const envelope = buildEnvelope(30)
    const renders = new Map<FieldId, number>()

    const FieldProbe = defineComponent({
      props: { id: { type: String, required: true } },
      setup(props) {
        const value = useFieldValue(props.id as FieldId)
        return () => {
          renders.set(props.id as FieldId, (renders.get(props.id as FieldId) ?? 0) + 1)
          return h('span', value.value.kind === 'text' ? value.value.value : '')
        }
      },
    })

    let ids: readonly FieldId[] = []
    let setValue: ((id: FieldId, text: string) => void) | undefined

    const Harness = defineComponent({
      setup() {
        const { store, session } = useInkSign()
        ids = store.fieldIds()
        setValue = (id, text) => session?.setValue(id, { kind: 'text', value: text })
        return () => ids.map((id) => h(FieldProbe, { key: id, id }))
      },
    })

    mountWithProvider(envelope, recipientOf(envelope), Harness)
    await settle()

    const target = ids[6] as FieldId
    const baseline = new Map(renders)

    setValue?.(target, 'typed into one field')
    await settle()

    expect(renders.get(target)).toBe((baseline.get(target) ?? 0) + 1)

    // Every other field must be untouched.
    const moved = ids.filter((id) => id !== target && renders.get(id) !== baseline.get(id))
    expect(moved).toEqual([])
  })

  it('keeps per-field render counts flat across many writes', async () => {
    const envelope = buildEnvelope(20)
    const renders = new Map<FieldId, number>()

    const FieldProbe = defineComponent({
      props: { id: { type: String, required: true } },
      setup(props) {
        const value = useFieldValue(props.id as FieldId)
        return () => {
          void value.value
          renders.set(props.id as FieldId, (renders.get(props.id as FieldId) ?? 0) + 1)
          return null
        }
      },
    })

    let ids: readonly FieldId[] = []
    let setValue: ((id: FieldId, text: string) => void) | undefined

    const Harness = defineComponent({
      setup() {
        const { store, session } = useInkSign()
        ids = store.fieldIds()
        setValue = (id, text) => session?.setValue(id, { kind: 'text', value: text })
        return () => ids.map((id) => h(FieldProbe, { key: id, id }))
      },
    })

    mountWithProvider(envelope, recipientOf(envelope), Harness)
    await settle()

    const target = ids[3] as FieldId

    for (let i = 0; i < 20; i += 1) {
      setValue?.(target, `value ${i}`)
      await settle()
    }

    // Nothing else rendered more than its initial mount.
    for (const id of ids.filter((each) => each !== target)) {
      expect(renders.get(id) ?? 0).toBeLessThanOrEqual(1)
    }
  })

  it('reflects the written value', async () => {
    const envelope = buildEnvelope(3)
    let textId: FieldId | undefined
    let setValue: ((id: FieldId, text: string) => void) | undefined

    const Display = defineComponent({
      props: { id: { type: String, required: true } },
      setup(props) {
        const value = useFieldValue(props.id as FieldId)
        return () =>
          h(
            'span',
            { 'data-testid': 'value' },
            value.value.kind === 'text' ? value.value.value : 'empty',
          )
      },
    })

    const Harness = defineComponent({
      setup() {
        const { store, session } = useInkSign()
        textId = store.fieldIds().find((id) => store.requireField(id).type === 'text')
        setValue = (id, text) => session?.setValue(id, { kind: 'text', value: text })
        return () => (textId ? h(Display, { id: textId }) : null)
      },
    })

    const wrapper = mountWithProvider(envelope, recipientOf(envelope), Harness)
    await settle()

    expect(wrapper.text()).toBe('empty')

    setValue?.(textId as FieldId, 'General Counsel')
    await settle()

    expect(wrapper.text()).toBe('General Counsel')
  })

  it('unsubscribes when the component unmounts', async () => {
    const envelope = buildEnvelope(2)
    let store: ReturnType<typeof useInkSign>['store'] | undefined

    const Probe = defineComponent({
      props: { id: { type: String, required: true } },
      setup(props) {
        const value = useFieldValue(props.id as FieldId)
        return () => h('span', String(value.value.kind))
      },
    })

    const Harness = defineComponent({
      props: { show: { type: Boolean, required: true } },
      setup(props) {
        const context = useInkSign()
        store = context.store
        const id = context.store.fieldIds()[0] as FieldId
        return () => (props.show ? h(Probe, { id }) : null)
      },
    })

    const Root = defineComponent({
      props: { show: { type: Boolean, required: true } },
      setup(props) {
        provideInkSign({ envelope, recipientId: recipientOf(envelope) })
        return () => h(Harness, { show: props.show })
      },
    })

    const wrapper = mount(Root, { props: { show: true } })
    await settle()
    const whileMounted = store?.listenerCount ?? 0

    await wrapper.setProps({ show: false })
    await settle()

    // A subscription that outlives its component is a leak on a long document.
    expect(store?.listenerCount ?? 0).toBeLessThan(whileMounted)
  })
})

describe('session composables', () => {
  it('reports the consent stage and advances on acceptance', async () => {
    const envelope = buildEnvelope(1, { requireConsent: true })
    let accept: (() => Promise<void>) | undefined

    const Probe = defineComponent({
      setup() {
        const stage = useSessionStage()
        const { session } = useInkSign()
        accept = () => session?.acceptConsent() ?? Promise.resolve()
        return () => h('span', stage.value)
      },
    })

    const wrapper = mountWithProvider(envelope, recipientOf(envelope), Probe)
    expect(wrapper.text()).toBe('consent')

    await accept?.()
    await settle()

    expect(wrapper.text()).toBe('filling')
  })

  it('tracks progress over required fields', async () => {
    const envelope = buildEnvelope(2)
    let fill: (() => void) | undefined

    const Probe = defineComponent({
      setup() {
        const progress = useSessionProgress()
        const { session, store } = useInkSign()
        fill = () => {
          const signature = store
            .fieldIds()
            .find((id) => store.requireField(id).type === 'signature')
          if (signature) {
            session?.setValue(signature, {
              kind: 'ink',
              value: { source: 'drawn', width: 300, height: 90, paths: ['M 0 0 L 10 10'] },
            })
          }
        }
        return () => h('span', String(progress.value.requiredRemaining))
      },
    })

    const wrapper = mountWithProvider(envelope, recipientOf(envelope), Probe)
    expect(wrapper.text()).toBe('1')

    fill?.()
    await settle()

    expect(wrapper.text()).toBe('0')
  })

  it('returns a stable progress object when nothing changed', async () => {
    const envelope = buildEnvelope(2)
    const seen: unknown[] = []

    const Probe = defineComponent({
      setup() {
        const progress = useSessionProgress()
        return () => {
          seen.push(progress.value)
          return null
        }
      },
    })

    const wrapper = mountWithProvider(envelope, recipientOf(envelope), Probe)
    await settle()
    // Force a re-render that is not caused by a progress change.
    wrapper.vm.$forceUpdate()
    await settle()

    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toBe(seen[seen.length - 1])
  })
})
