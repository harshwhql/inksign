/**
 * @inksign/svelte
 *
 * Svelte bindings for InkSign. Thin by design: the rules live in
 * `@inksign/core` and the drawing in `@inksign/ui`, so this package is
 * subscriptions and DOM wiring rather than a second implementation.
 *
 * The reactive layer implements Svelte's store contract and the imperative
 * parts are actions, so nothing here needs the Svelte compiler. It works
 * unchanged in Svelte 3, 4 and 5, with `$store` auto-subscription in all of
 * them, and the markup stays entirely yours.
 *
 * Subscriptions are keyed per field, so typing in one input notifies that
 * input and nothing else.
 */

export {
  type ActionReturn,
  createDocument,
  type DocumentHandle,
  type DocumentViewerActionOptions,
  documentViewer,
  type FieldBox,
  fieldBoxes,
  renderPage,
  type SignaturePadActionOptions,
  signaturePad,
  type ViewerState,
} from './actions.js'
export {
  type CreateContextOptions,
  createInkSignContext,
  getInkSignContext,
  getSigningSession,
  type InkSignContext,
  provideInkSignContext,
  setInkSignContext,
  themeStyle,
  themeVariables,
} from './context.js'
export {
  assignedFields,
  canFinish,
  envelopeMeta,
  type FinishState,
  field,
  fieldIssues,
  fieldValue,
  fromBinding,
  pageFields,
  type Readable,
  recipient,
  routing,
  type Subscriber,
  sessionProgress,
  sessionStage,
  type Unsubscriber,
  type WritableField,
  writableField,
} from './stores.js'
