import type { PageSize } from '@inksign/core'
import { InkSignError } from '@inksign/core'
import type { LoadedDocument, PdfPageProxy } from './loader.js'

/**
 * Page rasterizer.
 *
 * Rendering a PDF page is the most expensive thing a signing UI does, and a
 * long document scrolled quickly will ask for far more renders than it needs.
 * Four things keep that under control:
 *
 * - **Cancellation.** A page that scrolls out of view before its render
 *   finishes has its task cancelled, so the worker moves on to what is now
 *   visible instead of finishing work nobody will see.
 * - **Bounded concurrency.** pdf.js runs on one worker, so firing twenty
 *   renders at once only queues them behind each other while multiplying peak
 *   memory. A small limit keeps latency predictable.
 * - **Scale bucketing.** Rendering is cached per page and per rounded scale,
 *   so a pinch-zoom that passes through forty intermediate scales produces a
 *   handful of renders rather than forty.
 * - **An LRU cache with a pixel budget.** Bitmaps are bounded by total pixels
 *   rather than by count, because one page at 400% costs as much as sixteen at
 *   100%, and a count-based cache would let a zoomed document exhaust memory.
 */

export interface RenderedPage {
  readonly page: number
  readonly scale: number
  readonly width: number
  readonly height: number
  /** Backing store resolution, which is `scale` times the device pixel ratio. */
  readonly pixelRatio: number
  readonly canvas: CanvasLike
}

/** Either an on-screen canvas or an OffscreenCanvas. */
export interface CanvasLike {
  width: number
  height: number
  getContext(type: '2d', options?: Record<string, unknown>): unknown
}

export interface RendererOptions {
  /** Concurrent render tasks. Defaults to 2, which suits one pdf.js worker. */
  concurrency?: number
  /**
   * Cache budget in megapixels. Defaults to 32, roughly eight letter pages at
   * 150 dpi. Raise it for long documents on desktop, lower it for mobile.
   */
  cacheBudgetMegapixels?: number
  /** Caps the backing store resolution. Defaults to 2. */
  maxPixelRatio?: number
  /** Scale values are rounded to this step before caching. Defaults to 0.25. */
  scaleStep?: number
  /** Overrides the device pixel ratio, mainly for tests. */
  devicePixelRatio?: number
}

interface CacheEntry {
  key: string
  rendered: RenderedPage
  pixels: number
}

interface QueuedTask {
  key: string
  page: number
  scale: number
  resolve(value: RenderedPage): void
  reject(error: unknown): void
  cancelled: boolean
}

export class PageRenderer {
  private readonly concurrency: number
  private readonly budgetPixels: number
  private readonly maxPixelRatio: number
  private readonly scaleStep: number
  private readonly dpr: number

  /** Insertion-ordered, which a Map gives us, so the first key is the oldest. */
  private readonly cache = new Map<string, CacheEntry>()
  private cachedPixels = 0

  private readonly queue: QueuedTask[] = []
  private readonly active = new Map<string, { cancel(): void }>()
  private readonly inFlight = new Map<string, Promise<RenderedPage>>()
  private running = 0
  private disposed = false

