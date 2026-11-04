import type { DocumentSource, FieldId, InkSignature, PageSize } from '@inksign/core'
import {
  createViewport,
  fieldToCss,
  type LoadedDocument,
  type LoadOptions,
  loadDocument,
  PageRenderer,
} from '@inksign/pdf'
import {
  computeLayout,
  type DocumentLayout,
  fitWidthScale,
  SignaturePad as PadController,
  type SignaturePadOptions,
  visibleRange,
} from '@inksign/ui'
import { fromBinding, type Readable, type Unsubscriber } from './stores.js'

/**
 * Svelte actions.
 *
 * An action is Svelte's answer to behaviour that owns a DOM node, which is
 * exactly what the signature pad and the document viewer are. Using actions
 * rather than wrapper components keeps this layer compiler-free, so the
 * package works the same in Svelte 3, 4 and 5, and leaves the markup and
 * styling entirely to the host application.
 */

export interface ActionReturn<P = undefined> {
  update?: (parameter: P) => void
  destroy?: () => void
}

export interface SignaturePadActionOptions extends Omit<SignaturePadOptions, 'onChange'> {
  /** Called whenever the drawn content changes. */
  onChange?: ((state: { isEmpty: boolean; strokeCount: number }) => void) | undefined
  /** Called with the finished signature when a stroke ends. */
  onSignature?: ((signature: InkSignature | undefined) => void) | undefined
  /** Restores a previously captured signature on mount. */
  initialSignature?: InkSignature | undefined
  /** Receives the controller, so the host can clear, undo or export. */
  onReady?: ((pad: PadController) => void) | undefined
}

/**
 * Attaches a signature pad to a canvas.
 *
 * ```svelte
 * <canvas use:signaturePad={{ color: '#1f2a5e', onSignature: (s) => (signature = s) }} />
 * ```
 *
 * Drawing stays off Svelte's reactivity on purpose: a stylus produces pointer
 * events at up to 240 Hz, and routing those through component state would mean
 * an update per sample. The controller writes to the canvas directly and only
 * reports meaningful changes.
 */
export function signaturePad(
  canvas: HTMLCanvasElement,
  options: SignaturePadActionOptions = {},
): ActionReturn<SignaturePadActionOptions> {
  let current = options

  const { onChange, onSignature, initialSignature, onReady, ...padOptions } = options

  const pad = new PadController(canvas, {
    ...padOptions,
    onChange: (state) => current.onChange?.(state),
    onStrokeEnd: () => current.onSignature?.(pad.toSignature()),
  })

  if (initialSignature) pad.fromSignature(initialSignature)
  onReady?.(pad)

  // The canvas backing store has to follow the element's size, or the ink
  // stops lining up with the pointer.
  const ResizeObserverCtor = (globalThis as { ResizeObserver?: typeof ResizeObserver })
    .ResizeObserver
  const observer = ResizeObserverCtor ? new ResizeObserverCtor(() => pad.resize()) : undefined
  observer?.observe(canvas)

  return {
    update(next: SignaturePadActionOptions) {
      current = next
      // Applied in place rather than by rebuilding, which would discard
      // whatever the signer had already drawn.
      const { onChange: _c, onSignature: _s, initialSignature: _i, onReady: _r, ...rest } = next
      pad.setOptions(rest)
    },
    destroy() {
      observer?.disconnect()
      pad.dispose()
    },
  }
}

export interface ViewerState {
  layout: DocumentLayout
  /** Pages currently mounted. */
  visible: readonly number[]
  /** Page occupying the most viewport area, for a page indicator. */
  dominant: number | undefined
  scale: number
}

export interface DocumentViewerActionOptions {
  renderer: PageRenderer | undefined
  pageSizes: readonly PageSize[]
  /** Scale, or `'fit-width'` to track the container. Defaults to fit-width. */
  scale?: number | 'fit-width' | undefined
  rotation?: number | undefined
  /** Pages rendered beyond the viewport. Defaults to 1. */
  overscan?: number | undefined
  /** Called whenever the visible window or layout changes. */
  onState?: ((state: ViewerState) => void) | undefined
}

/**
 * Drives virtualization on a scroll container.
 *
 * The action owns the measuring, scrolling and render scheduling; the host
 * renders whatever markup it likes from the state it is handed. Only the pages
 * intersecting the viewport are reported, and renders for pages that scroll
 * away are cancelled, so a fast scroll does not leave the pdf.js worker
 * rasterizing pages nobody will see.
 */
