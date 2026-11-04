# @inksign/pdf

PDF concerns for [InkSign](https://github.com/harshwhql/inksign): coordinate geometry, page rendering, anchor placement, and flattening captured values into a final document. 8.3 kB minified and gzipped.

```bash
npm install @inksign/pdf

# Add only what you use:
npm install pdfjs-dist   # to render pages
npm install pdf-lib      # to write PDFs
```

Both are optional peer dependencies, loaded on first use. Geometry needs neither, so a server that only stamps PDFs never pulls in a renderer.

## Coordinate spaces

Three spaces have to be reconciled, and getting it wrong puts signatures in the wrong place.

- **PDF user space**: origin bottom-left, y up, measured in points.
- **Field space**, how InkSign stores placements: origin top-left, y down, still points. This matches how people describe a page, and it matches CSS.
- **CSS pixels**: top-left, scaled by zoom, affected by page rotation.

```ts
import { createViewport, fieldToCss, fieldToPdf } from '@inksign/pdf'

const viewport = createViewport(pageSize, { scale: 1.5, rotation: 90 })

fieldToCss(field.rect, viewport) // { left, top, width, height } for absolute positioning
fieldToPdf(field.rect, pageSize) // flips the vertical axis for a PDF writer
```

Placements are stored in points rather than pixels on purpose. A field recorded at a zoom level drifts when the user zooms and lands wrong on another screen. Points are absolute, so a placement made on a phone stamps identically on a server. Round-trips are tested through all four rotations at four scales.

## Rendering

```ts
import { configureWorker, loadDocument, PageRenderer } from '@inksign/pdf'

await configureWorker('/pdf.worker.min.mjs') // your bundler decides this URL

const document = await loadDocument({ kind: 'url', url: '/nda.pdf' })
const renderer = new PageRenderer(document, { concurrency: 2, cacheBudgetMegapixels: 32 })

const page = await renderer.render(0, 1.5)
renderer.prefetch([1, 2], 1.5)
renderer.cancelExcept([0, 1, 2])

await renderer.dispose() // releases the worker and the cached bitmaps
```

Renders are cancellable, so a page that scrolls away stops consuming the worker. Concurrency is bounded because pdf.js runs on one worker, and firing twenty renders at once only queues them behind each other while multiplying peak memory. The cache is bounded by total pixels rather than by count, since one page at 400% costs as much as sixteen at 100%. Scales are bucketed, so a pinch-zoom through forty intermediate scales produces a handful of renders.

### Supplying pdf.js yourself

`loadPdfJs` imports `pdfjs-dist` on first use. Override that with `setPdfJs` when you need a specific build:

```ts
import { setPdfJs } from '@inksign/pdf'

// In Node, the default pdf.js build reaches for DOM globals such as
// DOMMatrix. Reading a document server-side needs the legacy build.
setPdfJs(await import('pdfjs-dist/legacy/build/pdf.mjs'))
```

This is also the route for pinning a version, loading from a CDN, or working with a bundler that will not resolve an optional peer dependency. `setPdfLib` does the same for pdf-lib.

## Anchor placement

```ts
import { applyAnchors } from '@inksign/pdf'

const { resolved, unmatched } = await applyAnchors(document, [
  { ...field, anchor: { text: 'Authorized signature', from: 'bottom', offsetY: 18 } },
])
```

Binds a field to text instead of to coordinates, so placements survive the document being regenerated. A field whose anchor names no occurrence is expanded into one field per match, which is how "initial every page" works. Unmatched anchors are reported rather than silently dropped.

A PDF has no notion of a word, only positioned glyph runs, so the text is reassembled with a space inserted where the horizontal gap implies a word break. Without that, `Authorized signature` would never match.

## Flattening and certificates

```ts
import { buildCertificate, mergeDocuments, stampDocument } from '@inksign/pdf'

const signed = await stampDocument({
  bytes: original,
  fields: resolved,
  values,
  metadata: { title: 'Signed NDA', envelopeId: envelope.id, sealDigest: sealed.digest },
})

const certificate = await buildCertificate({ envelope, trail, seal: sealed, branding })
const final = await mergeDocuments([signed, certificate])
```

Values are drawn into the page content, not left as interactive form fields, so the output cannot be retyped in a PDF reader. An AcroForm signature that any viewer can edit is not evidence of anything.

Vector signature paths are preferred over the raster copy: sharp at any size, and a few hundred bytes against tens of kilobytes. A signature repeated across pages is embedded once and referenced, rather than embedded per field.

## License

MIT
