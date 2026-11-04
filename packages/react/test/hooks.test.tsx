// @vitest-environment jsdom

import { createEnvelope, type Envelope, type FieldId, type RecipientId } from '@inksign/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import { memo, type ReactNode, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InkSignProvider,
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

function recipientOf(envelope: Envelope): RecipientId {
  return envelope.recipients[0]?.id as RecipientId
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('provider', () => {
  it('exposes the store and session', () => {
    const envelope = buildEnvelope(1)
    let seen: { hasSession: boolean; fieldCount: number } | undefined

    function Probe(): ReactNode {
      const { store, session } = useInkSign()
      seen = { hasSession: session !== undefined, fieldCount: store.fieldIds().length }
      return null
    }

    render(
      <InkSignProvider envelope={envelope} recipientId={recipientOf(envelope)}>
        <Probe />
      </InkSignProvider>,
    )

    expect(seen?.hasSession).toBe(true)
    expect(seen?.fieldCount).toBe(2)
  })

  it('renders without a session for a sender preview', () => {
    const envelope = buildEnvelope(1)
    let hasSession = true

    function Probe(): ReactNode {
      hasSession = useInkSign().session !== undefined
      return null
    }

    render(
      <InkSignProvider envelope={envelope}>
        <Probe />
      </InkSignProvider>,
    )

    expect(hasSession).toBe(false)
  })

  it('reports an out-of-turn session through onSessionError rather than crashing', () => {
    const envelope = createEnvelope({ subject: 'Sequential' })
      .document('d', { name: 'd.pdf', source: pdf, pageCount: 1 })
      .signer('first', { name: 'First', email: 'first@example.com' })
      .signer('second', { name: 'Second', email: 'second@example.com' })
      .field({ recipient: 'first', type: 'signature', page: 0, x: 72, y: 600 })
      .field({ recipient: 'second', type: 'signature', page: 0, x: 300, y: 600 })
      .build()

    const sent: Envelope = { ...envelope, status: 'sent' }
    const onSessionError = vi.fn()

    render(
      <InkSignProvider
        envelope={sent}
        recipientId={sent.recipients[1]?.id as RecipientId}
        onSessionError={onSessionError}
      >
        <div>rendered anyway</div>
      </InkSignProvider>,
    )

    expect(onSessionError).toHaveBeenCalledTimes(1)
    expect(onSessionError.mock.calls[0]?.[0]?.code).toBe('NOT_YOUR_TURN')
    expect(screen.getByText('rendered anyway')).toBeDefined()
  })

  it('throws a clear error when a hook is used outside the provider', () => {
    function Orphan(): ReactNode {
      useInkSign()
      return null
    }
    // React logs the error boundary message; silence it for this assertion.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => render(<Orphan />)).toThrowError(/inside an <InkSignProvider>/u)
  })
})

describe('fine-grained subscriptions', () => {
  /**
   * The central performance claim: writing one field must not re-render the
   * others. Each probe counts its own renders, so a regression that
   * reintroduces whole-tree invalidation fails here rather than in
   * production on someone's 300 field contract.
   */
  it('re-renders only the field that changed', async () => {
    const envelope = buildEnvelope(30)
    const renders = new Map<FieldId, number>()

    const FieldProbe = memo(function FieldProbe({ id }: { id: FieldId }): ReactNode {
      const value = useFieldValue(id)
      const count = useRef(0)
      count.current += 1
      renders.set(id, count.current)
      return <span data-testid={id}>{value.kind === 'text' ? value.value : ''}</span>
    })

    let setValue: ((id: FieldId, text: string) => void) | undefined
    let ids: readonly FieldId[] = []

    function Harness(): ReactNode {
      const { store, session } = useInkSign()
      ids = store.fieldIds()
      setValue = (id, text) => session?.setValue(id, { kind: 'text', value: text })
      return (
        <>
          {ids.map((id) => (
            <FieldProbe key={id} id={id} />
          ))}
        </>
      )
    }

    render(
      <InkSignProvider envelope={envelope} recipientId={recipientOf(envelope)}>
        <Harness />
      </InkSignProvider>,
    )

    const textFields = ids.filter((id) => id !== ids[0])
    const target = textFields[5] as FieldId
    const baseline = new Map(renders)

    await act(async () => {
      setValue?.(target, 'typed into one field')
    })

    expect(renders.get(target)).toBe((baseline.get(target) ?? 0) + 1)

    // Every other field must be untouched.
    const moved = ids.filter((id) => id !== target && renders.get(id) !== baseline.get(id))
    expect(moved).toEqual([])
  })

  it('keeps per-field render counts flat across many writes', async () => {
    const envelope = buildEnvelope(20)
    const renders = new Map<FieldId, number>()

    const FieldProbe = memo(function FieldProbe({ id }: { id: FieldId }): ReactNode {
      useFieldValue(id)
      renders.set(id, (renders.get(id) ?? 0) + 1)
      return null
    })

    let setValue: ((id: FieldId, text: string) => void) | undefined
    let ids: readonly FieldId[] = []

    function Harness(): ReactNode {
      const { store, session } = useInkSign()
      ids = store.fieldIds()
      setValue = (id, text) => session?.setValue(id, { kind: 'text', value: text })
      return (
        <>
          {ids.map((id) => (
            <FieldProbe key={id} id={id} />
          ))}
        </>
      )
    }

    render(
      <InkSignProvider envelope={envelope} recipientId={recipientOf(envelope)}>
        <Harness />
      </InkSignProvider>,
    )

    const target = ids[3] as FieldId

    // Twenty keystrokes into one field.
    for (let i = 0; i < 20; i += 1) {
      await act(async () => {
        setValue?.(target, `value ${i}`)
      })
    }

    const others = ids.filter((id) => id !== target)
    // Nothing else re-rendered more than its initial mount, allowing for the
    // provider's own first pass.
    for (const id of others) {
      expect(renders.get(id) ?? 0).toBeLessThanOrEqual(2)
    }
  })

  it('reflects the written value', async () => {
    const envelope = buildEnvelope(3)
    let setValue: ((id: FieldId, text: string) => void) | undefined
    let textId: FieldId | undefined

    function Harness(): ReactNode {
      const { store, session } = useInkSign()
      const ids = store.fieldIds()
      textId = ids.find((id) => store.requireField(id).type === 'text')
      setValue = (id, text) => session?.setValue(id, { kind: 'text', value: text })
      return textId ? <Display id={textId} /> : null
    }

    function Display({ id }: { id: FieldId }): ReactNode {
      const value = useFieldValue(id)
      return <span data-testid="value">{value.kind === 'text' ? value.value : 'empty'}</span>
    }

    render(
      <InkSignProvider envelope={envelope} recipientId={recipientOf(envelope)}>
        <Harness />
      </InkSignProvider>,
    )

    expect(screen.getByTestId('value').textContent).toBe('empty')

    await act(async () => {
      setValue?.(textId as FieldId, 'General Counsel')
    })

    await waitFor(() => {
      expect(screen.getByTestId('value').textContent).toBe('General Counsel')
    })
  })
})

describe('session hooks', () => {
  it('reports the consent stage and advances on acceptance', async () => {
    const envelope = buildEnvelope(1, { requireConsent: true })
    let accept: (() => Promise<void>) | undefined

    function Probe(): ReactNode {
      const stage = useSessionStage()
      const { session } = useInkSign()
      accept = () => session?.acceptConsent() ?? Promise.resolve()
      return <span data-testid="stage">{stage}</span>
    }

    render(
      <InkSignProvider envelope={envelope} recipientId={recipientOf(envelope)}>
        <Probe />
      </InkSignProvider>,
    )

    expect(screen.getByTestId('stage').textContent).toBe('consent')

    await act(async () => {
      await accept?.()
    })

    await waitFor(() => {
      expect(screen.getByTestId('stage').textContent).toBe('filling')
    })
  })

  it('tracks progress over required fields', async () => {
    const envelope = buildEnvelope(2)
    let fill: (() => void) | undefined

    function Probe(): ReactNode {
      const progress = useSessionProgress()
      const { session, store } = useInkSign()
      fill = () => {
        const signature = store.fieldIds().find((id) => store.requireField(id).type === 'signature')
        if (signature) {
          session?.setValue(signature, {
            kind: 'ink',
            value: { source: 'drawn', width: 300, height: 90, paths: ['M 0 0 L 10 10'] },
          })
        }
      }
      return <span data-testid="remaining">{progress.requiredRemaining}</span>
    }

    render(
      <InkSignProvider envelope={envelope} recipientId={recipientOf(envelope)}>
        <Probe />
      </InkSignProvider>,
    )

    expect(screen.getByTestId('remaining').textContent).toBe('1')

    await act(async () => {
      fill?.()
    })

    await waitFor(() => {
      expect(screen.getByTestId('remaining').textContent).toBe('0')
    })
  })

  it('returns a stable progress object when nothing changed', () => {
    const envelope = buildEnvelope(2)
    const seen: unknown[] = []

    function Probe(): ReactNode {
      seen.push(useSessionProgress())
      return null
    }

    const { rerender } = render(
      <InkSignProvider envelope={envelope} recipientId={recipientOf(envelope)}>
        <Probe />
      </InkSignProvider>,
    )

    rerender(
      <InkSignProvider envelope={envelope} recipientId={recipientOf(envelope)}>
        <Probe />
      </InkSignProvider>,
    )

    // Identity must hold, or useSyncExternalStore would loop.
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[0]).toBe(seen[seen.length - 1])
  })
})
