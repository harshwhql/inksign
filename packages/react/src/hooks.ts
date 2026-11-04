import {
  type Field,
  type FieldId,
  type FieldValue,
  type Recipient,
  type RecipientId,
  type RoutingPlan,
  resolveRouting,
  type SessionProgress,
  type SessionStage,
  sessionTopics,
  topics,
  type ValidationIssue,
} from '@inksign/core'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useInkSign, useSigningSession } from './context.js'

/**
 * Hooks over the engine.
 *
 * Every subscription here is keyed, which is the whole point. `useFieldValue`
 * subscribes to one field, so typing in it re-renders that input and nothing
 * else. The alternative, a single context value holding the envelope, would
 * re-render every field on every keystroke, and on a 300 field document that
 * is the difference between usable and not.
 *
 * `useSyncExternalStore` is used rather than `useEffect` plus `useState`
 * because it is tear-free under concurrent rendering: a value read during
 * render is guaranteed consistent with what the subscription will report.
 */

/** Subscribes to one field's value. */
export function useFieldValue(id: FieldId): FieldValue {
  const { store } = useInkSign()

  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe(topics.value(id), onChange),
    [store, id],
  )
  // Values are frozen and replaced on change, so identity is a valid check
  // and React bails out of re-rendering when nothing changed.
  const getSnapshot = useCallback(() => store.getValue(id), [store, id])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Subscribes to one field's definition, which changes when a sender edits it. */
export function useField(id: FieldId): Field | undefined {
  const { store } = useInkSign()

  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe(topics.field(id), onChange),
    [store, id],
  )
  const getSnapshot = useCallback(() => store.getField(id), [store, id])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Subscribes to one recipient. */
export function useRecipient(id: RecipientId): Recipient | undefined {
  const { store } = useInkSign()

  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe(topics.recipient(id), onChange),
    [store, id],
  )
  const getSnapshot = useCallback(() => store.getRecipient(id), [store, id])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Subscribes to envelope-level attributes: status, subject, settings. */
export function useEnvelopeMeta() {
  const { store } = useInkSign()

  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe(topics.envelope, onChange),
    [store],
  )
  const getSnapshot = useCallback(() => store.getMeta(), [store])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Field IDs on one page, in tab order.
 *
 * The store caches these arrays by identity, so the subscription only fires
 * when a field is added, removed or moved. Filling a field does not change
 * the list, so a page does not re-render while its fields are being typed in.
 */
