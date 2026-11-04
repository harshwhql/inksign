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
  type InkSignContextValue,
  InkSignProvider,
  type InkSignProviderProps,
  useInkSign,
  useSigningSession,
  useThemeOnElement,
  useThemeStyle,
} from './context.jsx'
export {
  DocumentViewer,
  type DocumentViewerProps,
  type FieldBox,
  useDocument,
  useZoom,
} from './DocumentViewer.jsx'
export { FieldInput, type FieldInputProps } from './FieldInput.jsx'
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
  type SignaturePadHandle,
  type SignaturePadProps,
  TypedSignature,
  type TypedSignatureProps,
  UploadSignature,
  type UploadSignatureProps,
} from './SignaturePad.jsx'

export {
  AdoptSignatureDialog,
  type AdoptSignatureDialogProps,
  DangerButton,
  PrimaryButton,
  SecondaryButton,
  SigningCeremony,
  type SigningCeremonyProps,
} from './SigningCeremony.jsx'
