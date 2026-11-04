# @inksign/svelte

Svelte bindings for [InkSign](https://github.com/harshwhql/inksign).

Thin by design: the rules live in `@inksign/core` and the drawing in `@inksign/ui`, so this package is subscriptions and DOM wiring rather than a second implementation.

```bash
npm install @inksign/core @inksign/pdf @inksign/ui @inksign/svelte
```

## No compiler, no runes, no lock-in

The reactive layer implements Svelte's store contract, and the imperative parts are actions. Neither needs the Svelte compiler, which has three consequences worth stating:

- It works unchanged in Svelte 3, 4 and 5, with `$store` auto-subscription in every one of them. No separate build per major version, and no rune syntax that pins you to 5.
- The markup stays yours. This package positions and wires; it does not impose a component tree or a class name you have to override.
- Type declarations are generated from real TypeScript rather than from `.svelte` files, so editor support works without extra tooling.

Svelte's store contract is one method, `subscribe(run)`, which returns an unsubscribe. That maps exactly onto the engine's keyed subscriptions, so the binding layer is a direct translation rather than an adapter working against the grain.

## Context

```svelte
<script lang="ts">
  import { setInkSignContext, themeStyle } from '@inksign/svelte'
  import { createTheme } from '@inksign/ui'

  export let envelope
  export let recipientId

  const theme = createTheme({ brandColor: '#7c3aed' })
  const { store, session } = setInkSignContext({ envelope, recipientId, theme, adapters })
</script>

<div style={themeStyle(theme)}>
  <slot />
</div>
```

Descendants read it with `getInkSignContext()`, or `getSigningSession()` when a session is required.

## Stores

```svelte
<script lang="ts">
  import { fieldValue, sessionProgress, canFinish, getInkSignContext } from '@inksign/svelte'

  const { store, session } = getInkSignContext()
  const value = fieldValue(store, fieldId)
  const progress = sessionProgress(session)
  const finish = canFinish(session)
</script>

<input value={$value.kind === 'text' ? $value.value : ''} />
<p>{$progress.requiredRemaining} required fields remaining</p>
<button disabled={!$finish.canFinish} title={$finish.reason}>Finish</button>
```

| Store                                      | Subscribes to                             |
| ------------------------------------------ | ----------------------------------------- |
| `fieldValue(store, id)`                    | one field's value                         |
| `writableField(session, store, id)`        | the same, writable, for `bind:`           |
| `field(store, id)`, `recipient(store, id)` | one entity                                |
| `pageFields(store, documentId, page)`      | field IDs on one page, in tab order       |
| `sessionStage(session)`                    | the ceremony stage                        |
| `sessionProgress(session)`                 | completion over required fields           |
| `canFinish(session)`                       | whether finishing is allowed, and why not |
| `assignedFields(session, store)`           | this signer's visible fields              |
| `routing(store)`                           | who may act now                           |
| `envelopeMeta(store)`                      | status, subject, settings                 |

Every store is keyed, so typing in one field notifies that field and nothing else. A single store holding the whole envelope would wake every subscriber on every keystroke, and on a 300 field document that is the difference between usable and not. A test asserts it directly: thirty subscribed fields, one write, and the other twenty-nine must not fire.

The underlying engine subscription opens on the first subscriber and closes when the last one leaves, so a long document does not accumulate dead listeners as pages scroll in and out. `fromBinding` is exported if you want to wrap a subscription the package does not.

`writableField` goes through the session rather than the store, so `bind:` still cannot bypass a rule: writing the wrong value kind throws just as it would through the session directly.

## Actions

```svelte
<canvas use:signaturePad={{ color: '#1f2a5e', onSignature: (s) => (signature = s) }} />

<div use:documentViewer={{ renderer, pageSizes, onState: (s) => (view = s) }}>
  {#each view.visible as page}
    <canvas use:renderPage={{ renderer, page, scale: view.scale }} aria-hidden="true" tabindex="-1" />
  {/each}
</div>
```

An action is Svelte's answer to behaviour that owns a DOM node, which is exactly what the signature pad and the viewer are.

`signaturePad` keeps drawing off Svelte's reactivity: a stylus produces pointer events at up to 240 Hz, and routing those through component state would mean an update per sample. The controller writes to the canvas directly and only reports meaningful changes.

`documentViewer` owns the measuring, scrolling and render scheduling, and hands you the visible window. Only the pages intersecting the viewport are reported, and renders for pages that scroll away are cancelled, so a fast scroll does not leave the pdf.js worker rasterizing pages nobody will see.

`createDocument` loads a PDF and exposes the renderer as a store. Call its `destroy` when you are done, which releases the pdf.js worker and the cached bitmaps.

`fieldBoxes` converts field rects into CSS boxes, so a Svelte application places fields with the same geometry as every other adapter rather than reimplementing the point-to-pixel conversion and getting rotation wrong.

## Notes

Importing this package, and `@inksign/ui` beneath it, is safe during server rendering in SvelteKit. A regression test covers that specifically, because it was not always true.

The envelope is read once when the context is created. A signing ceremony is not a view over mutable props: swapping the envelope underneath a half-filled form would silently discard input, so changing document means recreating the context.

Opening a session out of turn calls `onSessionError` and leaves `session` undefined, rather than throwing, so you can show your own message.

Omit `recipientId` for a sender-side preview, which renders the document and fields without opening a ceremony.

Requires Svelte 3.55 or later, including Svelte 4 and 5.

## License

MIT
