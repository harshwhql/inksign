import type { DocumentSource, FieldId, PageSize } from '@inksign/core'
import {
  PageRenderer,
  type LoadOptions,
  type LoadedDocument,
  createViewport,
  fieldToCss,
  loadDocument,
} from '@inksign/pdf'
import {
  anchoredScroll,
  computeLayout,
  fitWidthScale,
  nextZoom,
  previousZoom,
  visibleRange,
  type DocumentLayout,
  type PageLayout,
} from '@inksign/ui'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useInkSign } from './context.js'
import { useElementSize, usePageFields } from './hooks.js'

/**
 * Loads a PDF and keeps a renderer for it.
 *
 * The renderer is disposed on unmount, which releases the pdf.js worker and
 * the cached bitmaps. Forgetting that is how a single-page application ends up
 * holding a worker per document the user has opened.
 */
export function useDocument(
  source: DocumentSource | undefined,
  options?: LoadOptions & { rendererOptions?: ConstructorParameters<typeof PageRenderer>[1] },
): {
  document: LoadedDocument | undefined
  renderer: PageRenderer | undefined
  loading: boolean
  error: Error | undefined
} {
  const [state, setState] = useState<{
    document: LoadedDocument | undefined
    renderer: PageRenderer | undefined
    loading: boolean
    error: Error | undefined
  }>({ document: undefined, renderer: undefined, loading: source !== undefined, error: undefined })

  const key = source ? sourceKey(source) : undefined
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (!source) {
      setState({ document: undefined, renderer: undefined, loading: false, error: undefined })
      return
    }

    let cancelled = false
    let renderer: PageRenderer | undefined

    setState((previous) => ({ ...previous, loading: true, error: undefined }))

    loadDocument(source, optionsRef.current ?? {})
      .then((document) => {
        if (cancelled) {
          void document.destroy()
          return
        }
        renderer = new PageRenderer(document, optionsRef.current?.rendererOptions)
        setState({ document, renderer, loading: false, error: undefined })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          document: undefined,
          renderer: undefined,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        })
      })

    return () => {
      cancelled = true
      void renderer?.dispose()
    }
    // `key` identifies the source; the object identity may change per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return state
}

function sourceKey(source: DocumentSource): string {
  switch (source.kind) {
    case 'url':
      return `url:${source.url}`
    case 'storage':
      return `storage:${source.key}`
    case 'base64':
      return `base64:${source.data.length}:${source.data.slice(0, 64)}`
    case 'bytes':
      return `bytes:${source.bytes.byteLength}`
  }
}

export interface DocumentViewerProps {
  documentId: string
  renderer: PageRenderer | undefined
  pageSizes: readonly PageSize[]
  /** Scale, or `'fit-width'` to track the container. Defaults to fit-width. */
  scale?: number | 'fit-width' | undefined
  /** Extra rotation in degrees. */
  rotation?: number | undefined
  /** Pages rendered beyond the viewport. Defaults to 1. */
  overscan?: number | undefined
  /** Renders the overlay for one field. */
  renderField?: ((fieldId: FieldId, box: FieldBox) => ReactNode) | undefined
  onPageChange?: ((page: number) => void) | undefined
  className?: string | undefined
  style?: React.CSSProperties | undefined
  height?: number | string | undefined
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
 * Virtualized PDF viewer with a field overlay.
 *
 * Only the pages intersecting the viewport are mounted, and their neighbours
 * are rendered ahead of the scroll. A 200 page agreement costs the same as a
 * two page one, which is the difference between a viewer that works on a real
 * contract and a demo.
 *
 * Renders that scroll out of view are cancelled rather than left to finish,
 * so a fast scroll does not leave the worker rasterizing pages nobody will
 * see while the page actually on screen waits behind them.
 */
export function DocumentViewer({
  documentId,
  renderer,
  pageSizes,
  scale = 'fit-width',
  rotation = 0,
  overscan = 1,
  renderField,
  onPageChange,
  className,
  style,
  height = '100%',
}: DocumentViewerProps): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [containerRef, containerSize] = useElementSize()
  const [scrollTop, setScrollTop] = useState(0)

  const firstPage = pageSizes[0]
  const resolvedScale =
    scale === 'fit-width'
      ? firstPage && containerSize.width > 0
        ? fitWidthScale(firstPage, containerSize.width, 16, rotation)
        : 1
      : scale

  const layout = useMemo<DocumentLayout>(
    () =>
      computeLayout({
        pageSizes,
        scale: resolvedScale,
        containerWidth: containerSize.width || 800,
        rotation,
      }),
    [pageSizes, resolvedScale, containerSize.width, rotation],
  )

  const range = useMemo(
    () => visibleRange(layout, scrollTop, containerSize.height || 800, overscan),
    [layout, scrollTop, containerSize.height, overscan],
  )

  // Cancel anything outside the window so the worker serves what is on screen.
  useEffect(() => {
    if (!renderer) return
    renderer.cancelExcept([...range.visible, ...range.prefetch])
    renderer.prefetch(range.prefetch, resolvedScale)
  }, [renderer, range, resolvedScale])

