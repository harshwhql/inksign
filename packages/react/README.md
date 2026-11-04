# @inksign/react

React bindings for [InkSign](https://github.com/harshwhql/inksign). 9.5 kB minified and gzipped.

Thin by design: the rules live in `@inksign/core` and the drawing in `@inksign/ui`, so this package is subscriptions and markup rather than a second implementation.

```bash
npm install @inksign/core @inksign/pdf @inksign/ui @inksign/react
```

## A signing ceremony

```tsx
import { createTheme } from '@inksign/ui'
import {
  DocumentViewer,
  FieldInput,
  InkSignProvider,
  SigningCeremony,
  useDocument,
  useInkSign,
} from '@inksign/react'

function Signing({ envelope, recipientId }) {
  return (
    <InkSignProvider
      envelope={envelope}
      recipientId={recipientId}
      theme={createTheme({ brandColor: '#7c3aed' })}
      adapters={adapters}
      onSessionError={(error) => console.error(error.code)}
    >
      <SigningCeremony onCompleted={() => navigate('/done')}>
        <Document />
      </SigningCeremony>
    </InkSignProvider>
  )
}

function Document() {
  const { store, session } = useInkSign()
  const documentId = store.documentIds()[0]
  const { renderer, document } = useDocument(store.getDocument(documentId)?.source)

  return (
    <DocumentViewer
      documentId={documentId}
      renderer={renderer}
      pageSizes={document?.pageSizes ?? []}
      scale="fit-width"
      renderField={(fieldId, box) => (
        <FieldInput
          key={fieldId}
          fieldId={fieldId}
          box={box}
          adoptedSignature={session?.signature}
        />
      )}
    />
  )
}
```

`SigningCeremony` renders the steps but decides nothing. Whether consent is needed, whether the signer may finish, and what is blocking them all come from the session, so you can replace this component wholesale without weakening the rules.

## Hooks

| Hook                               | Subscribes to                                 |
| ---------------------------------- | --------------------------------------------- |
| `useFieldValue(id)`                | one field's value                             |
| `useFieldState(id)`                | value, definition, issues and a stable setter |
| `useField(id)`, `useRecipient(id)` | one entity                                    |
| `usePageFields(documentId, page)`  | field IDs on one page, in tab order           |
| `useSessionStage()`                | the ceremony stage                            |
| `useSessionProgress()`             | completion over required fields               |
| `useCanFinish()`                   | whether finishing is allowed, and why not     |
| `useAssignedFields()`              | this signer's visible fields                  |
| `useRouting()`                     | who may act now                               |
| `useEnvelopeMeta()`                | status, subject, settings                     |

Every subscription is keyed, so typing in one input re-renders that input and nothing else. A single context value holding the envelope would re-render every field on every keystroke, and on a 300 field document that is the difference between usable and not. A test asserts it directly: thirty mounted fields, one write, and the other twenty-nine must not re-render.

`useSyncExternalStore` is used rather than `useEffect` plus `useState` because it is tear-free under concurrent rendering: a value read during render is guaranteed consistent with what the subscription will report.

## Signature capture

```tsx
import { SignaturePad, TypedSignature, UploadSignature } from '@inksign/react'

;<SignaturePad ref={padRef} onSignature={setSignature} height={180} />
```

Drawing is owned by the controller from `@inksign/ui`, not by React. A stylus produces pointer events at up to 240 Hz, and routing those through React state would mean a render per sample. The controller writes to the canvas directly and React only hears about meaningful changes, such as the pad becoming non-empty.

`AdoptSignatureDialog` gives the full draw, type and upload flow with a focus trap.

## Notes

The envelope is read once when the provider mounts. A signing ceremony is not a view over mutable props: swapping the envelope underneath a half-filled form would silently discard input, so changing document means remounting with a new `key`.

Opening a session out of turn calls `onSessionError` and renders the tree without a session, rather than throwing, so you can show your own message.

Omit `recipientId` for a sender-side preview, which renders the document and fields without opening a ceremony.

Requires React 18 or later.

## License

MIT