  constructor(
    private readonly document: LoadedDocument,
    options: RendererOptions = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? 2)
    this.budgetPixels = (options.cacheBudgetMegapixels ?? 32) * 1_000_000
    this.maxPixelRatio = options.maxPixelRatio ?? 2
    this.scaleStep = options.scaleStep ?? 0.25
    this.dpr =
      options.devicePixelRatio ??
      (globalThis as { devicePixelRatio?: number }).devicePixelRatio ??
      1
  }

  get pageCount(): number {
    return this.document.pageCount
  }

  pageSize(page: number): PageSize {
    const size = this.document.pageSizes[page]
    if (!size) {
      throw new InkSignError('RENDER_FAILED', `Page ${page} is outside this document`, {
        page,
        pageCount: this.document.pageCount,
      })
    }
    return size
  }

  /** A cached render at this page and scale, if there is one. */
  peek(page: number, scale: number): RenderedPage | undefined {
    const entry = this.cache.get(this.keyFor(page, scale))
    if (!entry) return undefined
    // Touch it so the most recently used entry is evicted last.
    this.cache.delete(entry.key)
    this.cache.set(entry.key, entry)
    return entry.rendered
  }

  /**
   * Renders a page, returning a cached bitmap when one exists.
   *
   * Concurrent calls for the same page and scale share one render rather than
   * starting duplicates, which matters because a scroll handler and a resize
   * observer will often ask for the same page in the same frame.
   */
  async render(page: number, scale: number): Promise<RenderedPage> {
    if (this.disposed) {
      throw new InkSignError('RENDER_FAILED', 'This renderer has been disposed')
    }

    const bucketed = this.bucketScale(scale)
    const key = this.keyFor(page, bucketed)

    const cached = this.peek(page, bucketed)
    if (cached) return cached

    const existing = this.inFlight.get(key)
    if (existing) return existing

    const promise = new Promise<RenderedPage>((resolve, reject) => {
      this.queue.push({ key, page, scale: bucketed, resolve, reject, cancelled: false })
      this.pump()
    }).finally(() => {
      this.inFlight.delete(key)
    })

    this.inFlight.set(key, promise)
    return promise
  }

  /**
   * Abandons any pending or running render for a page.
   *
   * Call this as pages leave the viewport. Without it, a fast scroll leaves
   * the worker rasterizing pages the user has already passed.
   */
  cancel(page: number): void {
    for (const task of this.queue) {
      if (task.page === page) task.cancelled = true
    }
    for (const [key, task] of this.active) {
      if (keyPage(key) === page) {
        task.cancel()
        this.active.delete(key)
      }
    }
  }

  /** Cancels every render except those for the given pages. */
  cancelExcept(keep: readonly number[]): void {
    const keepSet = new Set(keep)
    for (const task of this.queue) {
      if (!keepSet.has(task.page)) task.cancelled = true
    }
    for (const [key, task] of this.active) {
      if (!keepSet.has(keyPage(key))) {
        task.cancel()
        this.active.delete(key)
      }
    }
  }

  /**
   * Renders pages likely to be needed next, at low priority.
   *
   * Prefetching is what makes scrolling feel instant, but it competes with the
   * visible page for the one worker, so these go to the back of the queue.
   */
  prefetch(pages: readonly number[], scale: number): void {
    for (const page of pages) {
      if (page < 0 || page >= this.document.pageCount) continue
      if (this.peek(page, scale)) continue
      void this.render(page, scale).catch(() => {
        // A prefetch that fails or is cancelled is not an error worth raising:
        // the page will be rendered again, and reported, if it is scrolled to.
      })
    }
  }

  /** Drops cached bitmaps, freeing their memory. */
  clearCache(): void {
    this.cache.clear()
    this.cachedPixels = 0
  }

  /** Cancels everything and releases the document. */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const task of this.queue) task.cancelled = true
    this.queue.length = 0
    for (const task of this.active.values()) task.cancel()
    this.active.clear()
    this.clearCache()
    await this.document.destroy()
  }

  /** Cache statistics, for tuning and for tests. */
  get stats(): { entries: number; megapixels: number; queued: number; running: number } {
    return {
      entries: this.cache.size,
      megapixels: this.cachedPixels / 1_000_000,
      queued: this.queue.length,
      running: this.running,
    }
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const task = this.queue.shift()
      if (!task) return
      if (task.cancelled) {
        task.reject(
          new InkSignError('RENDER_FAILED', `Render of page ${task.page} was cancelled`, {
            page: task.page,
            cancelled: true,
          }),
        )
        continue
      }
      this.running += 1
      void this.run(task)
    }
  }

  private async run(task: QueuedTask): Promise<void> {
    let page: PdfPageProxy | undefined
    try {
      page = await this.document.proxy.getPage(task.page + 1)

      if (task.cancelled) {
        throw new InkSignError('RENDER_FAILED', `Render of page ${task.page} was cancelled`, {
          page: task.page,
          cancelled: true,
        })
      }

      const pixelRatio = Math.min(this.dpr, this.maxPixelRatio)
      const viewport = page.getViewport({ scale: task.scale * pixelRatio })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const context = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | null

      if (!context) {
        throw new InkSignError('RENDER_FAILED', 'Could not get a 2D canvas context', {
          page: task.page,
        })
      }

      const renderTask = page.render({ canvasContext: context, viewport })
      this.active.set(task.key, renderTask)
      await renderTask.promise
      this.active.delete(task.key)

      const rendered: RenderedPage = {
        page: task.page,
        scale: task.scale,
        width: viewport.width / pixelRatio,
        height: viewport.height / pixelRatio,
        pixelRatio,
        canvas,
      }

      this.store(task.key, rendered)
      task.resolve(rendered)
    } catch (error) {
      this.active.delete(task.key)
      task.reject(
        error instanceof InkSignError
          ? error
          : new InkSignError(
              'RENDER_FAILED',
              `Page ${task.page} failed to render: ${error instanceof Error ? error.message : String(error)}`,
              { page: task.page },
              { cause: error },
            ),
      )
    } finally {
      page?.cleanup()
      this.running -= 1
      this.pump()
    }
  }

  private store(key: string, rendered: RenderedPage): void {
    const pixels = rendered.canvas.width * rendered.canvas.height

    // A single render larger than the whole budget is served but not cached,
    // rather than evicting everything else to hold one page.
    if (pixels > this.budgetPixels) return

    this.cache.set(key, { key, rendered, pixels })
    this.cachedPixels += pixels

    while (this.cachedPixels > this.budgetPixels) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      // Never evict what was just stored, or a tight budget would thrash.
      if (oldest.value === key) break
      const entry = this.cache.get(oldest.value)
      this.cache.delete(oldest.value)
      if (entry) this.cachedPixels -= entry.pixels
    }
  }

  private bucketScale(scale: number): number {
    const stepped = Math.round(scale / this.scaleStep) * this.scaleStep
    // Round to four places so floating point noise cannot fragment the cache.
    return Math.max(this.scaleStep, Number(stepped.toFixed(4)))
  }

  private keyFor(page: number, scale: number): string {
    return `${page}@${scale}`
  }
}

