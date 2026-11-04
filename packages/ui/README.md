# @inksign/ui

Framework-agnostic UI for [InkSign](https://github.com/harshwhql/inksign): signature capture, document layout, white-label theming, accessibility helpers and web components. 8.9 kB minified and gzipped, and the signature pad on its own is 3.2 kB.

Nothing here imports a framework, so behaviour is implemented once and the framework adapters cannot drift apart.

```bash
npm install @inksign/ui
```

## Signature capture

```ts
import { SignaturePad } from '@inksign/ui'

const pad = new SignaturePad(canvas, { color: '#14161d', size: 8, thinning: 0.62 })

pad.isEmpty // false once drawn
pad.undo()
pad.toSignature() // vector paths plus a raster copy, trimmed and scaled to fit
```

A signature drawn as a fixed-width polyline looks like a signature drawn with a mouse, which undermines the point: people expect their signature to look like theirs.

So this builds an **outline** and fills it rather than stroking a path, which is what allows the width to vary along the stroke. `stroke-width` is constant for a whole path and cannot do it. Radius comes from stylus pressure when the hardware reports it, and from velocity otherwise, since a fast stroke with a real pen deposits less ink. Most signatures take the velocity path, because mice and trackpads report a constant pressure.

An in-progress stroke repaints alone rather than redrawing everything, so input latency stays flat however much has already been drawn.

Typed and uploaded signatures are supported too. No webfont is bundled: shipping a typeface with a signature library means shipping its licence as well, so the default stack uses faces already present on the platform and ends in the generic `cursive`. Pass your own `typeface` to use a webfont you have licensed.

## Web components

```html
<inksign-signature-pad ink="#1f2a5e" height="180"></inksign-signature-pad>

<script type="module">
  import { defineInkSignElements } from '@inksign/ui'
  defineInkSignElements()

  const pad = document.querySelector('inksign-signature-pad')
  pad.addEventListener('change', () => console.log(pad.isEmpty))
  const signature = pad.toSignature()
</script>
```

Custom elements are part of the platform, so this works in Vue, Svelte, Angular, Solid, Astro or plain HTML with no adapter. Registration is an explicit call rather than an import side effect, because a module with registration side effects breaks server rendering and cannot be tree-shaken.

## Theming

```ts
import { auditThemeContrast, createTheme, themeToVariables } from '@inksign/ui'

const theme = createTheme({
  brandColor: '#7c3aed',
  branding: { name: 'Northwind Legal', logoUrl: '/logo.svg' },
})
```

Every value resolves to a CSS custom property. That means no runtime cost, no style recalculation on theme change, and overrides from your own stylesheet without an `!important` fight or internal class names to reverse engineer. The prefix is configurable, so two instances on one page can be themed independently.

Text colour on your brand colour is chosen by measuring the contrast ratio of each candidate and taking the better one, not by thresholding luminance, which gets mid-tones wrong. `auditThemeContrast` checks a theme against WCAG AA, worth asserting in a test when the brand colour comes from a marketing palette:

```ts
expect(auditThemeContrast(theme).filter((check) => !check.passesAA)).toEqual([])
```

## Layout and virtualization

```ts
import { computeLayout, fitWidthScale, visibleRange } from '@inksign/ui'

const layout = computeLayout({ pageSizes, scale, containerWidth })
const { visible, prefetch, dominant } = visibleRange(layout, scrollTop, viewportHeight)
```

A 200 page agreement must not mount 200 canvases. The layout is computed from page sizes alone, so offsets and total height are known without rendering anything, and the first visible page is found by binary search rather than by walking the page list on every scroll event.

## Accessibility

A signing ceremony is a legal act, so it has to be completable without sight and without a mouse.

`announce` writes to a shared live region, one region rather than one per component, because several live regions compete. `trapFocus` traps focus and restores it to wherever it was on release, which is the part usually forgotten. `describeField` builds an accessible name saying what a field is, who it belongs to and whether it is required, since a bare box on a page conveys none of that. `bindFieldNavigation` wires arrow-key movement between fields without hijacking keys while someone is typing.

## License

MIT
