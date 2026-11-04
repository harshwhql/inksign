/**
 * Core domain model for InkSign.
 *
 * Every structure here is a plain serializable object. The engine never stores
 * class instances in state, so any envelope or session can be persisted to
 * JSON, sent over a wire, and rehydrated without loss.
 */

/** Branded identifier types. They are plain strings at runtime. */
export type EnvelopeId = string & { readonly __brand?: 'EnvelopeId' }
export type DocumentId = string & { readonly __brand?: 'DocumentId' }
export type RecipientId = string & { readonly __brand?: 'RecipientId' }
export type FieldId = string & { readonly __brand?: 'FieldId' }

/** Milliseconds since the Unix epoch. */
export type Timestamp = number

/**
 * Envelope lifecycle. Transitions are enforced by the lifecycle state machine,
 * so an envelope can never move from `completed` back to `sent`.
 */
export type EnvelopeStatus =
  | 'draft'
  | 'sent'
  | 'delivered'
  | 'partially_signed'
  | 'completed'
  | 'declined'
  | 'voided'
  | 'expired'

/**
 * Recipient roles, covering the capabilities offered by mainstream
 * e-signature platforms so existing flows port across without remodelling.
 */
export type RecipientRole =
  /** Signs the document and fills assigned fields. */
  | 'signer'
  /** Receives a copy, takes no action. */
  | 'carbon_copy'
  /** Must open the document but signs nothing. Delivery is recorded. */
  | 'certified_delivery'
  /** Signs on the sender's device, hosted in person. */
  | 'in_person_signer'
  /** Fills in the name and email of another recipient, then drops out. */
  | 'intermediary'
  /** Can add or edit recipients and fields before routing continues. */
  | 'editor'
  /** Enters recipient details on behalf of a signer. */
  | 'agent'
  /** Attests that they observed another recipient sign. */
  | 'witness'
  /** Notarizes the signing act. */
  | 'notary'
  /** Approves or rejects without applying a signature. */
  | 'approver'

export type RecipientStatus =
  | 'created'
  | 'sent'
  | 'delivered'
  | 'signed'
  | 'completed'
  | 'declined'
  | 'delegated'
  | 'auth_failed'

/**
 * Field types available for placement on a document. `signature`, `initials`
 * and `stamp` produce ink; the rest capture data.
 */
export type FieldType =
  | 'signature'
  | 'initials'
  | 'stamp'
  | 'date_signed'
  | 'text'
  | 'number'
  | 'checkbox'
  | 'radio_group'
  | 'dropdown'
  | 'full_name'
  | 'email'
  | 'company'
  | 'title'
  | 'attachment'
  | 'approve'
  | 'decline'
  | 'note'
  | 'formula'
  | 'payment'

/** Authentication a recipient must clear before the ceremony opens. */
export type AuthMethod =
  | { kind: 'none' }
  | { kind: 'access_code'; hint?: string }
  | { kind: 'sms'; phoneLast4?: string }
  | { kind: 'phone_call'; phoneLast4?: string }
  | { kind: 'knowledge_based' }
  | { kind: 'id_verification'; provider?: string }
  | { kind: 'federated'; provider: string }

/**
 * Position of a field on a page, in PDF user-space points with the origin at
 * the top-left of the page. The renderer converts to CSS pixels, so placements
 * stay stable across zoom levels and device pixel ratios.
 */
export interface FieldRect {
  /** Zero-based page index within the document. */
  page: number
  x: number
  y: number
  width: number
  height: number
}

/**
 * Places a field relative to a text occurrence rather than at absolute
 * coordinates, so a field stays attached to its clause when the document
 * reflows between versions.
 */
export interface AnchorPlacement {
  /** Text to search for in the document's text layer. */
  text: string
  /** Which occurrence to bind to, zero-based. Defaults to every occurrence. */
  occurrence?: number
  caseSensitive?: boolean
  /** Offset from the matched text, in points. */
  offsetX?: number
  offsetY?: number
  /** Which edge of the match the offset applies from. */
  from?: 'left' | 'right' | 'top' | 'bottom'
}

/**
 * Shows or hides a field based on another field's value. Evaluated by the
 * condition engine, which also rejects dependency cycles.
 */
export interface FieldCondition {
  /** Field whose value gates this one. */
  whenField: FieldId
  operator: 'equals' | 'not_equals' | 'filled' | 'empty' | 'greater_than' | 'less_than' | 'includes'
  value?: string | number | boolean
}

export interface FieldValidation {
  required?: boolean
  /** Regular expression source. Compiled lazily and cached per pattern. */
  pattern?: string
  patternMessage?: string
  minLength?: number
  maxLength?: number
  min?: number
  max?: number
}

/** Visual overrides for a single field. Falls back to the active theme. */
export interface FieldStyle {
  fontFamily?: string
  fontSize?: number
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  align?: 'left' | 'center' | 'right'
}

export interface Field {
  id: FieldId
  documentId: DocumentId
  /** Recipient responsible for this field. Unassigned fields are sender-filled. */
  recipientId?: RecipientId
  type: FieldType
  rect: FieldRect
  anchor?: AnchorPlacement
  /** Human-readable label, shown in the field list and to screen readers. */
  label?: string
  /** Help text surfaced on hover and focus. */
  tooltip?: string
  validation?: FieldValidation
  style?: FieldStyle
  /** Sender-supplied value the recipient cannot change. */
  readOnly?: boolean
  /** Options for `dropdown` and `radio_group`. */
  options?: readonly FieldOption[]
  /** Visibility conditions. All must pass for the field to be shown. */
  conditions?: readonly FieldCondition[]
  /** Expression for `formula` fields, referencing other fields by label. */
  formula?: string
  /** Tab order within the ceremony. Lower numbers come first. */
  tabOrder?: number
  /** Opaque data carried through the lifecycle untouched by the engine. */
  metadata?: Readonly<Record<string, unknown>>
}

