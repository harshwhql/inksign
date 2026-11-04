import { InkSignError, validationError } from '../errors.js'
import { describeField } from '../fields/registry.js'
import {
  documentId as newDocumentId,
  envelopeId as newEnvelopeId,
  fieldId as newFieldId,
  recipientId as newRecipientId,
} from '../id.js'
import type {
  AnchorPlacement,
  AuthMethod,
  DocumentId,
  DocumentSource,
  Envelope,
  EnvelopeId,
  EnvelopeSettings,
  Field,
  FieldCondition,
  FieldId,
  FieldOption,
  FieldStyle,
  FieldType,
  FieldValidation,
  Recipient,
  RecipientId,
  RecipientRole,
  SignatureDocument,
} from '../types.js'
import { validateEnvelope } from './validate.js'

export const defaultSettings: EnvelopeSettings = Object.freeze({
  requireConsent: true,
  enforceRequiredFields: true,
  allowDecline: true,
  allowDelegation: false,
  allowDownload: true,
  allowPrint: true,
  attachCertificate: true,
})

/** Short name the author uses to refer to a document, recipient or field. */
export type Alias = string

export interface DocumentInput {
  name: string
  source: DocumentSource
  pageCount?: number
  pageSizes?: SignatureDocument['pageSizes']
  supplemental?: SignatureDocument['supplemental']
  metadata?: Readonly<Record<string, unknown>>
}

export interface RecipientInput {
  name: string
  email?: string
  phone?: string
  /** Defaults to the order recipients were added, so they sign in sequence. */
  routingOrder?: number
  auth?: AuthMethod
  note?: string
  roleName?: string
  groupId?: string
  /** Alias of the recipient this one witnesses or notarizes. */
  attestsFor?: Alias
  metadata?: Readonly<Record<string, unknown>>
}

export interface FieldInput {
  /** Alias of the document this field sits on. Defaults to the only document. */
  document?: Alias
  /** Alias of the recipient who fills it in. Omit for a sender-filled field. */
  recipient?: Alias
  type: FieldType
  page?: number
  x?: number
  y?: number
  width?: number
  height?: number
  anchor?: AnchorPlacement | string
  label?: string
  tooltip?: string
  required?: boolean
  readOnly?: boolean
  validation?: FieldValidation
  style?: FieldStyle
  options?: readonly (FieldOption | string)[]
  formula?: string
  tabOrder?: number
  /** Conditions written against field aliases rather than generated IDs. */
  showWhen?: readonly (Omit<FieldCondition, 'whenField'> & { field: Alias })[]
  metadata?: Readonly<Record<string, unknown>>
}

/**
 * Fluent builder for an envelope.
 *
 * Aliases are the point of this API. Fields have to reference a document and a
 * recipient, and threading generated IDs through that by hand is where
 * misassignment bugs come from. Here the author names things once and refers
 * to those names, and the builder resolves them, failing loudly on a typo
 * rather than producing an envelope with an unassigned signature field.
 *
 * ```ts
 * const nda = createEnvelope({ subject: 'Mutual NDA' })
 *   .document('nda', { name: 'NDA.pdf', source: { kind: 'url', url } })
 *   .signer('alice', { name: 'Alice Chen', email: 'alice@example.com' })
 *   .signer('bob', { name: 'Bob Diaz', email: 'bob@example.com' })
 *   .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 640 })
 *   .field({ recipient: 'bob', type: 'signature', page: 0, x: 320, y: 640 })
 *   .build()
 * ```
 */
export class EnvelopeBuilder {
  private readonly id: EnvelopeId
  private subjectText: string
  private messageText: string | undefined
  private settingsPatch: Partial<EnvelopeSettings> = {}
  private metadataValue: Readonly<Record<string, unknown>> | undefined

  private readonly documents: { alias: Alias; document: SignatureDocument }[] = []
  private readonly recipients: { alias: Alias; recipient: Recipient; attestsFor?: Alias }[] = []
  private readonly fields: { alias: Alias; input: FieldInput; id: FieldId }[] = []

  private documentAliases = new Map<Alias, DocumentId>()
  private recipientAliases = new Map<Alias, RecipientId>()
  private fieldAliases = new Map<Alias, FieldId>()

  private autoAlias = 0

  constructor(init: { subject: string; id?: EnvelopeId; message?: string }) {
    this.id = init.id ?? newEnvelopeId()
    this.subjectText = init.subject
    this.messageText = init.message
  }

  subject(text: string): this {
    this.subjectText = text
    return this
  }

  message(text: string): this {
    this.messageText = text
    return this
  }

  settings(patch: Partial<EnvelopeSettings>): this {
    this.settingsPatch = { ...this.settingsPatch, ...patch }
    return this
  }

