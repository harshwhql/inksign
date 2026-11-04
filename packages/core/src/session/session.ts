import type { Adapters } from '../adapters/index.js'
import { recipientFacts, systemClock } from '../adapters/index.js'
import { type AuditContext, AuditTrail } from '../audit/trail.js'
import { assertActionable, deriveEnvelopeStatus } from '../envelope/lifecycle.js'
import { InkSignError, type ValidationIssue } from '../errors.js'
import { isFieldVisible } from '../fields/conditions.js'
import {
  defaultValue,
  isAutoFilled,
  isEmpty,
  isInkField,
  isInteractive,
} from '../fields/registry.js'
import { validateValue } from '../fields/validate.js'
import { sessionId as newSessionId } from '../id.js'
import { canRecipientAct } from '../recipients/routing.js'
import { type EnvelopeStore, topics } from '../store/envelope-store.js'
import { type Listener, TopicNotifier, type Unsubscribe } from '../store/signal.js'
import type {
  Field,
  FieldId,
  FieldValue,
  InkSignature,
  Recipient,
  RecipientId,
  Timestamp,
} from '../types.js'

/**
 * Where the recipient is in the ceremony. The session advances through these
 * in order, and refuses input that does not belong to the current step.
 */
export type SessionStage =
  /** Waiting on identity verification. */
  | 'authenticating'
  /** Waiting on the electronic record disclosure. */
  | 'consent'
  /** Filling in fields. */
  | 'filling'
  /** Everything required is filled; waiting on the recipient to confirm. */
  | 'review'
  /** The recipient finished. */
  | 'completed'
  /** The recipient refused. */
  | 'declined'
  /** The recipient handed their turn to someone else. */
  | 'delegated'

export interface SessionProgress {
  /** Fields assigned to this recipient that are currently visible. */
  total: number
  /** Of those, how many hold a value. */
  filled: number
  /** Required and visible but still empty. */
  requiredRemaining: number
  /** 0 to 1, over required fields. Reaches 1 when nothing is outstanding. */
  ratio: number
}

export interface SessionOptions {
  adapters?: Adapters
  trail?: AuditTrail
  /** Context recorded on audit entries, merged with the context adapter's. */
  context?: AuditContext
  /** Skip the routing check. For sender previews, never for a real ceremony. */
  ignoreRouting?: boolean
}

/** Stage changes and progress updates are published on these topics. */
export const sessionTopics = {
  stage: 'session:stage',
  progress: 'session:progress',
  issues: 'session:issues',
} as const

/**
 * Drives one recipient through one envelope.
 *
 * The session is the gatekeeper. Every rule that decides whether a recipient
 * may do something now lives here rather than in the UI, so a custom
 * front end cannot accidentally skip consent or let someone sign out of turn.
 * The UI asks the session what to show and what is allowed; it never decides.
 *
 * Reads are cheap and synchronous. Only the operations that touch the audit
 * trail or an adapter are asynchronous, which keeps keystroke handling off the
 * promise queue.
 */
export class SigningSession {
  readonly id: string
  readonly recipientId: RecipientId

  private readonly store: EnvelopeStore
  private readonly adapters: Adapters
  private readonly trail: AuditTrail
  private readonly notifier = new TopicNotifier()
  private readonly baseContext: AuditContext | undefined
  private readonly ignoreRouting: boolean

  private stageValue: SessionStage
  private consentAccepted = false
  private authenticated: boolean
  private adoptedSignature: InkSignature | undefined
  private issuesByField = new Map<FieldId, readonly ValidationIssue[]>()
  private startedAt: Timestamp

