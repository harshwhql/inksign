import { InkSignError } from '../errors.js'
import type {
  DocumentId,
  Envelope,
  EnvelopeId,
  EnvelopeStatus,
  Field,
  FieldId,
  FieldValue,
  Recipient,
  RecipientId,
  SignatureDocument,
  Timestamp,
} from '../types.js'
import { TopicNotifier, type Listener, type Unsubscribe } from './signal.js'

/**
 * Topic keys. Exported so adapters can subscribe without rebuilding the
 * string format and drifting out of sync with the store.
 */
export const topics = {
  envelope: 'envelope',
  field: (id: FieldId) => `field:${id}`,
  value: (id: FieldId) => `value:${id}`,
  recipient: (id: RecipientId) => `recipient:${id}`,
  document: (id: DocumentId) => `document:${id}`,
  page: (documentId: DocumentId, page: number) => `page:${documentId}:${page}`,
  /** Structural changes: a field, recipient or document was added or removed. */
  structure: 'structure',
} as const

const EMPTY_IDS: readonly FieldId[] = Object.freeze([])
const EMPTY_DOCUMENT_IDS: readonly DocumentId[] = Object.freeze([])
const EMPTY_RECIPIENT_IDS: readonly RecipientId[] = Object.freeze([])

/**
 * Normalized, mutation-efficient store for one envelope.
 *
 * Internal collections are mutable maps keyed by ID, so a write touches one
 * entry rather than cloning the whole collection. What callers receive is
 * always either a frozen entity object or a cached frozen array, and those
 * identities change only when their contents actually change. That gives
 * `useSyncExternalStore` and friends a correct, cheap equality check.
 *
 * Cost summary:
 * - read a field or value: O(1)
 * - write a value: O(1), notifying only that field's listeners
 * - add or remove a field: O(1) plus invalidation of the affected index arrays
 * - list the fields on a page: O(1) after the first call, until the page changes
 */
export class EnvelopeStore {
  private readonly notifier = new TopicNotifier()

  private readonly documents = new Map<DocumentId, SignatureDocument>()
  private readonly recipients = new Map<RecipientId, Recipient>()
  private readonly fields = new Map<FieldId, Field>()
  private readonly values = new Map<FieldId, FieldValue>()

  /** Index: document to its field IDs. */
  private readonly byDocument = new Map<DocumentId, Set<FieldId>>()
  /** Index: recipient to its field IDs. */
  private readonly byRecipient = new Map<RecipientId, Set<FieldId>>()
  /** Index: `${documentId}:${page}` to its field IDs. */
  private readonly byPage = new Map<string, Set<FieldId>>()

  /** Frozen array cache over the index sets, keyed by the same strings. */
  private readonly arrayCache = new Map<string, readonly FieldId[]>()

  private meta: EnvelopeMeta
  private documentOrder: readonly DocumentId[] = EMPTY_DOCUMENT_IDS
  private recipientOrder: readonly RecipientId[] = EMPTY_RECIPIENT_IDS

  constructor(envelope: Envelope) {
    this.meta = Object.freeze({
      id: envelope.id,
      status: envelope.status,
      subject: envelope.subject,
      message: envelope.message,
      settings: Object.freeze({ ...envelope.settings }),
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
      sentAt: envelope.sentAt,
      completedAt: envelope.completedAt,
      voidedAt: envelope.voidedAt,
      voidReason: envelope.voidReason,
      templateId: envelope.templateId,
      metadata: envelope.metadata,
    }) as EnvelopeMeta

    for (const document of envelope.documents) this.insertDocument(document)
    for (const recipient of envelope.recipients) this.insertRecipient(recipient)
    for (const field of envelope.fields) this.insertField(field)

    this.documentOrder = Object.freeze(
      [...envelope.documents]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((d) => d.id),
    )
    this.recipientOrder = Object.freeze(
      [...envelope.recipients]
        .sort((a, b) => a.routingOrder - b.routingOrder)
        .map((r) => r.id),
    )
  }

  // Reads

  getMeta(): EnvelopeMeta {
    return this.meta
  }

  getField(id: FieldId): Field | undefined {
    return this.fields.get(id)
  }

  /** Throws when the field is absent, for call sites where absence is a bug. */
  requireField(id: FieldId): Field {
    const field = this.fields.get(id)
    if (!field) {
      throw new InkSignError('UNKNOWN_FIELD', `No field with id ${id}`, { fieldId: id })
    }
    return field
  }