  metadata(data: Readonly<Record<string, unknown>>): this {
    this.metadataValue = { ...this.metadataValue, ...data }
    return this
  }

  /** Adds a document under an alias that fields can reference. */
  document(alias: Alias, input: DocumentInput): this {
    this.assertFreeAlias(this.documentAliases, alias, 'document')
    const id = newDocumentId()
    this.documentAliases.set(alias, id)

    const document: SignatureDocument = {
      id,
      name: input.name,
      source: input.source,
      order: this.documents.length,
      ...(input.pageCount !== undefined ? { pageCount: input.pageCount } : {}),
      ...(input.pageSizes !== undefined ? { pageSizes: input.pageSizes } : {}),
      ...(input.supplemental !== undefined ? { supplemental: input.supplemental } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }
    this.documents.push({ alias, document })
    return this
  }

  /** Adds a recipient with an explicit role. */
  recipient(alias: Alias, role: RecipientRole, input: RecipientInput): this {
    this.assertFreeAlias(this.recipientAliases, alias, 'recipient')
    const id = newRecipientId()
    this.recipientAliases.set(alias, id)

    const recipient: Recipient = {
      id,
      role,
      name: input.name,
      routingOrder: input.routingOrder ?? this.recipients.length + 1,
      status: 'created',
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.auth !== undefined ? { auth: input.auth } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.roleName !== undefined ? { roleName: input.roleName } : {}),
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }
    this.recipients.push({
      alias,
      recipient,
      ...(input.attestsFor !== undefined ? { attestsFor: input.attestsFor } : {}),
    })
    return this
  }

  signer(alias: Alias, input: RecipientInput): this {
    return this.recipient(alias, 'signer', input)
  }

  carbonCopy(alias: Alias, input: RecipientInput): this {
    return this.recipient(alias, 'carbon_copy', input)
  }

  approver(alias: Alias, input: RecipientInput): this {
    return this.recipient(alias, 'approver', input)
  }

  inPersonSigner(alias: Alias, input: RecipientInput): this {
    return this.recipient(alias, 'in_person_signer', input)
  }

  witness(alias: Alias, input: RecipientInput & { attestsFor: Alias }): this {
    return this.recipient(alias, 'witness', input)
  }

  notary(alias: Alias, input: RecipientInput & { attestsFor: Alias }): this {
    return this.recipient(alias, 'notary', input)
  }

  certifiedDelivery(alias: Alias, input: RecipientInput): this {
    return this.recipient(alias, 'certified_delivery', input)
  }

  /**
   * Places a field. Give it an alias when another field's `showWhen` needs to
   * reference it; otherwise one is generated.
   */
  field(input: FieldInput & { alias?: Alias }): this {
    const alias = input.alias ?? `field_${this.autoAlias++}`
    this.assertFreeAlias(this.fieldAliases, alias, 'field')
    const id = newFieldId()
    this.fieldAliases.set(alias, id)
    this.fields.push({ alias, input, id })
    return this
  }

  /** Places several fields at once. */
  addFields(inputs: readonly (FieldInput & { alias?: Alias })[]): this {
    for (const input of inputs) this.field(input)
    return this
  }

  /** The generated ID for an alias, available before `build`. */
  idFor(kind: 'document' | 'recipient' | 'field', alias: Alias): string | undefined {
    const source =
      kind === 'document'
        ? this.documentAliases
        : kind === 'recipient'
          ? this.recipientAliases
          : this.fieldAliases
    return source.get(alias)
  }

  /**
   * Resolves aliases, applies defaults and validates.
   *
   * @param options.validate Set to `false` to skip validation, which is useful
   * while a draft is still being assembled in an editor.
   */
  build(options: { validate?: boolean } = {}): Envelope {
    const now = Date.now()

    const fields: Field[] = this.fields.map(({ alias, input, id }) =>
      this.resolveField(alias, input, id),
    )

    const recipients: Recipient[] = this.recipients.map(({ recipient, attestsFor }) => {
      if (attestsFor === undefined) return recipient
      const target = this.recipientAliases.get(attestsFor)
      if (target === undefined) {
        throw new InkSignError(
          'UNKNOWN_RECIPIENT',
          `Recipient "${recipient.name}" attests for "${attestsFor}", which is not a recipient alias on this envelope`,
          { alias: attestsFor, known: Array.from(this.recipientAliases.keys()) },
        )
      }
      return { ...recipient, attestsFor: target }
    })

    const envelope: Envelope = {
      id: this.id,
      status: 'draft',
      subject: this.subjectText,
      documents: this.documents.map((entry) => entry.document),
      recipients,
      fields,
      settings: { ...defaultSettings, ...this.settingsPatch },
      createdAt: now,
      updatedAt: now,
      ...(this.messageText !== undefined ? { message: this.messageText } : {}),
      ...(this.metadataValue !== undefined ? { metadata: this.metadataValue } : {}),
    }

    if (options.validate !== false) {
      const result = validateEnvelope(envelope)
      if (!result.valid) throw validationError(result)
    }

    return envelope
  }