  constructor(store: EnvelopeStore, recipientId: RecipientId, options: SessionOptions = {}) {
    this.store = store
    this.recipientId = recipientId
    this.adapters = options.adapters ?? {}
    this.trail = options.trail ?? new AuditTrail(store.getMeta().id)
    this.baseContext = options.context
    this.ignoreRouting = options.ignoreRouting ?? false
    this.id = newSessionId()
    this.startedAt = this.now()

    const recipient = store.requireRecipient(recipientId)
    assertActionable(store.getMeta().status)

    if (!this.ignoreRouting) {
      const recipients = store.recipientIds().map((id) => store.requireRecipient(id))
      if (!canRecipientAct(recipientId, recipients)) {
        throw new InkSignError(
          'NOT_YOUR_TURN',
          `It is not ${recipient.name}'s turn to act on this envelope`,
          { recipientId, status: recipient.status },
        )
      }
    }

    const needsAuth = recipient.auth !== undefined && recipient.auth.kind !== 'none'
    this.authenticated = !needsAuth
    this.stageValue = needsAuth
      ? 'authenticating'
      : store.getMeta().settings.requireConsent
        ? 'consent'
        : 'filling'
  }

  // Reads

  get stage(): SessionStage {
    return this.stageValue
  }

  get recipient(): Recipient {
    return this.store.requireRecipient(this.recipientId)
  }

  get auditTrail(): AuditTrail {
    return this.trail
  }

  /** Signature adopted for this session, reused across every ink field. */
  get signature(): InkSignature | undefined {
    return this.adoptedSignature
  }

  /**
   * Fields this recipient is responsible for, in tab order, excluding any
   * hidden by an unmet condition.
   */
  assignedFields(): readonly Field[] {
    const all = this.store
      .fieldIdsForRecipient(this.recipientId)
      .map((id) => this.store.requireField(id))
    return all.filter((field) => this.isVisible(field)).sort(compareFields)
  }

  /** Whether a field is currently shown, given the values entered so far. */
  isVisible(field: Field): boolean {
    if (!field.conditions || field.conditions.length === 0) return true
    const fields = new Map(this.store.fieldIds().map((id) => [id, this.store.requireField(id)]))
    return isFieldVisible(field, fields, (id) => this.store.getValue(id))
  }

  getValue(id: FieldId): FieldValue {
    return this.store.getValue(id)
  }

  /** Validation issues for one field, from the last time it was written. */
  issuesFor(id: FieldId): readonly ValidationIssue[] {
    return this.issuesByField.get(id) ?? EMPTY_ISSUES
  }

  /** Every outstanding issue across this recipient's fields. */
  allIssues(): readonly ValidationIssue[] {
    const out: ValidationIssue[] = []
    for (const issues of this.issuesByField.values()) out.push(...issues)
    return out
  }

  progress(): SessionProgress {
    const fields = this.assignedFields()
    let filled = 0
    let required = 0
    let requiredRemaining = 0

    for (const field of fields) {
      const empty = isEmpty(this.store.getValue(field.id))
      if (!empty) filled += 1
      if (field.validation?.required) {
        required += 1
        if (empty) requiredRemaining += 1
      }
    }

    return {
      total: fields.length,
      filled,
      requiredRemaining,
      ratio: required === 0 ? 1 : (required - requiredRemaining) / required,
    }
  }

  /** The next required field still empty, for a "next" affordance. */
  nextRequiredField(): Field | undefined {
    return this.assignedFields().find(
      (field) => field.validation?.required && isEmpty(this.store.getValue(field.id)),
    )
  }

  /** Whether `finish` would succeed right now. */
  canFinish(): boolean {
    return this.blockingReason() === undefined
  }

  /**
   * Why the recipient cannot finish yet, or `undefined` when they can. Use
   * this to label a disabled finish button with something useful.
   */
  blockingReason():
    | {
        code:
          | 'AUTH_REQUIRED'
          | 'CONSENT_REQUIRED'
          | 'REQUIRED_FIELDS_INCOMPLETE'
          | 'VALIDATION_FAILED'
        message: string
      }
    | undefined {
    if (!this.authenticated) {
      return { code: 'AUTH_REQUIRED', message: 'Identity has not been verified yet' }
    }
    if (this.store.getMeta().settings.requireConsent && !this.consentAccepted) {
      return {
        code: 'CONSENT_REQUIRED',
        message: 'The electronic record disclosure has not been accepted',
      }
    }
    if (this.store.getMeta().settings.enforceRequiredFields) {
      const { requiredRemaining } = this.progress()
      if (requiredRemaining > 0) {
        return {
          code: 'REQUIRED_FIELDS_INCOMPLETE',
          message:
            requiredRemaining === 1
              ? '1 required field is still empty'
              : `${requiredRemaining} required fields are still empty`,
        }
      }
    }
    const errors = this.allIssues().filter((issue) => issue.severity === 'error')
    const first = errors[0]
    if (first) return { code: 'VALIDATION_FAILED', message: first.message }
    return undefined
  }