function keyPage(key: string): number {
  return Number.parseInt(key.slice(0, key.indexOf('@')), 10)
}

/**
 * Creates the best available canvas.
 *
 * OffscreenCanvas keeps rasterization off the layout path, so a render in
 * progress does not force a style recalculation on the page the user is
 * reading. Not every runtime has it, so an ordinary canvas is the fallback.
 */
function createCanvas(width: number, height: number): CanvasLike {
  const offscreen = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => CanvasLike })
    .OffscreenCanvas
  if (offscreen) return new offscreen(width, height)

  const doc = (globalThis as { document?: Document }).document
  if (doc) {
    const canvas = doc.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas as unknown as CanvasLike
  }

  throw new InkSignError(
    'UNSUPPORTED',
    'No canvas implementation is available. In Node, install a canvas package and render on the client instead, or use stampDocument, which needs no canvas.',
  )
}

/**
 * Which pages to render and which to prefetch, for a scroll position.
 *
 * Kept here rather than in the viewer so that any UI, in any framework, makes
 * the same decision about what is worth rendering.
 */
export function visibleWindow(
  scrollTop: number,
  viewportHeight: number,
  pageOffsets: readonly { top: number; height: number }[],
  overscan = 1,
): { visible: readonly number[]; prefetch: readonly number[] } {
  const visible: number[] = []
  const bottom = scrollTop + viewportHeight

  for (let i = 0; i < pageOffsets.length; i += 1) {
    const offset = pageOffsets[i]
    if (!offset) continue
    const pageBottom = offset.top + offset.height
    if (pageBottom >= scrollTop && offset.top <= bottom) visible.push(i)
  }

  const first = visible[0]
  const last = visible[visible.length - 1]
  const prefetch: number[] = []

  if (first !== undefined && last !== undefined) {
    for (let i = 1; i <= overscan; i += 1) {
      if (first - i >= 0) prefetch.push(first - i)
      if (last + i < pageOffsets.length) prefetch.push(last + i)
    }
  }

  return { visible, prefetch }
}