  getValue(id: FieldId): FieldValue {
    return this.values.get(id) ?? EMPTY_VALUE
  }

  getRecipient(id: RecipientId): Recipient | undefined {
    return this.recipients.get(id)
  }

  requireRecipient(id: RecipientId): Recipient {
    const recipient = this.recipients.get(id)
    if (!recipient) {
      throw new InkSignError('UNKNOWN_RECIPIENT', `No recipient with id ${id}`, {
        recipientId: id,
      })
    }
    return recipient
  }

  getDocument(id: DocumentId): SignatureDocument | undefined {
    return this.documents.get(id)
  }

  requireDocument(id: DocumentId): SignatureDocument {
    const document = this.documents.get(id)
    if (!document) {
      throw new InkSignError('UNKNOWN_DOCUMENT', `No document with id ${id}`, {
        documentId: id,
      })
    }
    return document
  }

  documentIds(): readonly DocumentId[] {
    return this.documentOrder
  }

  recipientIds(): readonly RecipientId[] {
    return this.recipientOrder
  }

  fieldIds(): readonly FieldId[] {
    return this.cachedArray('all', this.fields.keys())
  }

  fieldIdsForDocument(id: DocumentId): readonly FieldId[] {
    const set = this.byDocument.get(id)
    if (!set) return EMPTY_IDS
    return this.cachedArray(`doc:${id}`, set)
  }

  fieldIdsForRecipient(id: RecipientId): readonly FieldId[] {
    const set = this.byRecipient.get(id)
    if (!set) return EMPTY_IDS
    return this.cachedArray(`rcp:${id}`, set)
  }

  /**
   * Fields on one page, in tab order. This is the hot path for the viewer: it
   * runs on every page that scrolls into view.
   */
  fieldIdsForPage(documentId: DocumentId, page: number): readonly FieldId[] {
    const key = `${documentId}:${page}`
    const set = this.byPage.get(key)
    if (!set) return EMPTY_IDS
    const cacheKey = `page:${key}`
    const cached = this.arrayCache.get(cacheKey)
    if (cached) return cached
    const sorted = Object.freeze(
      Array.from(set).sort((a, b) => {
        const fa = this.fields.get(a)
        const fb = this.fields.get(b)
        if (!fa || !fb) return 0
        const ta = fa.tabOrder
        const tb = fb.tabOrder
        if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb
        // Reading order: top to bottom, then left to right.
        if (fa.rect.y !== fb.rect.y) return fa.rect.y - fb.rect.y
        return fa.rect.x - fb.rect.x
      }),
    )
    this.arrayCache.set(cacheKey, sorted)
    return sorted
  }

  /** Every value currently captured, for serialization and sealing. */
  valueEntries(): readonly (readonly [FieldId, FieldValue])[] {
    return Array.from(this.values.entries())
  }

  // Writes

  /** Runs `fn` with notifications held until it returns. */
  batch<T>(fn: () => T): T {
    return this.notifier.batch(fn)
  }

  setValue(id: FieldId, value: FieldValue): void {
    if (!this.fields.has(id)) {
      throw new InkSignError('UNKNOWN_FIELD', `No field with id ${id}`, { fieldId: id })
    }
    const previous = this.values.get(id)
    if (previous && valuesEqual(previous, value)) return
    if (value.kind === 'empty') this.values.delete(id)
    else this.values.set(id, Object.freeze(value))
    this.notifier.mark(topics.value(id))
    this.touch()
  }

  setValues(entries: Iterable<readonly [FieldId, FieldValue]>): void {
    this.batch(() => {
      for (const [id, value] of entries) this.setValue(id, value)
    })
  }

  clearValue(id: FieldId): void {
    this.setValue(id, EMPTY_VALUE)
  }

  updateField(id: FieldId, patch: Partial<Omit<Field, 'id'>>): void {
    const current = this.requireField(id)
    const next = Object.freeze({ ...current, ...patch }) as Field
    const pageChanged = next.rect.page !== current.rect.page
    const documentChanged = next.documentId !== current.documentId
    const recipientChanged = next.recipientId !== current.recipientId

    if (documentChanged || pageChanged || recipientChanged) {
      this.removeFromIndexes(current)
      this.fields.set(id, next)
      this.addToIndexes(next)
      this.notifier.mark(topics.structure)
    } else {
      this.fields.set(id, next)
      // Geometry changes reorder the page, so drop that page's cached array.
      this.arrayCache.delete(`page:${next.documentId}:${next.rect.page}`)
    }
    this.notifier.mark(topics.field(id))
    this.notifier.mark(topics.page(next.documentId, next.rect.page))
    this.touch()
  }