  // Writes

  /** Verifies the recipient's identity through the identity adapter. */
  async authenticate(response: string, challengeId?: string): Promise<boolean> {
    const recipient = this.recipient
    const method = recipient.auth
    if (!method || method.kind === 'none') {
      this.authenticated = true
      this.advanceFromAuth()
      return true
    }

    const identity = this.adapters.identity
    if (!identity) {
      throw new InkSignError(
        'ADAPTER_MISSING',
        `This envelope requires ${method.kind} authentication, but no identity adapter was configured`,
        { method: method.kind },
      )
    }

    const result = await identity.verify({
      envelopeId: this.store.getMeta().id,
      recipientId: this.recipientId,
      method,
      response,
      ...(challengeId !== undefined ? { challengeId } : {}),
    })

    if (!result.ok) {
      this.store.updateRecipient(this.recipientId, { status: 'auth_failed' })
      await this.record('recipient_auth_failed', {
        detail: {
          method: method.kind,
          ...(result.attemptsRemaining !== undefined
            ? { attemptsRemaining: result.attemptsRemaining }
            : {}),
        },
      })
      return false
    }

    this.authenticated = true
    await this.record('recipient_authenticated', {
      detail: { method: method.kind, ...(result.evidence ?? {}) },
    })
    this.advanceFromAuth()
    return true
  }

  /** Records acceptance of the electronic record disclosure. */
  async acceptConsent(): Promise<void> {
    if (!this.authenticated) {
      throw new InkSignError('AUTH_REQUIRED', 'Verify identity before accepting the disclosure')
    }
    this.consentAccepted = true
    await this.record('consent_accepted')
    this.setStage('filling')
    await this.prefill()
  }

  /** Records refusal of the disclosure, which declines the envelope. */
  async declineConsent(reason?: string): Promise<void> {
    await this.record('consent_declined', reason !== undefined ? { detail: { reason } } : {})
    await this.applyDecline(reason ?? 'Declined the electronic record disclosure')
  }

  /**
   * Writes a value.
   *
   * Validation runs here and the issues are published, but a failing value is
   * still stored. Rejecting it would fight the person typing: an email is
   * invalid for most of the time it takes to enter one. `finish` is where
   * invalid values actually block.
   */
  setValue(id: FieldId, value: FieldValue): readonly ValidationIssue[] {
    this.assertFillable()
    const field = this.store.requireField(id)

    if (field.recipientId !== this.recipientId) {
      throw new InkSignError(
        'FIELD_NOT_ASSIGNED',
        `Field ${field.label ?? id} is not assigned to this recipient`,
        { fieldId: id, assignedTo: field.recipientId },
      )
    }
    if (field.readOnly) {
      throw new InkSignError('FIELD_READ_ONLY', `Field ${field.label ?? id} is read only`, {
        fieldId: id,
      })
    }
    if (!this.isVisible(field)) {
      throw new InkSignError(
        'FIELD_HIDDEN',
        `Field ${field.label ?? id} is hidden by a condition and cannot be filled in`,
        { fieldId: id },
      )
    }

    const issues = validateValue(field, value, {
      enforceRequired: false,
      ...(this.store.getMeta().settings.locale !== undefined
        ? { locale: this.store.getMeta().settings.locale }
        : {}),
    })

    if (issues.some((issue) => issue.code === 'VALUE_TYPE_MISMATCH')) {
      throw new InkSignError(
        'VALUE_TYPE_MISMATCH',
        `Field ${field.label ?? id} cannot hold a ${value.kind} value`,
        { fieldId: id, expected: field.type, received: value.kind },
      )
    }

    this.store.setValue(id, value)
    this.setIssues(id, issues)
    this.notifier.mark(sessionTopics.progress)
    return issues
  }

