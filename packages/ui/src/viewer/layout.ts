import type { PageSize } from '@inksign/core'

/**
 * Document layout and virtualization.
 *
 * A 200 page agreement must not mount 200 canvases. The layout is computed
 * from page sizes alone, which gives a total height and a scroll offset per
 * page without rendering anything, and from there only the pages intersecting
 * the viewport are mounted.
 *
 * Offsets are computed once per scale rather than per scroll event, and a
 * binary search finds the first visible page, so scrolling stays flat rather
 * than walking the page list on every frame.
 */

export interface PageLayout {
  page: number
  /** Offset from the top of the scroll container, in CSS pixels. */
  top: number
  /** Rendered height including the gap below it. */
  height: number
  /** Rendered width. */
  width: number
  /** Horizontal offset that centres the page in the container. */
  left: number
}

export interface LayoutOptions {
  /** Page sizes in points, in document order. */
  pageSizes: readonly PageSize[]
  scale: number
  /** Container width in CSS pixels, used for centring and fit modes. */
  containerWidth: number
  /** Vertical gap between pages, in CSS pixels. Defaults to 16. */
  gap?: number
  /** Horizontal padding inside the container. Defaults to 16. */
  padding?: number
  /** Extra viewer rotation, in degrees. */
  rotation?: number
}

export interface DocumentLayout {
  pages: readonly PageLayout[]
  /** Total scrollable height, in CSS pixels. */
  totalHeight: number
  /** Width of the widest page, for horizontal scrolling. */
  contentWidth: number
  scale: number
}

/** Computes the layout for every page. */
export function computeLayout(options: LayoutOptions): DocumentLayout {
  const gap = options.gap ?? 16
  const padding = options.padding ?? 16
  const rotation = ((options.rotation ?? 0) % 360 + 360) % 360

  const pages: PageLayout[] = []
  let top = padding
  let contentWidth = 0

  for (let i = 0; i < options.pageSizes.length; i += 1) {
    const size = options.pageSizes[i]
    if (!size) continue

    const total = ((size.rotation ?? 0) + rotation) % 360
    const swapped = total === 90 || total === 270

    const width = (swapped ? size.height : size.width) * options.scale
    const height = (swapped ? size.width : size.height) * options.scale

    pages.push({
      page: i,
      top,
      height,
      width,
      left: Math.max(padding, (options.containerWidth - width) / 2),
    })

    top += height + gap
    if (width > contentWidth) contentWidth = width
  }

  return {
    pages,
    // The trailing gap is replaced by the bottom padding. An empty document
    // has no height at all, not two paddings' worth.
    totalHeight: pages.length === 0 ? 0 : Math.max(0, top - gap + padding),
    contentWidth: pages.length === 0 ? 0 : contentWidth + padding * 2,
    scale: options.scale,
  }
}

export interface VisibleRange {
  /** Pages intersecting the viewport. */
  visible: readonly number[]
  /** Pages just outside, worth rendering ahead of the scroll. */
  prefetch: readonly number[]
  /** Page occupying the most viewport area, for a page indicator. */
  dominant: number | undefined
}

/**
 * Finds which pages are on screen.
 *
 * The binary search matters more than it looks: this runs on every scroll
 * event, and a linear scan over a long document would do thousands of
 * comparisons per second for no reason.
 */
export function visibleRange(
  layout: DocumentLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan = 1,
): VisibleRange {
  const pages = layout.pages
  if (pages.length === 0) return { visible: [], prefetch: [], dominant: undefined }

  const viewportBottom = scrollTop + viewportHeight
  const start = firstPageAtOrAfter(pages, scrollTop)

  const visible: number[] = []
  let dominant: number | undefined
  let bestArea = 0

  for (let i = start; i < pages.length; i += 1) {
    const page = pages[i] as PageLayout
    if (page.top > viewportBottom) break

    visible.push(page.page)

    const overlap =
      Math.min(viewportBottom, page.top + page.height) - Math.max(scrollTop, page.top)
    if (overlap > bestArea) {
      bestArea = overlap
      dominant = page.page
    }
  }

  const first = visible[0]
  const last = visible[visible.length - 1]
  const prefetch: number[] = []

  if (first !== undefined && last !== undefined) {
    for (let i = 1; i <= overscan; i += 1) {
      if (first - i >= 0) prefetch.push(first - i)
      if (last + i < pages.length) prefetch.push(last + i)
    }
  }

  return { visible, prefetch, dominant }
}

/** Index of the first page whose bottom edge is at or after `offset`. */
function firstPageAtOrAfter(pages: readonly PageLayout[], offset: number): number {
  let low = 0
  let high = pages.length - 1
  let result = pages.length

  while (low <= high) {
    const mid = (low + high) >> 1
    const page = pages[mid] as PageLayout
    if (page.top + page.height >= offset) {
      result = mid
      high = mid - 1
    } else {
      low = mid + 1
    }
  }

  return Math.min(result, pages.length - 1)
}

/** Scroll offset that brings a page to the top of the viewport. */
export function scrollOffsetForPage(
  layout: DocumentLayout,
  page: number,
  align: 'start' | 'center' = 'start',
  viewportHeight = 0,
): number {
  const target = layout.pages.find((p) => p.page === page)
  if (!target) return 0
  if (align === 'start') return Math.max(0, target.top - 16)
  return Math.max(0, target.top - (viewportHeight - target.height) / 2)
}

/** Scale that fits a page's width to the container. */
export function fitWidthScale(
  pageSize: PageSize,
  containerWidth: number,
  padding = 16,
  rotation = 0,
): number {
  const total = ((pageSize.rotation ?? 0) + rotation) % 360
  const width = total === 90 || total === 270 ? pageSize.height : pageSize.width
  if (width <= 0) return 1
  return Math.max(0.1, (containerWidth - padding * 2) / width)
}

/** Scale that fits a whole page inside the container. */
export function fitPageScale(
  pageSize: PageSize,
  container: { width: number; height: number },
  padding = 16,
  rotation = 0,
): number {
  const total = ((pageSize.rotation ?? 0) + rotation) % 360
  const swapped = total === 90 || total === 270
  const width = swapped ? pageSize.height : pageSize.width
  const height = swapped ? pageSize.width : pageSize.height

  if (width <= 0 || height <= 0) return 1

  return Math.max(
    0.1,
    Math.min(
      (container.width - padding * 2) / width,
      (container.height - padding * 2) / height,
    ),
  )
}

/** Zoom steps the viewer cycles through. */
export const zoomSteps = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4] as const

export function nextZoom(current: number): number {
  return zoomSteps.find((step) => step > current + 0.001) ?? current
}

export function previousZoom(current: number): number {
  const lower = zoomSteps.filter((step) => step < current - 0.001)
  return lower[lower.length - 1] ?? current
}

/**
 * Keeps the point under the cursor fixed while zooming.
 *
 * Without this, zooming jumps to a different part of the document, which is
 * disorienting when a signer is trying to read a specific clause.
 */
export function anchoredScroll(
  previousScale: number,
  nextScale: number,
  scrollTop: number,
  pointerOffsetY: number,
): number {
  if (previousScale <= 0) return scrollTop
  const ratio = nextScale / previousScale
  return Math.max(0, (scrollTop + pointerOffsetY) * ratio - pointerOffsetY)
}
