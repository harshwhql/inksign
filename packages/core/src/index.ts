/**
 * @inksign/core
 *
 * A framework-agnostic electronic signature engine with no runtime
 * dependencies. It models envelopes, recipient routing, field logic, signing
 * sessions and tamper-evident audit trails, and knows nothing about rendering
 * or storage. The UI packages build on this; so can your own.
 */

export type {
  AnchorPlacement,
  AttachmentRef,
  AuthMethod,
  DocumentId,
  DocumentSource,
  Envelope,
  EnvelopeDraft,
  EnvelopeId,
  EnvelopeSettings,
  EnvelopeStatus,
  Field,
  FieldCondition,
  FieldId,
  FieldOption,
  FieldRect,
  FieldStyle,
  FieldType,
  FieldValidation,
  FieldValue,
  InkSignature,
  PageSize,
  Recipient,
  RecipientId,
  RecipientRole,
  RecipientStatus,
  SignatureDocument,
  Timestamp,
} from './types.js'

export {
  InkSignError,
  hasErrorCode,
  isInkSignError,
  validationError,
  type InkSignErrorCode,
  type ValidationIssue,
  type ValidationResult,
} from './errors.js'

export {
  createId,
  documentId,
  envelopeId,
  eventId,
  fieldId,
  idCreatedAt,
  recipientId,
  sessionId,
} from './id.js'

export {
  TopicNotifier,
  derived,
  signal,
  type Listener,
  type ReadableSignal,
  type Unsubscribe,
  type WritableSignal,
} from './store/signal.js'

export {
  EMPTY_VALUE,
  EnvelopeStore,
  topics,
  valuesEqual,
  type EnvelopeMeta,
} from './store/envelope-store.js'

export {
  EnvelopeBuilder,
  createEnvelope,
  defaultSettings,
  withDefaults,
  type Alias,
  type DocumentInput,
  type FieldInput,
  type RecipientInput,
} from './envelope/builder.js'

export {
  assertActionable,
  assertEnvelopeTransition,
  assertRecipientTransition,
  canTransitionEnvelope,
  canTransitionRecipient,
  deriveEnvelopeStatus,
  isActionable,
  isTerminal,
} from './envelope/lifecycle.js'

export { validateEnvelope } from './envelope/validate.js'

export {
  canRecipientAct,
  delegate,
  isBlockingRole,
  isPassiveRole,
  pendingNotifications,
  resolveRouting,
  type RoutingPlan,
  type RoutingStage,
} from './recipients/routing.js'

export {
  acceptsValue,
  defaultValue,
  describeField,
  formatValue,
  isAutoFilled,
  isEmpty,
  isInkField,
  isInteractive,
  type FieldDescriptor,
  type ValueKind,
} from './fields/registry.js'

export {
  buildReverseIndex,
  dependentFields,
  evaluateCondition,
  isFieldVisible,
  validateConditions,
  type ValueLookup,
} from './fields/conditions.js'

export {
  clearPatternCache,
  isValueValid,
  validateValue,
  type ValidateValueOptions,
} from './fields/validate.js'

export {
  SigningSession,
  createSession,
  sessionTopics,
  type SessionOptions,
  type SessionProgress,
  type SessionSnapshot,
  type SessionStage,
} from './session/session.js'

export {
  AuditTrail,
  GENESIS_HASH,
  verifyTrail,
  type AuditAction,
  type AuditContext,
  type AuditEntry,
  type AuditInput,
  type TrailVerification,
} from './audit/trail.js'

export {
  canonicalize,
  digestsEqual,
  fromHex,
  hmacSha256,
  sha256,
  sha256Json,
  sha256Text,
  toHex,
} from './crypto/digest.js'

export {
  seal,
  verifySeal,
  type Seal,
  type SealInput,
  type SealVerification,
} from './crypto/seal.js'

export {
  MemoryIdentityAdapter,
  MemoryNotificationAdapter,
  MemoryStorageAdapter,
  browserContext,
  recipientFacts,
  systemClock,
  type Adapters,
  type AttachmentAdapter,
  type AuthResult,
  type ClockAdapter,
  type ContextAdapter,
  type IdentityAdapter,
  type NotificationAdapter,
  type OutboundMessage,
  type PersistenceAdapter,
  type StorageAdapter,
  type WebhookAdapter,
} from './adapters/index.js'

/** Package version, substituted at build time. */
export const VERSION = '0.1.0'