export function usePageFields(documentId: string, page: number): readonly FieldId[] {
  const { store } = useInkSign()

  const subscribe = useCallback(
    (onChange: () => void) => {
      const offPage = store.subscribe(topics.page(documentId, page), onChange)
      const offStructure = store.subscribeStructure(onChange)
      return () => {
        offPage()
        offStructure()
      }
    },
    [store, documentId, page],
  )
  const getSnapshot = useCallback(
    () => store.fieldIdsForPage(documentId, page),
    [store, documentId, page],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** The current ceremony stage. */
export function useSessionStage(): SessionStage {
  const session = useSigningSession()

  const subscribe = useCallback(
    (onChange: () => void) => session.subscribe(sessionTopics.stage, onChange),
    [session],
  )
  const getSnapshot = useCallback(() => session.stage, [session])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Completion progress.
 *
 * The snapshot is memoized on its own field values because `progress()`
 * builds a fresh object every call, which `useSyncExternalStore` would treat
 * as a change and loop. Returning a stable object unless the numbers actually
 * moved is what keeps it quiet.
 */
export function useSessionProgress(): SessionProgress {
  const session = useSigningSession()
  const cache = useRef<SessionProgress | undefined>(undefined)

  const subscribe = useCallback(
    (onChange: () => void) => {
      const offProgress = session.subscribe(sessionTopics.progress, onChange)
      const offStage = session.subscribe(sessionTopics.stage, onChange)
      return () => {
        offProgress()
        offStage()
      }
    },
    [session],
  )

  const getSnapshot = useCallback(() => {
    const next = session.progress()
    const previous = cache.current
    if (
      previous &&
      previous.total === next.total &&
      previous.filled === next.filled &&
      previous.requiredRemaining === next.requiredRemaining
    ) {
      return previous
    }
    cache.current = next
    return next
  }, [session])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Validation issues for one field, from the last write. */
export function useFieldIssues(id: FieldId): readonly ValidationIssue[] {
  const session = useSigningSession()

  const subscribe = useCallback(
    (onChange: () => void) => session.subscribe(sessionTopics.issues, onChange),
    [session],
  )
  const getSnapshot = useCallback(() => session.issuesFor(id), [session, id])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * A field value plus a setter, the hook a field input actually wants.
 *
 * The setter is stable across renders, so passing it to a memoized input does
 * not defeat the memo.
 */
export function useFieldState(id: FieldId): {
  field: Field | undefined
  value: FieldValue
  issues: readonly ValidationIssue[]
  setValue: (value: FieldValue) => void
  clear: () => void
  readOnly: boolean
} {
  const session = useSigningSession()
  const field = useField(id)
  const value = useFieldValue(id)
  const issues = useFieldIssues(id)

  const setValue = useCallback(
    (next: FieldValue) => {
      session.setValue(id, next)
    },
    [session, id],
  )

  const clear = useCallback(() => {
    session.clearValue(id)
  }, [session, id])

  return {
    field,
    value,
    issues,
    setValue,
    clear,
    readOnly: field?.readOnly ?? false,
  }
}

/**
 * Whether the recipient can finish, and why not when they cannot.
 *
 * Subscribes to every topic that could unblock finishing: a filled field, a
 * resolved validation issue, or a stage change such as accepting consent.
 */
export function useCanFinish(): {
  canFinish: boolean
  reason: string | undefined
  code: string | undefined
} {
  const session = useSigningSession()
  const version = useSessionVersion()

  return useMemo(() => {
    void version
    const blocking = session.blockingReason()
    return {
      canFinish: blocking === undefined,
      reason: blocking?.message,
      code: blocking?.code,
    }
  }, [session, version])
}

/** A counter that increments on any session change. */
function useSessionVersion(): number {
  const session = useSigningSession()
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const bump = (): void => setVersion((n) => n + 1)
    const offIssues = session.subscribe(sessionTopics.issues, bump)
    const offProgress = session.subscribe(sessionTopics.progress, bump)
    const offStage = session.subscribe(sessionTopics.stage, bump)

    return () => {
      offIssues()
      offProgress()
      offStage()
    }
  }, [session])

  return version
}

/** The routing plan, recomputed when any recipient's status changes. */
export function useRouting(): RoutingPlan {
  const { store } = useInkSign()
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const offs = store
      .recipientIds()
      .map((id) => store.subscribeRecipient(id, () => setVersion((n) => n + 1)))
    const offStructure = store.subscribeStructure(() => setVersion((n) => n + 1))

    return () => {
      for (const off of offs) off()
      offStructure()
    }
  }, [store])

  return useMemo(() => {
    void version
    return resolveRouting(store.recipientIds().map((id) => store.requireRecipient(id)))
  }, [store, version])
}

/**
 * The fields assigned to the signing recipient, visible ones only.
 *
 * Conditional visibility depends on other field values, so this resubscribes
 * to the issue and progress topics rather than only to structure.
 */
export function useAssignedFields(): readonly Field[] {
  const session = useSigningSession()
  const { store } = useInkSign()
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const bump = (): void => setVersion((n) => n + 1)
    const offProgress = session.subscribe(sessionTopics.progress, bump)
    const offStructure = store.subscribeStructure(bump)
    return () => {
      offProgress()
      offStructure()
    }
  }, [session, store])

  return useMemo(() => {
    void version
    return session.assignedFields()
  }, [session, version])
}

/** Element size, tracked with a ResizeObserver, for fit-to-width layout. */
export function useElementSize(): [
  (element: HTMLElement | null) => void,
  { width: number; height: number },
] {
  const [size, setSize] = useState({ width: 0, height: 0 })
  const observerRef = useRef<ResizeObserver | undefined>(undefined)

  const ref = useCallback((element: HTMLElement | null) => {
    observerRef.current?.disconnect()
    if (!element) return

    const ResizeObserverCtor = (globalThis as { ResizeObserver?: typeof ResizeObserver })
      .ResizeObserver
    if (!ResizeObserverCtor) {
      const rect = element.getBoundingClientRect()
      setSize({ width: rect.width, height: rect.height })
      return
    }

    observerRef.current = new ResizeObserverCtor((entries) => {
      const entry = entries[0]
      if (!entry) return
      const box = entry.contentRect
      setSize((previous) =>
        // Sub-pixel jitter would otherwise relayout the whole document.
        Math.abs(previous.width - box.width) < 0.5 && Math.abs(previous.height - box.height) < 0.5
          ? previous
          : { width: box.width, height: box.height },
      )
    })
    observerRef.current.observe(element)
  }, [])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  return [ref, size]
}