export function documentViewer(
  container: HTMLElement,
  options: DocumentViewerActionOptions,
): ActionReturn<DocumentViewerActionOptions> {
  let current = options
  let frame: number | undefined
  let size = { width: container.clientWidth, height: container.clientHeight }

  const compute = (): void => {
    const rotation = current.rotation ?? 0
    const first = current.pageSizes[0]

    const scale =
      current.scale === undefined || current.scale === 'fit-width'
        ? first && size.width > 0
          ? fitWidthScale(first, size.width, 16, rotation)
          : 1
        : current.scale

    const layout = computeLayout({
      pageSizes: current.pageSizes,
      scale,
      containerWidth: size.width || 800,
      rotation,
    })

    const window_ = visibleRange(
      layout,
      container.scrollTop,
      size.height || 800,
      current.overscan ?? 1,
    )

    const renderer = current.renderer
    if (renderer) {
      renderer.cancelExcept([...window_.visible, ...window_.prefetch])
      renderer.prefetch(window_.prefetch, scale)
    }

    current.onState?.({
      layout,
      visible: window_.visible,
      dominant: window_.dominant,
      scale,
    })
  }

  // Scroll is coalesced to one update per frame rather than one per event.
  const onScroll = (): void => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      compute()
    })
  }

  container.addEventListener('scroll', onScroll, { passive: true })

  const ResizeObserverCtor = (globalThis as { ResizeObserver?: typeof ResizeObserver })
    .ResizeObserver
  const observer = ResizeObserverCtor
    ? new ResizeObserverCtor((entries) => {
        const box = entries[0]?.contentRect
        if (!box) return
        // Sub-pixel jitter would otherwise relayout the whole document.
        if (Math.abs(size.width - box.width) < 0.5 && Math.abs(size.height - box.height) < 0.5) {
          return
        }
        size = { width: box.width, height: box.height }
        compute()
      })
    : undefined
  observer?.observe(container)

  compute()

  return {
    update(next: DocumentViewerActionOptions) {
      current = next
      compute()
    },
    destroy() {
      container.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    },
  }
}

/**
 * Paints a rendered page onto a canvas.
 *
 * ```svelte
 * <canvas use:renderPage={{ renderer, page, scale }} aria-hidden="true" tabindex="-1" />
 * ```
 */
export function renderPage(
  canvas: HTMLCanvasElement,
  options: { renderer: PageRenderer | undefined; page: number; scale: number },
): ActionReturn<{ renderer: PageRenderer | undefined; page: number; scale: number }> {
  let token = 0

  const paint = (next: typeof options): void => {
    if (!next.renderer) return
    const mine = ++token

    next.renderer
      .render(next.page, next.scale)
      .then((rendered) => {
        if (mine !== token) return
        canvas.width = rendered.canvas.width
        canvas.height = rendered.canvas.height

        const context = canvas.getContext('2d')
        if (!context) return
        // The renderer may have used an OffscreenCanvas, which draws onto a
        // visible canvas directly.
        context.drawImage(rendered.canvas as unknown as CanvasImageSource, 0, 0)
        canvas.dataset.inksignPainted = ''
      })
      .catch(() => {
        // A cancelled render is the normal result of scrolling past a page.
      })
  }

  paint(options)

  return {
    update: paint,
    destroy() {
      token += 1
    },
  }
}

/**
 * Loads a PDF and exposes the renderer as a store.
 *
 * Disposal releases the pdf.js worker and the cached bitmaps, which is what
 * stops an application accumulating a worker per document opened.
 */
export interface DocumentHandle {
  document: Readable<LoadedDocument | undefined>
  renderer: Readable<PageRenderer | undefined>
  loading: Readable<boolean>
  error: Readable<Error | undefined>
  destroy(): void
}

export function createDocument(
  source: DocumentSource,
  options?: LoadOptions & { rendererOptions?: ConstructorParameters<typeof PageRenderer>[1] },
): DocumentHandle {
  let loadedDocument: LoadedDocument | undefined
  let pageRenderer: PageRenderer | undefined
  let isLoading = true
  let failure: Error | undefined
  let disposed = false

  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  const watch = (onChange: () => void): Unsubscriber => {
    listeners.add(onChange)
    return () => listeners.delete(onChange)
  }

  loadDocument(source, options ?? {})
    .then((loaded) => {
      if (disposed) {
        void loaded.destroy()
        return
      }
      loadedDocument = loaded
      pageRenderer = new PageRenderer(loaded, options?.rendererOptions)
      isLoading = false
      notify()
    })
    .catch((cause: unknown) => {
      if (disposed) return
      failure = cause instanceof Error ? cause : new Error(String(cause))
      isLoading = false
      notify()
    })

  return {
    document: fromBinding(watch, () => loadedDocument),
    renderer: fromBinding(watch, () => pageRenderer),
    loading: fromBinding(watch, () => isLoading),
    error: fromBinding(watch, () => failure),
    destroy() {
      disposed = true
      const current = pageRenderer
      pageRenderer = undefined
      loadedDocument = undefined
      void current?.dispose()
    },
  }
}

export interface FieldBox {
  left: number
  top: number
  width: number
  height: number
  page: number
  scale: number
}

/**
 * CSS boxes for the fields on a page, ready for absolute positioning.
 *
 * Kept here rather than left to the host so that a Svelte application places
 * fields with the same geometry as every other adapter, rather than
 * reimplementing the point-to-pixel conversion and getting rotation wrong.
 */
export function fieldBoxes(
  store: { getField(id: FieldId): { rect: Parameters<typeof fieldToCss>[0] } | undefined },
  fieldIds: readonly FieldId[],
  pageSize: PageSize,
  page: number,
  scale: number,
  rotation = 0,
): readonly { fieldId: FieldId; box: FieldBox }[] {
  const viewport = createViewport(pageSize, { scale, rotation })

  const out: { fieldId: FieldId; box: FieldBox }[] = []
  for (const fieldId of fieldIds) {
    const field = store.getField(fieldId)
    if (!field) continue
    out.push({ fieldId, box: { ...fieldToCss(field.rect, viewport), page, scale } })
  }
  return out
}
