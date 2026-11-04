/**
 * @inksign/core
 *
 * A framework-agnostic electronic signature engine with no runtime
 * dependencies. It models envelopes, recipient routing, field logic, signing
 * sessions and tamper-evident audit trails, and knows nothing about rendering
 * or storage. The UI packages build on this; so can your own.
 */

export {
  type Adapters,
  type AttachmentAdapter,
  type AuthResult,
  browserContext,
  type ClockAdapter,
  type ContextAdapter,
  type IdentityAdapter,
  MemoryIdentityAdapter,
  MemoryNotificationAdapter,
  MemoryStorageAdapter,
  type NotificationAdapter,
  type OutboundMessage,
  type PersistenceAdapter,
  recipientFacts,
  type StorageAdapter,
  systemClock,
  type WebhookAdapter,
} from './adapters/index.js'
export {
  type AuditAction,
  type AuditContext,
  type AuditEntry,
  type AuditInput,
  AuditTrail,
  GENESIS_HASH,
  type TrailVerification,
  verifyTrail,
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
  type Seal,
  type SealInput,
  type SealVerification,
  seal,
  verifySeal,
} from './crypto/seal.js'
export {
  type Alias,
  createEnvelope,
  type DocumentInput,
  defaultSettings,
  EnvelopeBuilder,
  type FieldInput,
  type RecipientInput,
  withDefaults,
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
  hasErrorCode,
  InkSignError,
  type InkSignErrorCode,
  isInkSignError,
  type ValidationIssue,
  type ValidationResult,
  validationError,
} from './errors.js'
export {
  buildReverseIndex,
  dependentFields,
  evaluateCondition,
  isFieldVisible,
  type ValueLookup,
  validateConditions,
} from './fields/conditions.js'

export {
  acceptsValue,
  defaultValue,
  describeField,
  type FieldDescriptor,
  formatValue,
  isAutoFilled,
  isEmpty,
  isInkField,
  isInteractive,
  type ValueKind,
} from './fields/registry.js'
export {
  clearPatternCache,
  isValueValid,
  type ValidateValueOptions,
  validateValue,
} from './fields/validate.js'
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
  canRecipientAct,
  delegate,
  isBlockingRole,
  isPassiveRole,
  pendingNotifications,
  type RoutingPlan,
  type RoutingStage,
  resolveRouting,
} from './recipients/routing.js'
export {
  createSession,
  type SessionOptions,
  type SessionProgress,
  type SessionSnapshot,
  type SessionStage,
  SigningSession,
  sessionTopics,
} from './session/session.js'
export {
  EMPTY_VALUE,
  type EnvelopeMeta,
  EnvelopeStore,
  topics,
  valuesEqual,
} from './store/envelope-store.js'
export {
  derived,
  type Listener,
  type ReadableSignal,
  signal,
  TopicNotifier,
  type Unsubscribe,
  type WritableSignal,
} from './store/signal.js'
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

/** Package version, substituted at build time. */
export const VERSION = '0.1.0'