  addField(field: Field): void {
    if (this.fields.has(field.id)) {
      throw new InkSignError('INVALID_ENVELOPE', `Duplicate field id ${field.id}`, {
        fieldId: field.id,
      })
    }
    this.insertField(field)
    this.notifier.mark(topics.structure)
    this.notifier.mark(topics.page(field.documentId, field.rect.page))
    this.touch()
  }

  removeField(id: FieldId): void {
    const field = this.fields.get(id)
    if (!field) return
    this.removeFromIndexes(field)
    this.fields.delete(id)
    this.values.delete(id)
    this.notifier.mark(topics.field(id))
    this.notifier.mark(topics.value(id))
    this.notifier.mark(topics.structure)
    this.notifier.mark(topics.page(field.documentId, field.rect.page))
    this.touch()
  }

  updateRecipient(id: RecipientId, patch: Partial<Omit<Recipient, 'id'>>): void {
    const current = this.requireRecipient(id)
    const next = Object.freeze({ ...current, ...patch }) as Recipient
    this.recipients.set(id, next)
    if (next.routingOrder !== current.routingOrder) {
      this.recipientOrder = Object.freeze(
        Array.from(this.recipients.values())
          .sort((a, b) => a.routingOrder - b.routingOrder)
          .map((r) => r.id),
      )
      this.notifier.mark(topics.structure)
    }
    this.notifier.mark(topics.recipient(id))
    this.touch()
  }

  updateDocument(id: DocumentId, patch: Partial<Omit<SignatureDocument, 'id'>>): void {
    const current = this.requireDocument(id)
    this.documents.set(id, Object.freeze({ ...current, ...patch }) as SignatureDocument)
    this.notifier.mark(topics.document(id))
    this.touch()
  }

  setStatus(status: EnvelopeStatus, at: Timestamp = Date.now()): void {
    if (this.meta.status === status) return
    this.meta = Object.freeze({ ...this.meta, status, updatedAt: at }) as EnvelopeMeta
    this.notifier.mark(topics.envelope)
  }

  patchMeta(patch: Partial<Omit<EnvelopeMeta, 'id'>>): void {
    this.meta = Object.freeze({ ...this.meta, ...patch, updatedAt: Date.now() }) as EnvelopeMeta
    this.notifier.mark(topics.envelope)
  }

  // Subscriptions

  subscribe(topic: string, listener: Listener): Unsubscribe {
    return this.notifier.subscribe(topic, listener)
  }

  subscribeField(id: FieldId, listener: Listener): Unsubscribe {
    return this.notifier.subscribe(topics.field(id), listener)
  }

  subscribeValue(id: FieldId, listener: Listener): Unsubscribe {
    return this.notifier.subscribe(topics.value(id), listener)
  }

  subscribeRecipient(id: RecipientId, listener: Listener): Unsubscribe {
    return this.notifier.subscribe(topics.recipient(id), listener)
  }

  subscribePage(documentId: DocumentId, page: number, listener: Listener): Unsubscribe {
    return this.notifier.subscribe(topics.page(documentId, page), listener)
  }

  subscribeEnvelope(listener: Listener): Unsubscribe {
    return this.notifier.subscribe(topics.envelope, listener)
  }

  subscribeStructure(listener: Listener): Unsubscribe {
    return this.notifier.subscribe(topics.structure, listener)
  }

  /** Delivers any pending notifications now, rather than on the microtask. */
  flush(): void {
    this.notifier.flush()
  }

  get listenerCount(): number {
    return this.notifier.listenerCount
  }

  // Serialization

  /** Rebuilds a plain envelope object, suitable for JSON or transport. */
  toEnvelope(): Envelope {
    const envelope: Envelope = {
      id: this.meta.id,
      status: this.meta.status,
      subject: this.meta.subject,
      documents: this.documentOrder.map((id) => this.documents.get(id) as SignatureDocument),
      recipients: this.recipientOrder.map((id) => this.recipients.get(id) as Recipient),
      fields: Array.from(this.fields.values()),
      settings: this.meta.settings,
      createdAt: this.meta.createdAt,
      updatedAt: this.meta.updatedAt,
    }
    return withOptional(envelope, {
      message: this.meta.message,
      sentAt: this.meta.sentAt,
      completedAt: this.meta.completedAt,
      voidedAt: this.meta.voidedAt,
      voidReason: this.meta.voidReason,
      templateId: this.meta.templateId,
      metadata: this.meta.metadata,
    })
  }