  private resolveField(alias: Alias, input: FieldInput, id: FieldId): Field {
    const documentId = this.resolveDocument(input.document, alias)
    const descriptor = describeField(input.type)

    const anchor: AnchorPlacement | undefined =
      typeof input.anchor === 'string' ? { text: input.anchor } : input.anchor

    const validation: FieldValidation | undefined =
      input.required !== undefined || input.validation
        ? {
            ...input.validation,
            ...(input.required !== undefined ? { required: input.required } : {}),
          }
        : undefined

    const options: readonly FieldOption[] | undefined = input.options?.map((option) =>
      typeof option === 'string' ? { value: option } : option,
    )

    const conditions: readonly FieldCondition[] | undefined = input.showWhen?.map((condition) => {
      const target = this.fieldAliases.get(condition.field)
      if (target === undefined) {
        throw new InkSignError(
          'UNKNOWN_FIELD',
          `Field "${alias}" is conditional on "${condition.field}", which is not a field alias on this envelope`,
          { alias: condition.field, known: Array.from(this.fieldAliases.keys()) },
        )
      }
      const { field: _ignored, ...rest } = condition
      return { ...rest, whenField: target }
    })

    const field: Field = {
      id,
      documentId,
      type: input.type,
      rect: {
        page: input.page ?? 0,
        x: input.x ?? 0,
        y: input.y ?? 0,
        width: input.width ?? descriptor.minSize.width,
        height: input.height ?? descriptor.minSize.height,
      },
      ...(this.resolveRecipient(input.recipient, alias) ?? {}),
      ...(anchor !== undefined ? { anchor } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.tooltip !== undefined ? { tooltip: input.tooltip } : {}),
      ...(validation !== undefined ? { validation } : {}),
      ...(input.style !== undefined ? { style: input.style } : {}),
      ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
      ...(options !== undefined ? { options } : {}),
      ...(conditions !== undefined ? { conditions } : {}),
      ...(input.formula !== undefined ? { formula: input.formula } : {}),
      ...(input.tabOrder !== undefined ? { tabOrder: input.tabOrder } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }
    return field
  }

  private resolveDocument(alias: Alias | undefined, fieldAlias: Alias): DocumentId {
    if (alias === undefined) {
      const only = this.documents[0]
      if (!only) {
        throw new InkSignError(
          'UNKNOWN_DOCUMENT',
          `Field "${fieldAlias}" has no document, and the envelope has none to default to`,
          { fieldAlias },
        )
      }
      if (this.documents.length > 1) {
        throw new InkSignError(
          'UNKNOWN_DOCUMENT',
          `Field "${fieldAlias}" must name a document, because the envelope has ${this.documents.length}`,
          { fieldAlias, documents: this.documents.map((d) => d.alias) },
        )
      }
      return only.document.id
    }

    const id = this.documentAliases.get(alias)
    if (id === undefined) {
      throw new InkSignError(
        'UNKNOWN_DOCUMENT',
        `Field "${fieldAlias}" names document "${alias}", which was never added`,
        { alias, known: Array.from(this.documentAliases.keys()) },
      )
    }
    return id
  }

  private resolveRecipient(
    alias: Alias | undefined,
    fieldAlias: Alias,
  ): { recipientId: RecipientId } | undefined {
    if (alias === undefined) return undefined
    const id = this.recipientAliases.get(alias)
    if (id === undefined) {
      throw new InkSignError(
        'UNKNOWN_RECIPIENT',
        `Field "${fieldAlias}" is assigned to "${alias}", which is not a recipient alias on this envelope`,
        { alias, known: Array.from(this.recipientAliases.keys()) },
      )
    }
    return { recipientId: id }
  }

  private assertFreeAlias(map: Map<Alias, string>, alias: Alias, kind: string): void {
    if (!map.has(alias)) return
    throw new InkSignError('INVALID_ENVELOPE', `Duplicate ${kind} alias "${alias}"`, {
      alias,
      kind,
    })
  }
}

export function createEnvelope(init: {
  subject: string
  id?: EnvelopeId
  message?: string
}): EnvelopeBuilder {
  return new EnvelopeBuilder(init)
}

/** Applies default settings to a partially specified envelope. */
export function withDefaults(
  envelope: Omit<Envelope, 'settings'> & { settings?: Partial<EnvelopeSettings> },
): Envelope {
  return { ...envelope, settings: { ...defaultSettings, ...envelope.settings } }
}
