import type { EnvelopeMeta } from '@inksign/core'
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
import {
  type ComputedRef,
  computed,
  getCurrentScope,
  onScopeDispose,
  type ShallowRef,
  shallowRef,
} from 'vue'
import { useInkSign, useSigningSession, useStoreBinding } from './context.js'

/**
 * Composables over the engine.
 *
 * Every subscription here is keyed, which is the whole point. `useFieldValue`
 * subscribes to one field, so typing in it updates that input and nothing
 * else. A single reactive object holding the envelope would invalidate every
 * field on every keystroke, and on a 300 field document that is the difference
 * between usable and not.
 */

/** Subscribes to one field's value. */
export function useFieldValue(id: FieldId): ShallowRef<FieldValue> {
  const { store } = useInkSign()
  return useStoreBinding(
    (onChange) => store.subscribe(topics.value(id), onChange),
    () => store.getValue(id),
  )
}

/** Subscribes to one field's definition, which changes when a sender edits it. */
export function useField(id: FieldId): ShallowRef<Field | undefined> {
  const { store } = useInkSign()
  return useStoreBinding(
    (onChange) => store.subscribe(topics.field(id), onChange),
    () => store.getField(id),
  )
}

/** Subscribes to one recipient. */
export function useRecipient(id: RecipientId): ShallowRef<Recipient | undefined> {
  const { store } = useInkSign()
  return useStoreBinding(
    (onChange) => store.subscribe(topics.recipient(id), onChange),
    () => store.getRecipient(id),
  )
}

/** Subscribes to envelope-level attributes: status, subject, settings. */
export function useEnvelopeMeta(): ShallowRef<EnvelopeMeta> {
  const { store } = useInkSign()
  return useStoreBinding(
    (onChange) => store.subscribe(topics.envelope, onChange),
    () => store.getMeta(),
  )
}

/**
 * Field IDs on one page, in tab order.
 *
 * The store caches these arrays by identity, so this only changes when a field
 * is added, removed or moved. Filling a field does not alter the list, so a
 * page does not re-render while its fields are being typed in.
 */
export function usePageFields(documentId: string, page: number): ShallowRef<readonly FieldId[]> {
  const { store } = useInkSign()
  return useStoreBinding(
    (onChange) => {
      const offPage = store.subscribe(topics.page(documentId, page), onChange)
      const offStructure = store.subscribeStructure(onChange)
      return () => {
        offPage()
        offStructure()
      }
    },
    () => store.fieldIdsForPage(documentId, page),
  )
}

/** The current ceremony stage. */
export function useSessionStage(): ShallowRef<SessionStage> {
  const session = useSigningSession()
  return useStoreBinding(
    (onChange) => session.subscribe(sessionTopics.stage, onChange),
    () => session.stage,
  )
}

/**
 * Completion progress.
 *
 * `progress()` builds a fresh object each call, so the previous one is kept
 * and reused when the numbers have not moved. Without that, every progress
 * notification would look like a change to anything watching it.
 */
export function useSessionProgress(): ShallowRef<SessionProgress> {
  const session = useSigningSession()
  let cached: SessionProgress | undefined

  const read = (): SessionProgress => {
    const next = session.progress()
    if (
      cached &&
      cached.total === next.total &&
      cached.filled === next.filled &&
      cached.requiredRemaining === next.requiredRemaining
    ) {
      return cached
    }
    cached = next
    return next
  }

  return useStoreBinding((onChange) => {
    const offProgress = session.subscribe(sessionTopics.progress, onChange)
    const offStage = session.subscribe(sessionTopics.stage, onChange)
    return () => {
      offProgress()
      offStage()
    }
  }, read)
}

/** Validation issues for one field, from the last write. */
export function useFieldIssues(id: FieldId): ShallowRef<readonly ValidationIssue[]> {
  const session = useSigningSession()
  return useStoreBinding(
    (onChange) => session.subscribe(sessionTopics.issues, onChange),
    () => session.issuesFor(id),
  )
}