  // Internals

  private insertDocument(document: SignatureDocument): void {
    this.documents.set(document.id, Object.freeze({ ...document }) as SignatureDocument)
  }

  private insertRecipient(recipient: Recipient): void {
    this.recipients.set(recipient.id, Object.freeze({ ...recipient }) as Recipient)
  }

  private insertField(field: Field): void {
    const frozen = Object.freeze({ ...field }) as Field
    this.fields.set(frozen.id, frozen)
    this.addToIndexes(frozen)
  }

  private addToIndexes(field: Field): void {
    addTo(this.byDocument, field.documentId, field.id)
    this.arrayCache.delete(`doc:${field.documentId}`)

    if (field.recipientId !== undefined) {
      addTo(this.byRecipient, field.recipientId, field.id)
      this.arrayCache.delete(`rcp:${field.recipientId}`)
    }

    const pageKey = `${field.documentId}:${field.rect.page}`
    addTo(this.byPage, pageKey, field.id)
    this.arrayCache.delete(`page:${pageKey}`)
    this.arrayCache.delete('all')
  }

  private removeFromIndexes(field: Field): void {
    removeFrom(this.byDocument, field.documentId, field.id)
    this.arrayCache.delete(`doc:${field.documentId}`)

    if (field.recipientId !== undefined) {
      removeFrom(this.byRecipient, field.recipientId, field.id)
      this.arrayCache.delete(`rcp:${field.recipientId}`)
    }

    const pageKey = `${field.documentId}:${field.rect.page}`
    removeFrom(this.byPage, pageKey, field.id)
    this.arrayCache.delete(`page:${pageKey}`)
    this.arrayCache.delete('all')
  }

  private cachedArray(key: string, source: Iterable<FieldId>): readonly FieldId[] {
    const cached = this.arrayCache.get(key)
    if (cached) return cached
    const frozen = Object.freeze(Array.from(source))
    this.arrayCache.set(key, frozen)
    return frozen
  }

  private touch(): void {
    this.meta = Object.freeze({ ...this.meta, updatedAt: Date.now() }) as EnvelopeMeta
  }
}

/** Envelope attributes without the collections, which live in the indexes. */
export interface EnvelopeMeta {
  readonly id: EnvelopeId
  readonly status: EnvelopeStatus
  readonly subject: string
  readonly message?: string
  readonly settings: Envelope['settings']
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
  readonly sentAt?: Timestamp
  readonly completedAt?: Timestamp
  readonly voidedAt?: Timestamp
  readonly voidReason?: string
  readonly templateId?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export const EMPTY_VALUE: FieldValue = Object.freeze({ kind: 'empty' as const })

function addTo<K>(map: Map<K, Set<FieldId>>, key: K, id: FieldId): void {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  set.add(id)
}

function removeFrom<K>(map: Map<K, Set<FieldId>>, key: K, id: FieldId): void {
  const set = map.get(key)
  if (!set) return
  set.delete(id)
  if (set.size === 0) map.delete(key)
}

/**
 * Compares two values structurally. Ink is compared by its stroke data so that
 * re-adopting an identical signature does not mark the envelope dirty.
 */
export function valuesEqual(a: FieldValue, b: FieldValue): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'empty':
      return true
    case 'ink': {
      const other = b as Extract<FieldValue, { kind: 'ink' }>
      return (
        a.value.source === other.value.source &&
        a.value.width === other.value.width &&
        a.value.height === other.value.height &&
        a.value.text === other.value.text &&
        a.value.typeface === other.value.typeface &&
        pathsEqual(a.value.paths, other.value.paths)
      )
    }
    case 'file': {
      const other = b as Extract<FieldValue, { kind: 'file' }>
      if (a.value.length !== other.value.length) return false
      return a.value.every((ref, i) => ref.key === other.value[i]?.key)
    }
    default:
      return (a as { value: unknown }).value === (b as { value: unknown }).value
  }
}

function pathsEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((path, i) => path === b[i])
}

/**
 * Assigns only the defined entries of `extra`, which `exactOptionalPropertyTypes`
 * requires: an explicit `undefined` is not the same as an absent key.
 */
function withOptional<T extends object>(base: T, extra: Record<string, unknown>): T {
  const out = base as Record<string, unknown>
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) out[key] = value
  }
  return out as T
}