  /** Clears a value and drops its issues. */
  clearValue(id: FieldId): void {
    this.assertFillable()
    const field = this.store.requireField(id)
    if (field.recipientId !== this.recipientId) {
      throw new InkSignError('FIELD_NOT_ASSIGNED', 'Field is not assigned to this recipient', {
        fieldId: id,
      })
    }
    this.store.clearValue(id)
    this.setIssues(id, EMPTY_ISSUES)
    this.notifier.mark(sessionTopics.progress)
  }

  /**
   * Adopts a signature for the session and applies it to every empty ink
   * field, which is the behaviour recipients expect: they draw once, not once
   * per page.
   *
   * Initials fields receive the signature only when it was typed, since a
   * drawn full signature is the wrong mark for an initials box.
   */
  async adoptSignature(ink: InkSignature): Promise<readonly FieldId[]> {
    this.assertFillable()
    this.adoptedSignature = ink
    const applied: FieldId[] = []

    this.store.batch(() => {
      for (const field of this.assignedFields()) {
        if (!isInkField(field.type) || field.readOnly) continue
        if (!isEmpty(this.store.getValue(field.id))) continue
        if (field.type === 'initials' && ink.source === 'drawn') continue
        this.store.setValue(field.id, { kind: 'ink', value: ink })
        applied.push(field.id)
      }
    })

    await this.record('signature_adopted', {
      detail: { source: ink.source, appliedTo: applied.length },
    })
    this.notifier.mark(sessionTopics.progress)
    return applied
  }

  /** Applies the adopted signature to one field. */
  applySignature(id: FieldId): void {
    const ink = this.adoptedSignature
    if (!ink) {
      throw new InkSignError('VALIDATION_FAILED', 'No signature has been adopted in this session')
    }
    this.setValue(id, { kind: 'ink', value: ink })
  }

  /**
   * Completes this recipient's turn.
   *
   * Throws rather than returning a result, because finishing is the one
   * operation where a silent partial success would be the worst outcome. Call
   * `blockingReason` first to render a disabled state.
   */
  async finish(): Promise<void> {
    this.assertFillable()

    const blocking = this.blockingReason()
    if (blocking) {
      throw new InkSignError(blocking.code, blocking.message, { recipientId: this.recipientId })
    }

    // Re-validate with required enforcement on, so a value that was legal to
    // type but illegal to submit is caught here.
    const errors: ValidationIssue[] = []
    for (const field of this.assignedFields()) {
      const issues = validateValue(field, this.store.getValue(field.id), {
        enforceRequired: this.store.getMeta().settings.enforceRequiredFields,
      })
      if (issues.length > 0) {
        this.setIssues(field.id, issues)
        errors.push(...issues.filter((issue) => issue.severity === 'error'))
      }
    }
    const firstError = errors[0]
    if (firstError) {
      this.notifier.mark(sessionTopics.issues)
      throw new InkSignError('VALIDATION_FAILED', firstError.message, { issues: errors })
    }

    const at = this.now()
    const appliedInk = this.assignedFields().some(
      (field) => isInkField(field.type) && !isEmpty(this.store.getValue(field.id)),
    )

    this.store.updateRecipient(this.recipientId, {
      status: 'completed',
      completedAt: at,
    })

    await this.record('recipient_signed', {
      at,
      detail: { fields: this.progress().filled, appliedInk },
    })

    this.reconcileEnvelopeStatus(at)
    this.setStage('completed')
  }

  /** Refuses to sign, which declines the whole envelope. */
  async decline(reason: string): Promise<void> {
    if (!this.store.getMeta().settings.allowDecline) {
      throw new InkSignError('DECLINE_NOT_ALLOWED', 'This envelope does not allow declining')
    }
    await this.record('recipient_declined', { detail: { reason } })
    await this.applyDecline(reason)
  }

