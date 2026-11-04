/**
 * @inksign/vue
 *
 * Vue 3 bindings for InkSign. Thin by design: the rules live in
 * `@inksign/core` and the drawing in `@inksign/ui`, so this package is
 * subscriptions and markup rather than a second implementation.
 *
 * Subscriptions are keyed per field, so typing in one input updates that input
 * and nothing else.
 */

export {
  type ElementSize,
  type FieldState,
  type FinishState,
  useAssignedFields,
  useCanFinish,
  useElementSize,
  useEnvelopeMeta,
  useField,
  useFieldIssues,
  useFieldState,
  useFieldValue,
  usePageFields,
  useRecipient,
  useRouting,
  useSessionProgress,
  useSessionStage,
} from './composables.js'
export {
  createInkSignContext,
  createInkSignPlugin,
  type InkSignContext,
  inkSignKey,
  type ProvideInkSignOptions,
  provideInkSign,
  useInkSign,
  useSigningSession,
  useStoreBinding,
  useThemeStyle,
} from './context.js'
export {
  DocumentViewer,
  type FieldBox,
  useDocument,
  useZoom,
} from './DocumentViewer.js'
export { FieldInput } from './FieldInput.js'
export {
  SignaturePad,
  type SignaturePadExposed,
  TypedSignature,
  UploadSignature,
} from './SignaturePad.js'

export {
  AdoptSignatureDialog,
  InkSignProvider,
  SigningCeremony,
} from './SigningCeremony.js'
