import type { DocumentSource, FieldId, PageSize } from '@inksign/core'
import {
  createViewport,
  fieldToCss,
  type LoadedDocument,
  type LoadOptions,
  loadDocument,
  PageRenderer,
} from '@inksign/pdf'
import {
  anchoredScroll,
  computeLayout,
  type DocumentLayout,
  fitWidthScale,
  nextZoom,
  type PageLayout,
  previousZoom,
  visibleRange,
} from '@inksign/ui'
import {
  type CSSProperties,
  computed,
  defineComponent,
  h,
  onBeforeUnmount,
  type PropType,
  ref,
  type ShallowRef,
  type SlotsType,
  shallowRef,
  type VNode,
  watch,
} from 'vue'
import { useElementSize, usePageFields } from './composables.js'
import { useInkSign } from './context.js'

/**
 * Loads a PDF and keeps a renderer for it.
 *
 * The renderer is disposed when the scope ends, which releases the pdf.js
 * worker and the cached bitmaps. Forgetting that is how an application ends up
 * holding a worker per document the user has opened.
 */
export function useDocument(
  source: ShallowRef<DocumentSource | undefined> | (() => DocumentSource | undefined),
  options?: LoadOptions & { rendererOptions?: ConstructorParameters<typeof PageRenderer>[1] },
): {
  document: ShallowRef<LoadedDocument | undefined>
  renderer: ShallowRef<PageRenderer | undefined>
  loading: ShallowRef<boolean>
  error: ShallowRef<Error | undefined>
} {
  const document = shallowRef<LoadedDocument | undefined>(undefined)
  const renderer = shallowRef<PageRenderer | undefined>(undefined)
  const loading = shallowRef(false)
  const error = shallowRef<Error | undefined>(undefined)

  const read = typeof source === 'function' ? source : () => source.value
  let token = 0

  const dispose = (): void => {
    const current = renderer.value
    renderer.value = undefined
    document.value = undefined
    void current?.dispose()
  }

  watch(
    () => {
      const value = read()
      // Keyed on a stable digest of the source, because the object identity
      // changes on every render while the document does not.
      return value ? sourceKey(value) : undefined
    },
    () => {
      const value = read()
      dispose()

      if (!value) {
        loading.value = false
        error.value = undefined
        return
      }

      const mine = ++token
      loading.value = true
      error.value = undefined

      loadDocument(value, options ?? {})
        .then((loaded) => {
          if (mine !== token) {
            void loaded.destroy()
            return
          }
          document.value = loaded
          renderer.value = new PageRenderer(loaded, options?.rendererOptions)
          loading.value = false
        })
        .catch((cause: unknown) => {
          if (mine !== token) return
          error.value = cause instanceof Error ? cause : new Error(String(cause))
          loading.value = false
        })
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    token += 1
    dispose()
  })

  return { document, renderer, loading, error }
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
 * Renders that scroll out of view are cancelled rather than left to finish, so
 * a fast scroll does not leave the worker rasterizing pages nobody will see
 * while the page actually on screen waits behind them.
 */
export const DocumentViewer = defineComponent({
  name: 'InkSignDocumentViewer',
  props: {
    documentId: { type: String, required: true },
    renderer: { type: Object as PropType<PageRenderer | undefined>, default: undefined },
    pageSizes: { type: Array as PropType<readonly PageSize[]>, required: true },
    scale: { type: [Number, String] as PropType<number | 'fit-width'>, default: 'fit-width' },
    rotation: { type: Number, default: 0 },
    overscan: { type: Number, default: 1 },
    height: { type: [Number, String] as PropType<number | string>, default: '100%' },
  },
  emits: {
    pageChange: (_page: number) => true,
  },
  slots: Object as SlotsType<{
    field: { fieldId: FieldId; box: FieldBox }
  }>,
  setup(props, { emit, slots }) {
    const { elementRef, size } = useElementSize()
    const scrollEl = ref<HTMLElement | null>(null)
    const scrollTop = ref(0)
    let frame: number | undefined

    const setRef = (element: unknown): void => {
      const el = (element as HTMLElement | null) ?? null
      scrollEl.value = el
      elementRef(el)
    }

    const resolvedScale = computed(() => {
      if (props.scale !== 'fit-width') return props.scale as number
      const first = props.pageSizes[0]
      if (!first || size.value.width <= 0) return 1
      return fitWidthScale(first, size.value.width, 16, props.rotation)
    })

    const layout = computed<DocumentLayout>(() =>
      computeLayout({
        pageSizes: props.pageSizes,
        scale: resolvedScale.value,
        containerWidth: size.value.width || 800,
        rotation: props.rotation,
      }),
    )

    const range = computed(() =>
      visibleRange(layout.value, scrollTop.value, size.value.height || 800, props.overscan),
    )

    // Cancel anything outside the window so the worker serves what is on
    // screen, then queue the neighbours behind it.
    watch(
      () => [props.renderer, range.value, resolvedScale.value] as const,
      ([renderer, window_, scale]) => {
        if (!renderer) return
        renderer.cancelExcept([...window_.visible, ...window_.prefetch])
        renderer.prefetch(window_.prefetch, scale)
      },
      { immediate: true },
    )

    watch(
      () => range.value.dominant,
      (page) => {
        if (page !== undefined) emit('pageChange', page)
      },
    )

    // Scroll position is read from the element and coalesced to one update per
    // frame, rather than written on every scroll event.
    const onScroll = (): void => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        scrollTop.value = scrollEl.value?.scrollTop ?? 0
      })
    }

    onBeforeUnmount(() => {
      if (frame !== undefined) cancelAnimationFrame(frame)
    })

    return () =>
      h(
        'div',
        {
          ref: setRef,
          onScroll,
          'data-inksign-viewer': '',
          style: {
            position: 'relative',
            height: typeof props.height === 'number' ? `${props.height}px` : props.height,
            overflow: 'auto',
            background: 'var(--inksign-surface-sunken, #f1f2f6)',
          } satisfies CSSProperties,
        },
        [
          h(
            'div',
            { style: { position: 'relative', height: `${layout.value.totalHeight}px` } },
            range.value.visible.map((page) => {
              const pageLayout = layout.value.pages[page]
              if (!pageLayout) return null
              return h(PageView, {
                key: page,
                documentId: props.documentId,
                layout: pageLayout,
                renderer: props.renderer,
                pageSize: props.pageSizes[page],
                scale: resolvedScale.value,
                rotation: props.rotation,
                renderField: slots.field,
              })
            }),
          ),
        ],
      )
  },
})