  /** Hands this turn to someone else, keeping the chain in the audit trail. */
  async delegate(to: { name: string; email?: string; phone?: string }): Promise<void> {
    if (!this.store.getMeta().settings.allowDelegation) {
      throw new InkSignError('DELEGATION_NOT_ALLOWED', 'This envelope does not allow delegation')
    }
    this.store.updateRecipient(this.recipientId, { status: 'delegated' })
    await this.record('recipient_delegated', {
      detail: { toName: to.name, ...(to.email !== undefined ? { toEmail: to.email } : {}) },
    })
    this.setStage('delegated')
  }

  /** Records that the recipient opened a document. */
  async recordView(documentId: string): Promise<void> {
    await this.record('document_viewed', { documentId })
  }

  // Subscriptions

  subscribe(topic: string, listener: Listener): Unsubscribe {
    return this.notifier.subscribe(topic, listener)
  }

  onStageChange(listener: Listener): Unsubscribe {
    return this.notifier.subscribe(sessionTopics.stage, listener)
  }

  onProgress(listener: Listener): Unsubscribe {
    return this.notifier.subscribe(sessionTopics.progress, listener)
  }

  onIssues(listener: Listener): Unsubscribe {
    return this.notifier.subscribe(sessionTopics.issues, listener)
  }

  /** Subscribes to one field's value, so a field input re-renders alone. */
  onFieldValue(id: FieldId, listener: Listener): Unsubscribe {
    return this.store.subscribe(topics.value(id), listener)
  }

  /** A serializable snapshot, for resuming an interrupted ceremony. */
  snapshot(): SessionSnapshot {
    return {
      sessionId: this.id,
      recipientId: this.recipientId,
      stage: this.stageValue,
      consentAccepted: this.consentAccepted,
      authenticated: this.authenticated,
      startedAt: this.startedAt,
      ...(this.adoptedSignature !== undefined ? { signature: this.adoptedSignature } : {}),
    }
  }

  /** Restores a snapshot taken by `snapshot`. */
  restore(snapshot: SessionSnapshot): void {
    this.consentAccepted = snapshot.consentAccepted
    this.authenticated = snapshot.authenticated
    this.adoptedSignature = snapshot.signature
    this.startedAt = snapshot.startedAt
    this.setStage(snapshot.stage)
  }

  // Internals

  private advanceFromAuth(): void {
    this.setStage(this.store.getMeta().settings.requireConsent ? 'consent' : 'filling')
    if (this.stageValue === 'filling') void this.prefill()
  }

  /**
   * Fills the values the engine owns rather than the recipient: the signing
   * date, the recipient's name and email, and any default option.
   */
  private async prefill(): Promise<void> {
    const recipient = this.recipient
    const facts = recipientFacts(recipient)
    const at = this.now()

    this.store.batch(() => {
      for (const field of this.assignedFields()) {
        if (!isEmpty(this.store.getValue(field.id))) continue

        if (field.type === 'date_signed') {
          this.store.setValue(field.id, { kind: 'date', value: at })
          continue
        }
        if (isAutoFilled(field.type)) {
          const fact = facts[field.type]
          if (fact) this.store.setValue(field.id, { kind: 'text', value: fact })
          continue
        }
        if (!isInteractive(field)) continue

        const preset = defaultValue(field)
        if (preset.kind !== 'empty') this.store.setValue(field.id, preset)
      }
    })

    this.notifier.mark(sessionTopics.progress)
  }

  private async applyDecline(reason: string): Promise<void> {
    const at = this.now()
    this.store.updateRecipient(this.recipientId, { status: 'declined', declineReason: reason })
    this.store.setStatus('declined', at)
    this.store.patchMeta({ voidReason: reason })
    this.setStage('declined')
    await this.dispatchWebhook('envelope.declined', { reason })
  }

  private reconcileEnvelopeStatus(at: Timestamp): void {
    const recipients = this.store.recipientIds().map((id) => this.store.requireRecipient(id))
    const next = deriveEnvelopeStatus(this.store.getMeta().status, recipients)
    if (next === this.store.getMeta().status) return

    this.store.setStatus(next, at)
    if (next === 'completed') {
      this.store.patchMeta({ completedAt: at })
      void this.record('envelope_completed', { at }).then(() =>
        this.dispatchWebhook('envelope.completed', {}),
      )
    }
  }

