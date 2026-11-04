/**
 * @inksign/react
 *
 * React bindings for InkSign. Thin by design: the rules live in
 * `@inksign/core` and the drawing in `@inksign/ui`, so this package is
 * subscriptions and markup rather than a second implementation.
 *
 * Subscriptions are keyed per field, so typing in one input re-renders that
 * input and nothing else.
 */

export {
  InkSignProvider,
  useInkSign,
  useSigningSession,
  useThemeOnElement,
  useThemeStyle,
  type InkSignContextValue,
  type InkSignProviderProps,
} from './context.jsx'

export {
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
} from './hooks.js'

export {
  SignaturePad,
  TypedSignature,
  UploadSignature,
  type SignaturePadHandle,
  type SignaturePadProps,
  type TypedSignatureProps,
  type UploadSignatureProps,
} from './SignaturePad.jsx'

export {
  DocumentViewer,
  useDocument,
  useZoom,
  type DocumentViewerProps,
  type FieldBox,
} from './DocumentViewer.jsx'

export { FieldInput, type FieldInputProps } from './FieldInput.jsx'

export {
  AdoptSignatureDialog,
  DangerButton,
  PrimaryButton,
  SecondaryButton,
  SigningCeremony,
  type AdoptSignatureDialogProps,
  type SigningCeremonyProps,
} from './SigningCeremony.jsx'