  const dominantRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (range.dominant === undefined || range.dominant === dominantRef.current) return
    dominantRef.current = range.dominant
    onPageChange?.(range.dominant)
  }, [range.dominant, onPageChange])

  // Scroll is read from the element rather than kept in state per event, and
  // coalesced to one update per frame.
  const frameRef = useRef<number | undefined>(undefined)
  const onScroll = useCallback(() => {
    if (frameRef.current !== undefined) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined
      setScrollTop(scrollRef.current?.scrollTop ?? 0)
    })
  }, [])

  useEffect(
    () => () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  const setRefs = useCallback(
    (element: HTMLDivElement | null) => {
      ;(scrollRef as { current: HTMLDivElement | null }).current = element
      containerRef(element)
    },
    [containerRef],
  )

  return (
    <div
      ref={setRefs}
      onScroll={onScroll}
      className={className}
      data-inksign-viewer=""
      style={{
        position: 'relative',
        height,
        overflow: 'auto',
        background: 'var(--inksign-surface-sunken, #f1f2f6)',
        ...style,
      }}
    >
      <div style={{ position: 'relative', height: layout.totalHeight }}>
        {range.visible.map((page) => {
          const pageLayout = layout.pages[page]
          if (!pageLayout) return null
          return (
            <PageView
              key={page}
              documentId={documentId}
              layout={pageLayout}
              renderer={renderer}
              pageSize={pageSizes[page]}
              scale={resolvedScale}
              rotation={rotation}
              renderField={renderField}
            />
          )
        })}
      </div>
    </div>
  )
}

interface PageViewProps {
  documentId: string
  layout: PageLayout
  renderer: PageRenderer | undefined
  pageSize: PageSize | undefined
  scale: number
  rotation: number
  renderField?: ((fieldId: FieldId, box: FieldBox) => ReactNode) | undefined
}

/**
 * One page: a canvas plus its field overlay.
 *
 * Memoized on its layout and scale so that scrolling, which changes the
 * visible set but not an individual page's geometry, does not repaint pages
 * that merely stayed on screen.
 */
const PageView = memo(function PageView({
  documentId,
  layout,
  renderer,
  pageSize,
  scale,
  rotation,
  renderField,
}: PageViewProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [painted, setPainted] = useState(false)
  const fieldIds = usePageFields(documentId, layout.page)

  useLayoutEffect(() => {
    if (!renderer) return
    let cancelled = false

    renderer
      .render(layout.page, scale)
      .then((rendered) => {
        if (cancelled) return
        const canvas = canvasRef.current
        if (!canvas) return

        canvas.width = rendered.canvas.width
        canvas.height = rendered.canvas.height

        const context = canvas.getContext('2d')
        if (!context) return
        // The renderer may have used an OffscreenCanvas, which draws onto a
        // visible canvas directly.
        context.drawImage(rendered.canvas as unknown as CanvasImageSource, 0, 0)
        setPainted(true)
      })
      .catch(() => {
        // A cancelled render is the normal result of scrolling past a page.
        // It will be requested again if the page comes back into view.
      })

    return () => {
      cancelled = true
    }
  }, [renderer, layout.page, scale])

  const viewport = useMemo(
    () => (pageSize ? createViewport(pageSize, { scale, rotation }) : undefined),
    [pageSize, scale, rotation],
  )

  return (
    <div
      data-inksign-page={layout.page}
      style={{
        position: 'absolute',
        top: layout.top,
        left: layout.left,
        width: layout.width,
        height: layout.height,
        background: '#ffffff',
        boxShadow: 'var(--inksign-shadow, 0 2px 8px rgba(20, 22, 29, 0.1))',
        borderRadius: 2,
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          opacity: painted ? 1 : 0,
          transition: 'opacity 120ms linear',
        }}
      />
      {renderField && viewport
        ? fieldIds.map((fieldId) => (
            <FieldOverlay
              key={fieldId}
              fieldId={fieldId}
              viewport={viewport}
              scale={scale}
              page={layout.page}
              renderField={renderField}
            />
          ))
        : null}
    </div>
  )
})

interface FieldOverlayProps {
  fieldId: FieldId
  viewport: ReturnType<typeof createViewport>
  scale: number
  page: number
  renderField: (fieldId: FieldId, box: FieldBox) => ReactNode
}

/** Positions one field over the page, converting points to CSS pixels. */
function FieldOverlay({
  fieldId,
  viewport,
  scale,
  page,
  renderField,
}: FieldOverlayProps): ReactNode {
  const { store } = useInkSign()
  const field = store.getField(fieldId)
  if (!field) return null

  const box = fieldToCss(field.rect, viewport)
  return <>{renderField(fieldId, { ...box, page, scale })}</>
}

/** Zoom controls, wired to the step list. */
export function useZoom(initial: number | 'fit-width' = 'fit-width'): {
  scale: number | 'fit-width'
  setScale: (scale: number | 'fit-width') => void
  zoomIn: () => void
  zoomOut: () => void
  fitWidth: () => void
  /** Keeps the point under the cursor fixed, for ctrl-scroll zooming. */
  zoomAt: (
    next: number,
    element: HTMLElement | null,
    pointerClientY: number,
    current: number,
  ) => void
} {
  const [scale, setScale] = useState<number | 'fit-width'>(initial)

  return {
    scale,
    setScale,
    zoomIn: () => setScale((current) => nextZoom(typeof current === 'number' ? current : 1)),
    zoomOut: () => setScale((current) => previousZoom(typeof current === 'number' ? current : 1)),
    fitWidth: () => setScale('fit-width'),
    zoomAt: (next, element, pointerClientY, current) => {
      setScale(next)
      if (!element) return
      const rect = element.getBoundingClientRect()
      element.scrollTop = anchoredScroll(
        current,
        next,
        element.scrollTop,
        pointerClientY - rect.top,
      )
    },
  }
}