  private async dispatchWebhook(type: string, payload: Record<string, unknown>): Promise<void> {
    const webhook = this.adapters.webhook
    if (!webhook) return
    try {
      await webhook.dispatch({
        type,
        envelopeId: this.store.getMeta().id,
        at: this.now(),
        payload,
      })
    } catch (cause) {
      // A webhook failure must not roll back a completed signature. The host
      // is responsible for retrying from the audit trail.
      throw new InkSignError(
        'ADAPTER_FAILED',
        `Webhook dispatch for ${type} failed`,
        { type },
        {
          cause,
        },
      )
    }
  }

  private async record(
    action: Parameters<AuditTrail['append']>[0]['action'],
    extra: {
      at?: Timestamp
      documentId?: string
      fieldId?: FieldId
      detail?: Record<string, unknown>
    } = {},
  ): Promise<void> {
    const captured = await this.captureContext()
    await this.trail.append({
      action,
      recipientId: this.recipientId,
      ...(extra.at !== undefined ? { at: extra.at } : {}),
      ...(extra.documentId !== undefined ? { documentId: extra.documentId } : {}),
      ...(extra.fieldId !== undefined ? { fieldId: extra.fieldId } : {}),
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
      ...(captured !== undefined ? { context: captured } : {}),
    })
  }

  private async captureContext(): Promise<AuditContext | undefined> {
    const adapter = this.adapters.context
    if (!adapter) return this.baseContext
    try {
      const captured = await adapter.capture()
      return { ...captured, ...this.baseContext }
    } catch {
      // Context is supporting evidence, not a precondition. Losing it must
      // not stop someone from signing.
      return this.baseContext
    }
  }

  private assertFillable(): void {
    assertActionable(this.store.getMeta().status)
    if (!this.authenticated) {
      throw new InkSignError('AUTH_REQUIRED', 'Verify identity before filling in fields')
    }
    if (this.store.getMeta().settings.requireConsent && !this.consentAccepted) {
      throw new InkSignError(
        'CONSENT_REQUIRED',
        'Accept the electronic record disclosure before filling in fields',
      )
    }
    if (
      this.stageValue === 'completed' ||
      this.stageValue === 'declined' ||
      this.stageValue === 'delegated'
    ) {
      throw new InkSignError('ENVELOPE_CLOSED', `This session is already ${this.stageValue}`, {
        stage: this.stageValue,
      })
    }
  }

  private setStage(stage: SessionStage): void {
    if (this.stageValue === stage) return
    this.stageValue = stage
    this.notifier.mark(sessionTopics.stage)
  }

  private setIssues(id: FieldId, issues: readonly ValidationIssue[]): void {
    const next = new Map(this.issuesByField)
    if (issues.length === 0) next.delete(id)
    else next.set(id, issues)
    this.issuesByField = next
    this.notifier.mark(sessionTopics.issues)
  }

  private now(): Timestamp {
    return (this.adapters.clock ?? systemClock).now()
  }
}

export interface SessionSnapshot {
  sessionId: string
  recipientId: RecipientId
  stage: SessionStage
  consentAccepted: boolean
  authenticated: boolean
  startedAt: Timestamp
  signature?: InkSignature
}

const EMPTY_ISSUES: readonly ValidationIssue[] = Object.freeze([])

/** Tab order first, then reading order within a page, then by page. */
function compareFields(a: Field, b: Field): number {
  if (a.tabOrder !== undefined && b.tabOrder !== undefined && a.tabOrder !== b.tabOrder) {
    return a.tabOrder - b.tabOrder
  }
  if (a.rect.page !== b.rect.page) return a.rect.page - b.rect.page
  if (a.rect.y !== b.rect.y) return a.rect.y - b.rect.y
  return a.rect.x - b.rect.x
}

/** Opens a session for a recipient. */
export function createSession(
  store: EnvelopeStore,
  recipientId: RecipientId,
  options?: SessionOptions,
): SigningSession {
  return new SigningSession(store, recipientId, options)
}
