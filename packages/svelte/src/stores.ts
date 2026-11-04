import {
  type EnvelopeMeta,
  type EnvelopeStore,
  type Field,
  type FieldId,
  type FieldValue,
  type Recipient,
  type RecipientId,
  type RoutingPlan,
  resolveRouting,
  type SessionProgress,
  type SessionStage,
  type SigningSession,
  sessionTopics,
  topics,
  type ValidationIssue,
} from '@inksign/core'

/**
 * Reactive bindings, as Svelte stores.
 *
 * Svelte's store contract is one method: `subscribe(run)` calls `run` with the
 * current value and returns an unsubscribe. That maps exactly onto the
 * engine's keyed subscriptions, which means the binding layer needs no
 * compiler, no runes, and no framework import at all. It works unchanged in
 * Svelte 3, 4 and 5, and with `$store` auto-subscription in every one of them.
 *
 * The keying is the point. `fieldValue(store, id)` listens to one field, so
 * typing in it notifies that input and nothing else. A single store holding
 * the whole envelope would wake every field on every keystroke, and on a 300
 * field document that is the difference between usable and not.
 */

export type Unsubscriber = () => void
export type Subscriber<T> = (value: T) => void

/** The readable half of Svelte's store contract. */
export interface Readable<T> {
  subscribe(run: Subscriber<T>, invalidate?: () => void): Unsubscriber
}

/**
 * Builds a store over a keyed subscription.
 *
 * The underlying subscription is opened on the first subscriber and closed
 * when the last one leaves, which is what keeps a long document from
 * accumulating dead listeners as pages scroll in and out.
 */
export function fromBinding<T>(
  subscribe: (onChange: () => void) => Unsubscriber,
  read: () => T,
): Readable<T> {
  const subscribers = new Set<Subscriber<T>>()
  let stop: Unsubscriber | undefined
  let current: T

  const notify = (): void => {
    const next = read()
    // Entities from the store are frozen and replaced on change, so identity
    // is a valid check and an unchanged read costs nothing downstream.
    if (Object.is(next, current)) return
    current = next
    for (const run of subscribers) run(current)
  }

  return {
    subscribe(run: Subscriber<T>): Unsubscriber {
      if (subscribers.size === 0) {
        current = read()
        stop = subscribe(notify)
      }
      subscribers.add(run)
      run(current)

      return () => {
        subscribers.delete(run)
        if (subscribers.size === 0) {
          stop?.()
          stop = undefined
        }
      }
    },
  }
}

/** One field's value. */
export function fieldValue(store: EnvelopeStore, id: FieldId): Readable<FieldValue> {
  return fromBinding(
    (onChange) => store.subscribe(topics.value(id), onChange),
    () => store.getValue(id),
  )
}

/** One field's definition, which changes when a sender edits it. */
export function field(store: EnvelopeStore, id: FieldId): Readable<Field | undefined> {
  return fromBinding(
    (onChange) => store.subscribe(topics.field(id), onChange),
    () => store.getField(id),
  )
}

/** One recipient. */
export function recipient(store: EnvelopeStore, id: RecipientId): Readable<Recipient | undefined> {
  return fromBinding(
    (onChange) => store.subscribe(topics.recipient(id), onChange),
    () => store.getRecipient(id),
  )
}

/** Envelope-level attributes: status, subject, settings. */
export function envelopeMeta(store: EnvelopeStore): Readable<EnvelopeMeta> {
  return fromBinding(
    (onChange) => store.subscribe(topics.envelope, onChange),
    () => store.getMeta(),
  )
}

/**
 * Field IDs on one page, in tab order.
 *
 * The engine caches these arrays by identity, so this only fires when a field
 * is added, removed or moved. Filling a field does not alter the list, so a
 * page stays quiet while its fields are typed in.
 */
export function pageFields(
  store: EnvelopeStore,
  documentId: string,
  page: number,
): Readable<readonly FieldId[]> {
  return fromBinding(
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

/** The routing plan, recomputed when any recipient's status changes. */
export function routing(store: EnvelopeStore): Readable<RoutingPlan> {
  return fromBinding(
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

/** The current ceremony stage. */
export function sessionStage(session: SigningSession): Readable<SessionStage> {
  return fromBinding(
    (onChange) => session.subscribe(sessionTopics.stage, onChange),
    () => session.stage,
  )
}

/**
 * Completion progress.
 *
 * `progress()` returns a fresh object each call, so the previous one is reused
 * when the numbers have not moved. Without that, every notification would look
 * like a change and wake anything watching it.
 */
export function sessionProgress(session: SigningSession): Readable<SessionProgress> {
  let cached: SessionProgress | undefined

  return fromBinding(
    (onChange) => {
      const offProgress = session.subscribe(sessionTopics.progress, onChange)
      const offStage = session.subscribe(sessionTopics.stage, onChange)
      return () => {
        offProgress()
        offStage()
      }
    },
    () => {
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
    },
  )
}

/** Validation issues for one field, from the last write. */
export function fieldIssues(
  session: SigningSession,
  id: FieldId,
): Readable<readonly ValidationIssue[]> {
  return fromBinding(
    (onChange) => session.subscribe(sessionTopics.issues, onChange),
    () => session.issuesFor(id),
  )
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
export function canFinish(session: SigningSession): Readable<FinishState> {
  let cached: FinishState | undefined

  return fromBinding(
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
      const next: FinishState = {
        canFinish: blocking === undefined,
        reason: blocking?.message,
        code: blocking?.code,
      }
      if (cached && cached.canFinish === next.canFinish && cached.reason === next.reason) {
        return cached
      }
      cached = next
      return next
    },
  )
}

/**
 * The fields assigned to the signing recipient, visible ones only.
 *
 * Conditional visibility depends on other field values, so this watches
 * progress rather than only structure.
 */
export function assignedFields(
  session: SigningSession,
  store: EnvelopeStore,
): Readable<readonly Field[]> {
  return fromBinding(
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

/**
 * A writable view of one field.
 *
 * Implements the writable half of the store contract as well, so a Svelte
 * component can use `bind:` against it. `set` goes through the session rather
 * than the store, so every rule about who may write what still applies.
 */
export interface WritableField {
  subscribe(run: Subscriber<FieldValue>): Unsubscriber
  set(value: FieldValue): void
  update(fn: (current: FieldValue) => FieldValue): void
  clear(): void
}

export function writableField(
  session: SigningSession,
  store: EnvelopeStore,
  id: FieldId,
): WritableField {
  const readable = fieldValue(store, id)

  return {
    subscribe: readable.subscribe,
    set: (value: FieldValue) => {
      session.setValue(id, value)
    },
    update: (fn: (current: FieldValue) => FieldValue) => {
      session.setValue(id, fn(store.getValue(id)))
    },
    clear: () => {
      session.clearValue(id)
    },
  }
}
