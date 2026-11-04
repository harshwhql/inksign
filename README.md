# InkSign

An electronic signature toolkit for the web. Build a signing flow into your own product, with your own branding, on your own infrastructure.

[![CI](https://github.com/harshwhql/inksign/actions/workflows/ci.yml/badge.svg)](https://github.com/harshwhql/inksign/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@inksign/core.svg)](https://www.npmjs.com/package/@inksign/core)
[![license](https://img.shields.io/npm/l/@inksign/core.svg)](./LICENSE)

```bash
npm install @inksign/core @inksign/react
```

```tsx
import { createEnvelope } from '@inksign/core'
import {
  InkSignProvider,
  SigningCeremony,
  DocumentViewer,
  FieldInput,
  useDocument,
} from '@inksign/react'

const envelope = createEnvelope({ subject: 'Mutual NDA' })
  .document('nda', { name: 'NDA.pdf', source: { kind: 'url', url: '/nda.pdf' } })
  .signer('alice', { name: 'Alice Chen', email: 'alice@example.com' })
  .signer('bob', { name: 'Bob Diaz', email: 'bob@example.com' })
  .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 640, required: true })
  .field({ recipient: 'alice', type: 'date_signed', page: 0, x: 280, y: 640 })
  .field({ recipient: 'bob', type: 'signature', page: 0, x: 72, y: 700, required: true })
  .build()
```

Alice signs first, then Bob. The signature field is required, the date fills itself, and the envelope refuses to build if a field is assigned to someone who is not on it.

## Why this exists

Hosted signature services work well until you need the signing step to live inside your own product. Then you are embedding someone else's iframe, paying per envelope, sending your customers' contracts to a third party, and showing their brand at the moment your user is agreeing to something.

InkSign is the signing flow as a library. You keep the documents, the database, the branding and the audit trail. There is no InkSign service, no account, and nothing phones home.

## What it does

**Envelopes and routing.** Documents, recipients and fields, with sequential or parallel routing, signing groups where any one member can act, and ten recipient roles including carbon copy, approver, witness and notary. A witness cannot sign before the person they are witnessing.

**Fields.** Nineteen field types. Validation, conditional visibility with cycle detection, and anchor placement that binds a field to text in the document ("18 points below the words _Authorized signature_") so placements survive the document being regenerated.

**The signing ceremony.** Consent gate, identity verification, signature capture by drawing, typing or upload, required-field enforcement, decline with a reason, and delegation. One adopted signature applies to every signature field at once.

**Tamper-evident output.** Every action lands in a hash-chained audit trail: each entry commits to the one before it, so altering any entry invalidates every digest that follows. Fields are flattened into the PDF rather than left as editable form fields, and a generated certificate of completion records who did what, when, and under which digest.

**Your branding.** Every visual value is a CSS custom property. Pass one brand colour and the palette derives from it, with the text contrast measured rather than guessed.

## Packages

| Package                              | Size (min+gzip) | What it is                                                                                         |
| ------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------- |
| [`@inksign/core`](./packages/core)   | 15.0 kB         | The engine. Envelopes, routing, field logic, sessions, audit trail. **Zero runtime dependencies.** |
| [`@inksign/pdf`](./packages/pdf)     | 8.6 kB          | Rendering, coordinate geometry, anchor placement, field flattening.                                |
| [`@inksign/ui`](./packages/ui)       | 8.9 kB          | Signature capture, layout, theming, web components. No framework.                                  |
| [`@inksign/react`](./packages/react) | 9.5 kB          | React hooks and components.                                                                        |

Sizes are measured by `size-limit`, which runs in CI against a budget so they cannot drift upwards unnoticed. Everything tree-shakes:

| Importing only                                                          | Cost    |
| ----------------------------------------------------------------------- | ------- |
| `createViewport`, `fieldToCss`, `fieldToPdf`, `FieldIndex`              | 731 B   |
| `SignaturePad`, `getStrokePath`                                         | 3.2 kB  |
| `createEnvelope`, `EnvelopeStore`, `SigningSession`, `validateEnvelope` | 12.9 kB |

`pdfjs-dist` and `pdf-lib` are optional peer dependencies of `@inksign/pdf`, imported lazily so they land in their own chunk, fetched only when a page is rendered or a document is written. Code that only needs the geometry helpers pulls in neither. You can also supply either module yourself with `setPdfJs` or `setPdfLib`, which is how you pin a build, load from a CDN, or use pdf.js in Node, where it needs its legacy build.

## Any framework

The engine and the UI layer are plain TypeScript with no framework imports, so there are three ways in.

**React.** Use `@inksign/react`.

**Anything else, today.** `@inksign/ui` ships web components, which are part of the platform. This works in Vue, Svelte, Angular, Solid, Astro, or plain HTML with no adapter:

```html
<inksign-signature-pad ink="#1f2a5e" height="180"></inksign-signature-pad>

<script type="module">
  import { defineInkSignElements } from '@inksign/ui'
  defineInkSignElements()

  const pad = document.querySelector('inksign-signature-pad')
  pad.addEventListener('change', () => console.log(pad.isEmpty))
  // When the signer is done:
  const signature = pad.toSignature()
</script>
```

**Your own bindings.** The core exposes a keyed subscription API, so a framework adapter is small. `@inksign/react` is about 300 lines over the engine, not a reimplementation of it. Dedicated Vue and Svelte adapters are on the roadmap below.

## Built to scale

The expensive case is a 200 page agreement with 400 fields on a mid-range phone. The design targets that case specifically.

**One field does not re-render the page.** State is normalized into maps keyed by ID, and subscriptions are keyed per field. Writing a value notifies that field's listeners and nobody else. A test asserts this directly: thirty mounted fields, one write, and the other twenty-nine must not re-render.

**Writes are O(1).** Entities are immutable objects inside mutable maps, so a keystroke replaces one object instead of cloning a 400-entry collection. Identity equality then drives re-rendering for free.

**Pages are virtualized.** Only pages intersecting the viewport are mounted, found by binary search rather than by scanning the page list on every scroll event. Neighbours are prefetched; pages that scroll away have their renders cancelled, so the pdf.js worker serves what is on screen instead of finishing work nobody will see.

**The render cache is bounded by pixels, not by count.** One page at 400% costs as much as sixteen at 100%, so a count-based cache lets a zoomed document exhaust memory. Renders are also cached per rounded scale, so a pinch-zoom through forty intermediate scales produces a handful of renders.

**Drawing stays off React.** A stylus produces pointer events at up to 240 Hz. The signature pad writes to the canvas directly and only reports meaningful changes, and an in-progress stroke repaints alone, so latency stays flat however much has already been drawn.

**Theming costs nothing at runtime.** CSS custom properties, so no CSS-in-JS runtime, no style recalculation on theme change, and no per-instance style cost.

## Branding

```tsx
import { createTheme } from '@inksign/ui'

const theme = createTheme({
  brandColor: '#7c3aed',
  branding: {
    name: 'Northwind Legal',
    logoUrl: '/logo.svg',
    supportEmail: 'help@northwind.example',
    consentText: 'Your own disclosure wording here.',
  },
})
```

One colour derives the palette. The text colour on your brand colour is chosen by measuring the contrast ratio of each candidate and taking the better one, rather than by comparing luminance against a threshold, because a threshold gets mid-tones wrong: sky blue sits just below any sensible cut-off, so it picks white text at 2.8:1 when dark text would have given 7:1.

Override any individual token, or skip the theme object and set the variables from your own stylesheet:

```css
.signing {
  --inksign-primary: #7c3aed;
  --inksign-radius: 4px;
  --inksign-font-family: "Inter", system-ui, sans-serif;
}
```

There is no attribution unless you ask for it. `showAttribution` defaults to false, because this is a library you are building a product with, not a brand to advertise.

A contrast auditor is included, which is worth running in a test when a brand colour comes from a marketing palette:

```ts
import { auditThemeContrast } from '@inksign/ui'

expect(auditThemeContrast(theme).filter((check) => !check.passesAA)).toEqual([])
```

## Your backend, your rules

The engine has no opinion about where documents live or how recipients are authenticated, because those are the parts that cannot be done honestly in a browser. A client cannot verify its own identity, and a client-side timestamp is not evidence of anything.

So they are adapters you implement:

```ts
import type { Adapters } from '@inksign/core'

const adapters: Adapters = {
  storage, // read and write document bytes
  identity, // verify an access code, SMS code, or government ID
  notify, // send invitations and reminders
  clock, // supply a trusted timestamp
  webhook, // react to lifecycle changes
}
```

Every adapter is optional, and a flow that needs a missing one fails with a clear `ADAPTER_MISSING` error rather than silently degrading. In-memory implementations are included for tests and local development, and they say so.

## What the audit trail proves

Being precise about this matters, because the difference comes up if a signature is ever challenged.

The hash chain **proves** the trail is internally consistent: remove, edit or reorder an entry and verification fails and names the entry. Sealing extends that to the finished PDF bytes and the captured values. With a server-held secret, the seal also proves it was issued by a holder of that secret, so a client cannot fabricate one.

It **does not** prove when the seal was made. A local clock can be set to anything. Supply a timestamp from an RFC 3161 authority through the clock adapter when the signing time has to stand on its own.

It is also **not a PKI digital signature** and makes no claim to be one. There is no certificate chain and no identity bound by a certificate authority. If you need PAdES or a qualified electronic signature, seal with this and then have a qualified service apply the certified signature over the result.

Whether an electronic signature is enforceable depends on your jurisdiction and your process, not on a library. InkSign gives you the consent record, the authentication record, the audit trail and the tamper-evident output that such a process generally requires. It is not legal advice.

## Accessibility

A signing ceremony is a legal act, so it has to be completable without sight and without a mouse. Fields carry descriptions saying what they are, who they belong to and whether they are required. Progress and signature adoption are announced through a live region. The adopt-signature dialog traps focus and returns it on close. Arrow keys and Enter move between fields. Reduced motion is respected. The default light and dark themes both pass WCAG AA, and a test asserts it.

One gap worth naming: the document itself is rasterized to a canvas, so its text is not readable by a screen reader. The fields over it are real inputs with real labels, and the canvas is hidden from the accessibility tree rather than announced as an unlabelled image, but a signer using a screen reader cannot currently read the agreement through this viewer. A selectable text layer is on the roadmap. Until it lands, give those signers the PDF itself as well.

## Status

Version 0.1.0. The API may change before 1.0, and changes will go through [changesets](https://github.com/changesets/changesets) with a changelog.

398 tests across the four packages, covering the routing and lifecycle rules, conditional field logic, coordinate round-trips through every rotation, hash chain tamper detection, real PDF writes, the React render-isolation claim, and an end-to-end pipeline that takes a blank PDF through anchor placement, authentication, consent, signing, flattening, sealing and verification.

**Roadmap**

- Dedicated Vue and Svelte adapters. Web components cover these today.
- A selectable text layer over rendered pages, for screen readers and text selection.
- Templates with role placeholders, and bulk send.
- A reference backend showing the adapters against Postgres and S3.
- Reminder and expiration scheduling.

## Contributing

```bash
git clone https://github.com/harshwhql/inksign.git
cd inksign
npm install
npm run build   # build first: packages resolve each other through their types field
npm test
```

Development needs Node 22 or later, which is what `pdfjs-dist` and the Vite plugin require. The published packages support Node 20, and CI verifies that separately by running the built output on a clean Node 20 with no install.

`npm run lint` runs Biome, `npm run typecheck` builds then checks the project references, and `npm run size` checks the bundle budgets. The React example lives in `examples/react-basic`:

```bash
npm run dev -w @inksign/example-react-basic
```

Issues and pull requests are welcome. Changes that affect a published package need a changeset: run `npx changeset` and describe the change.

## License

MIT