export interface FieldState {
  field: ShallowRef<Field | undefined>
  value: ShallowRef<FieldValue>
  issues: ShallowRef<readonly ValidationIssue[]>
  readOnly: ComputedRef<boolean>
  setValue(value: FieldValue): void
  clear(): void
}

/** A field's value, definition and issues, plus writers. */
export function useFieldState(id: FieldId): FieldState {
  const session = useSigningSession()
  const field = useField(id)
  const value = useFieldValue(id)
  const issues = useFieldIssues(id)

  return {
    field,
    value,
    issues,
    readOnly: computed(() => field.value?.readOnly ?? false),
    setValue: (next: FieldValue) => {
      session.setValue(id, next)
    },
    clear: () => {
      session.clearValue(id)
    },
  }
}

export interface FinishState {
  canFinish: boolean
  reason: string | undefined
  code: string | undefined
}

/**
 * Whether the recipient can finish, and why not when they cannot.
 *
 * Watches every topic that could unblock finishing: a filled field, a resolved
 * validation issue, or a stage change such as accepting consent.
 */
export function useCanFinish(): ShallowRef<FinishState> {
  const session = useSigningSession()

  return useStoreBinding(
    (onChange) => {
      const offIssues = session.subscribe(sessionTopics.issues, onChange)
      const offProgress = session.subscribe(sessionTopics.progress, onChange)
      const offStage = session.subscribe(sessionTopics.stage, onChange)
      return () => {
        offIssues()
        offProgress()
        offStage()
      }
    },
    () => {
      const blocking = session.blockingReason()
      return {
        canFinish: blocking === undefined,
        reason: blocking?.message,
        code: blocking?.code,
      }
    },
  )
}

/** The routing plan, recomputed when any recipient's status changes. */
export function useRouting(): ShallowRef<RoutingPlan> {
  const { store } = useInkSign()

  return useStoreBinding(
    (onChange) => {
      const offs = store.recipientIds().map((id) => store.subscribeRecipient(id, onChange))
      const offStructure = store.subscribeStructure(onChange)
      return () => {
        for (const off of offs) off()
        offStructure()
      }
    },
    () => resolveRouting(store.recipientIds().map((id) => store.requireRecipient(id))),
  )
}

/**
 * The fields assigned to the signing recipient, visible ones only.
 *
 * Conditional visibility depends on other field values, so this watches
 * progress rather than only structure.
 */
export function useAssignedFields(): ShallowRef<readonly Field[]> {
  const session = useSigningSession()
  const { store } = useInkSign()

  return useStoreBinding(
    (onChange) => {
      const offProgress = session.subscribe(sessionTopics.progress, onChange)
      const offStructure = store.subscribeStructure(onChange)
      return () => {
        offProgress()
        offStructure()
      }
    },
    () => session.assignedFields(),
  )
}

export interface ElementSize {
  width: number
  height: number
}

/** Element size, tracked with a ResizeObserver, for fit-to-width layout. */
export function useElementSize(): {
  elementRef: (element: HTMLElement | null) => void
  size: ShallowRef<ElementSize>
} {
  const size = shallowRef<ElementSize>({ width: 0, height: 0 })
  let observer: ResizeObserver | undefined

  const elementRef = (element: HTMLElement | null): void => {
    observer?.disconnect()
    observer = undefined
    if (!element) return

    const ResizeObserverCtor = (globalThis as { ResizeObserver?: typeof ResizeObserver })
      .ResizeObserver
    if (!ResizeObserverCtor) {
      const rect = element.getBoundingClientRect()
      size.value = { width: rect.width, height: rect.height }
      return
    }

    observer = new ResizeObserverCtor((entries) => {
      const box = entries[0]?.contentRect
      if (!box) return
      // Sub-pixel jitter would otherwise relayout the whole document.
      if (
        Math.abs(size.value.width - box.width) < 0.5 &&
        Math.abs(size.value.height - box.height) < 0.5
      ) {
        return
      }
      size.value = { width: box.width, height: box.height }
    })
    observer.observe(element)
  }

  if (getCurrentScope()) {
    onScopeDispose(() => observer?.disconnect())
  }

  return { elementRef, size }
}