export interface FieldOption {
  value: string
  label?: string
  /** Selected unless the recipient changes it. */
  default?: boolean
}

/** A captured value. Discriminated so ink and data can never be confused. */
export type FieldValue =
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'choice'; value: string }
  | { kind: 'date'; value: Timestamp }
  | { kind: 'ink'; value: InkSignature }
  | { kind: 'file'; value: readonly AttachmentRef[] }
  | { kind: 'empty' }

/**
 * A captured signature. `paths` keeps the vector form so the mark stays crisp
 * at any output resolution; `png` is a raster fallback for renderers that
 * cannot draw paths.
 */
export interface InkSignature {
  /** How the recipient produced the mark. */
  source: 'drawn' | 'typed' | 'uploaded'
  /** SVG path data per stroke, in the signature's own coordinate space. */
  paths?: readonly string[]
  /** Intrinsic size of the box the paths were captured in. */
  width: number
  height: number
  /** Data URL or storage key for a raster copy. */
  png?: string
  /** Font used when `source` is `typed`, for reproducible re-rendering. */
  typeface?: string
  /** Text used when `source` is `typed`. */
  text?: string
}

export interface AttachmentRef {
  /** Storage key, resolved through the configured storage adapter. */
  key: string
  name: string
  contentType: string
  byteSize: number
  /** SHA-256 of the file contents, lowercase hex. */
  digest?: string
}

export interface SignatureDocument {
  id: DocumentId
  name: string
  /** Where the PDF bytes come from. */
  source: DocumentSource
  pageCount?: number
  /** Page dimensions in points, indexed by page. Filled in once loaded. */
  pageSizes?: readonly PageSize[]
  /** Order within the envelope. */
  order?: number
  /**
   * Supplemental documents are presented for reading rather than signing, and
   * can require explicit acknowledgement.
   */
  supplemental?: { requireAccept: boolean; requireRead: boolean }
  /** SHA-256 of the original bytes, recorded before any field is applied. */
  digest?: string
  metadata?: Readonly<Record<string, unknown>>
}

export type DocumentSource =
  | { kind: 'url'; url: string }
  | { kind: 'storage'; key: string }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'base64'; data: string }

export interface PageSize {
  width: number
  height: number
  /** Page rotation in degrees: 0, 90, 180 or 270. */
  rotation?: number
}

export interface Recipient {
  id: RecipientId
  role: RecipientRole
  name: string
  email?: string
  phone?: string
  /** Position in the routing sequence. Equal values act in parallel. */
  routingOrder: number
  status: RecipientStatus
  auth?: AuthMethod
  /** Recipient this one witnesses or notarizes, for `witness` and `notary`. */
  attestsFor?: RecipientId
  /** Recipient that delegated to this one. */
  delegatedBy?: RecipientId
  /** Private note from the sender, shown during the ceremony. */
  note?: string
  /** Template placeholder name, set when the envelope came from a template. */
  roleName?: string
  /** Signing group. Any one member may act on behalf of the whole group. */
  groupId?: string
  sentAt?: Timestamp
  deliveredAt?: Timestamp
  completedAt?: Timestamp
  declineReason?: string
  metadata?: Readonly<Record<string, unknown>>
}

export interface EnvelopeSettings {
  /** The recipient must accept an electronic record disclosure before signing. */
  requireConsent: boolean
  /** Finishing is blocked until every required field assigned to them is filled. */
  enforceRequiredFields: boolean
  /** Recipients may refuse to sign, which declines the envelope. */
  allowDecline: boolean
  /** Recipients may reassign their turn to someone else. */
  allowDelegation: boolean
  /** Recipients may download the document during the ceremony. */
  allowDownload: boolean
  /** Recipients may print the document during the ceremony. */
  allowPrint: boolean
  /** Attach a certificate of completion to the sealed output. */
  attachCertificate: boolean
  /** Envelope expires this many milliseconds after being sent. */
  expiresAfterMs?: number
  /** Reminder cadence in milliseconds, dispatched via the notify adapter. */
  reminderIntervalMs?: number
  /** Locale for recipient-facing copy. BCP 47 tag. */
  locale?: string
  /** Time zone used when stamping dates. IANA name. */
  timeZone?: string
}

export interface Envelope {
  id: EnvelopeId
  status: EnvelopeStatus
  subject: string
  message?: string
  documents: readonly SignatureDocument[]
  recipients: readonly Recipient[]
  fields: readonly Field[]
  settings: EnvelopeSettings
  createdAt: Timestamp
  updatedAt: Timestamp
  sentAt?: Timestamp
  completedAt?: Timestamp
  voidedAt?: Timestamp
  voidReason?: string
  /** Template this envelope was created from. */
  templateId?: string
  metadata?: Readonly<Record<string, unknown>>
}

/** The envelope shape an author supplies, before the engine fills in defaults. */
export interface EnvelopeDraft {
  id?: EnvelopeId
  subject: string
  message?: string
  documents: readonly SignatureDocument[]
  recipients: readonly Recipient[]
  fields: readonly Field[]
  settings?: Partial<EnvelopeSettings>
  metadata?: Readonly<Record<string, unknown>>
}