/**
 * One page: a canvas plus its field overlay.
 *
 * Keyed by page number, so scrolling mounts and unmounts pages rather than
 * repainting the ones that merely stayed on screen.
 */
const PageView = defineComponent({
  name: 'InkSignPageView',
  props: {
    documentId: { type: String, required: true },
    layout: { type: Object as PropType<PageLayout>, required: true },
    renderer: { type: Object as PropType<PageRenderer | undefined>, default: undefined },
    pageSize: { type: Object as PropType<PageSize | undefined>, default: undefined },
    scale: { type: Number, required: true },
    rotation: { type: Number, required: true },
    renderField: {
      type: Function as PropType<
        ((props: { fieldId: FieldId; box: FieldBox }) => VNode | VNode[]) | undefined
      >,
      default: undefined,
    },
  },
  setup(props) {
    const { store } = useInkSign()
    const canvasRef = ref<HTMLCanvasElement | null>(null)
    const painted = ref(false)
    const fieldIds = usePageFields(props.documentId, props.layout.page)

    let token = 0

    watch(
      () => [props.renderer, props.scale, props.layout.page] as const,
      ([renderer, scale, page]) => {
        if (!renderer) return
        const mine = ++token

        renderer
          .render(page, scale)
          .then((rendered) => {
            if (mine !== token) return
            const canvas = canvasRef.value
            if (!canvas) return

            canvas.width = rendered.canvas.width
            canvas.height = rendered.canvas.height

            const context = canvas.getContext('2d')
            if (!context) return
            // The renderer may have used an OffscreenCanvas, which draws onto
            // a visible canvas directly.
            context.drawImage(rendered.canvas as unknown as CanvasImageSource, 0, 0)
            painted.value = true
          })
          .catch(() => {
            // A cancelled render is the normal result of scrolling past a
            // page. It is requested again if the page comes back into view.
          })
      },
      { immediate: true, flush: 'post' },
    )

    const viewport = computed(() =>
      props.pageSize
        ? createViewport(props.pageSize, { scale: props.scale, rotation: props.rotation })
        : undefined,
    )

    return () => {
      const overlay: VNode[] = []
      const render = props.renderField
      const view = viewport.value

      if (render && view) {
        for (const fieldId of fieldIds.value) {
          const field = store.getField(fieldId)
          if (!field) continue
          const box = fieldToCss(field.rect, view)
          const rendered = render({
            fieldId,
            box: { ...box, page: props.layout.page, scale: props.scale },
          })
          if (Array.isArray(rendered)) overlay.push(...rendered)
          else if (rendered) overlay.push(rendered)
        }
      }

      return h(
        'div',
        {
          'data-inksign-page': props.layout.page,
          style: {
            position: 'absolute',
            top: `${props.layout.top}px`,
            left: `${props.layout.left}px`,
            width: `${props.layout.width}px`,
            height: `${props.layout.height}px`,
            background: '#ffffff',
            boxShadow: 'var(--inksign-shadow, 0 2px 8px rgba(20, 22, 29, 0.1))',
            borderRadius: '2px',
            overflow: 'hidden',
          } satisfies CSSProperties,
        },
        [
          h('canvas', {
            ref: canvasRef,
            // The rendered page is a picture of text a screen reader cannot
            // read, so it is hidden rather than announced as an unlabelled
            // image. The fields over it are real inputs with real labels.
            'aria-hidden': 'true',
            tabindex: -1,
            style: {
              display: 'block',
              width: '100%',
              height: '100%',
              opacity: painted.value ? 1 : 0,
              transition: 'opacity 120ms linear',
            } satisfies CSSProperties,
          }),
          ...overlay,
        ],
      )
    }
  },
})

/** Zoom controls, wired to the step list. */
export function useZoom(initial: number | 'fit-width' = 'fit-width') {
  const scale = shallowRef<number | 'fit-width'>(initial)

  return {
    scale,
    setScale: (next: number | 'fit-width') => {
      scale.value = next
    },
    zoomIn: () => {
      scale.value = nextZoom(typeof scale.value === 'number' ? scale.value : 1)
    },
    zoomOut: () => {
      scale.value = previousZoom(typeof scale.value === 'number' ? scale.value : 1)
    },
    fitWidth: () => {
      scale.value = 'fit-width'
    },
    /** Keeps the point under the cursor fixed, for ctrl-scroll zooming. */
    zoomAt: (
      next: number,
      element: HTMLElement | null,
      pointerClientY: number,
      current: number,
    ) => {
      scale.value = next
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
