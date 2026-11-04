# @inksign/vue

Vue 3 bindings for [InkSign](https://github.com/harshwhql/inksign).

Thin by design: the rules live in `@inksign/core` and the drawing in `@inksign/ui`, so this package is subscriptions and markup rather than a second implementation.

```bash
npm install @inksign/core @inksign/pdf @inksign/ui @inksign/vue
```

## A signing ceremony

```vue
<script setup lang="ts">
import { createTheme } from '@inksign/ui'
import { InkSignProvider, SigningCeremony } from '@inksign/vue'
import Document from './Document.vue'

const props = defineProps<{ envelope: Envelope; recipientId: RecipientId }>()
const theme = createTheme({ brandColor: '#7c3aed' })
</script>

<template>
  <InkSignProvider
    :envelope="props.envelope"
    :recipient-id="props.recipientId"
    :theme="theme"
    :adapters="adapters"
    @session-error="(error) => console.error(error.code)"
  >
    <SigningCeremony @completed="onDone">
      <Document />
    </SigningCeremony>
  </InkSignProvider>
</template>
```

```vue
<script setup lang="ts">
import { DocumentViewer, FieldInput, useDocument, useInkSign } from '@inksign/vue'
import { computed } from 'vue'

const { store, session } = useInkSign()
const documentId = store.documentIds()[0]
const { renderer, document } = useDocument(() => store.getDocument(documentId)?.source)
</script>

<template>
  <DocumentViewer
    :document-id="documentId"
    :renderer="renderer"
    :page-sizes="document?.pageSizes ?? []"
    scale="fit-width"
  >
    <template #field="{ fieldId, box }">
      <FieldInput :field-id="fieldId" :box="box" :adopted-signature="session?.signature" />
    </template>
  </DocumentViewer>
</template>
```

`SigningCeremony` renders the steps but decides nothing. Whether consent is needed, whether the signer may finish, and what is blocking them all come from the session, so you can replace this component wholesale without weakening the rules.

If you prefer a setup call to a provider component, use `provideInkSign` directly, or `createInkSignPlugin` to install a context for a whole app.

## Composables

| Composable                         | Subscribes to                             |
| ---------------------------------- | ----------------------------------------- |
| `useFieldValue(id)`                | one field's value                         |
| `useFieldState(id)`                | value, definition, issues, and writers    |
| `useField(id)`, `useRecipient(id)` | one entity                                |
| `usePageFields(documentId, page)`  | field IDs on one page, in tab order       |
| `useSessionStage()`                | the ceremony stage                        |
| `useSessionProgress()`             | completion over required fields           |
| `useCanFinish()`                   | whether finishing is allowed, and why not |
| `useAssignedFields()`              | this signer's visible fields              |
| `useRouting()`                     | who may act now                           |
| `useEnvelopeMeta()`                | status, subject, settings                 |

Every subscription is keyed, so typing in one input updates that input and nothing else. A single reactive object holding the envelope would invalidate every field on every keystroke, and on a 300 field document that is the difference between usable and not. A test asserts it directly: thirty mounted fields, one write, and the other twenty-nine must not re-render.

They return `shallowRef` rather than `ref` on purpose. Entities from the store are frozen and replaced wholesale on change, so a deep reactive proxy would cost a traversal per read and buy nothing; identity is already a valid change check.

Subscriptions are tied to the active effect scope, so a component that unmounts takes its subscription with it. `useStoreBinding` is exported if you want to bridge a subscription the package does not wrap.

## Signature capture

```vue
<SignaturePad ref="pad" :height="180" @signature="(s) => (signature = s)" />
```

Drawing is owned by the controller from `@inksign/ui`, not by Vue. A stylus produces pointer events at up to 240 Hz, and routing those through reactive state would mean a render per sample. The controller writes to the canvas directly and Vue only hears about meaningful changes.

`AdoptSignatureDialog` gives the full draw, type and upload flow with a focus trap.

## Notes

Components are written with render functions rather than single file components, so the package needs no SFC compiler in your build and its type declarations are generated from real TypeScript. Nothing about that is visible at the call site: use them from templates as normal.

The envelope is read once when the context is created. A signing ceremony is not a view over mutable props: swapping the envelope underneath a half-filled form would silently discard input, so changing document means remounting with a new `key`.

Opening a session out of turn emits `session-error` and renders without a session, rather than throwing, so you can show your own message.

Omit `recipientId` for a sender-side preview, which renders the document and fields without opening a ceremony.

Requires Vue 3.4 or later.

## License

MIT
