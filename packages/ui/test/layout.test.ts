import type { PageSize } from '@inksign/core'
import { describe, expect, it } from 'vitest'
import {
  anchoredScroll,
  computeLayout,
  fitPageScale,
  fitWidthScale,
  nextZoom,
  previousZoom,
  scrollOffsetForPage,
  visibleRange,
} from '../src/viewer/layout.js'

const letter: PageSize = { width: 612, height: 792 }
const pages = (count: number, size: PageSize = letter): PageSize[] =>
  Array.from({ length: count }, () => size)

describe('layout', () => {
  it('stacks pages with gaps and padding', () => {
    const layout = computeLayout({
      pageSizes: pages(3),
      scale: 1,
      containerWidth: 800,
      gap: 16,
      padding: 16,
    })

    expect(layout.pages[0]?.top).toBe(16)
    expect(layout.pages[1]?.top).toBe(16 + 792 + 16)
    expect(layout.pages[2]?.top).toBe(16 + (792 + 16) * 2)
  })

  it('computes a total height with padding at both ends and no trailing gap', () => {
    const layout = computeLayout({
      pageSizes: pages(2),
      scale: 1,
      containerWidth: 800,
      gap: 16,
      padding: 16,
    })

    // 16 + 792 + 16 + 792 + 16
    expect(layout.totalHeight).toBe(1632)
  })

  it('centres a page narrower than the container', () => {
    const layout = computeLayout({ pageSizes: pages(1), scale: 1, containerWidth: 1000 })
    expect(layout.pages[0]?.left).toBe((1000 - 612) / 2)
  })

  it('clamps the offset to the padding when the page is wider than the container', () => {
    const layout = computeLayout({
      pageSizes: pages(1),
      scale: 2,
      containerWidth: 400,
      padding: 16,
    })
    expect(layout.pages[0]?.left).toBe(16)
  })

  it('scales page dimensions', () => {
    const layout = computeLayout({ pageSizes: pages(1), scale: 2, containerWidth: 2000 })
    expect(layout.pages[0]?.width).toBe(1224)
    expect(layout.pages[0]?.height).toBe(1584)
  })

  it('swaps dimensions for a rotated page', () => {
    const layout = computeLayout({
      pageSizes: [{ ...letter, rotation: 90 }],
      scale: 1,
      containerWidth: 1000,
    })
    expect(layout.pages[0]?.width).toBe(792)
    expect(layout.pages[0]?.height).toBe(612)
  })

  it('adds the viewer rotation to the page rotation', () => {
    const layout = computeLayout({
      pageSizes: [{ ...letter, rotation: 90 }],
      scale: 1,
      containerWidth: 1000,
      rotation: 90,
    })
    // 180 total, so dimensions are back to portrait.
    expect(layout.pages[0]?.width).toBe(612)
  })

  it('handles mixed page sizes', () => {
    const layout = computeLayout({
      pageSizes: [letter, { width: 1224, height: 792 }],
      scale: 1,
      containerWidth: 800,
      padding: 0,
    })
    expect(layout.contentWidth).toBe(1224)
  })

  it('handles an empty document', () => {
    const layout = computeLayout({ pageSizes: [], scale: 1, containerWidth: 800, padding: 16 })
    expect(layout.pages).toEqual([])
    expect(layout.totalHeight).toBe(0)
  })
})

describe('visible range', () => {
  const layout = computeLayout({
    pageSizes: pages(100),
    scale: 1,
    containerWidth: 800,
    gap: 16,
    padding: 16,
  })

  it('finds the first page at the top of the document', () => {
    const range = visibleRange(layout, 0, 900)
    expect(range.visible).toContain(0)
    expect(range.visible).toContain(1)
    // Nowhere near page 50.
    expect(range.visible).not.toContain(50)
  })

  it('finds pages deep in a long document', () => {
    const target = layout.pages[60]?.top ?? 0
    const range = visibleRange(layout, target, 800)
    expect(range.visible).toContain(60)
  })

  it('mounts only a handful of pages out of a hundred', () => {
    const range = visibleRange(layout, 20_000, 800)
    expect(range.visible.length).toBeLessThanOrEqual(3)
  })

  it('names the dominant page for a page indicator', () => {
    const page = layout.pages[10]
    const range = visibleRange(layout, (page?.top ?? 0) + 50, 800)
    expect(range.dominant).toBe(10)
  })

  it('prefetches neighbours on both sides', () => {
    const target = layout.pages[10]?.top ?? 0
    const range = visibleRange(layout, target, 400, 1)

    expect(range.prefetch).toContain(9)
    expect(range.prefetch.some((p) => p > 10)).toBe(true)
  })

  it('does not prefetch before the first page', () => {
    const range = visibleRange(layout, 0, 400, 2)
    expect(range.prefetch.every((p) => p >= 0)).toBe(true)
  })

  it('does not prefetch past the last page', () => {
    const range = visibleRange(layout, layout.totalHeight - 400, 400, 2)
    expect(range.prefetch.every((p) => p < 100)).toBe(true)
  })

  it('handles an empty document', () => {
    const empty = computeLayout({ pageSizes: [], scale: 1, containerWidth: 800 })
    const range = visibleRange(empty, 0, 800)
    expect(range.visible).toEqual([])
    expect(range.dominant).toBeUndefined()
  })

  it('agrees with a linear scan', () => {
    // The binary search is an optimization, so it must match the obvious
    // implementation it replaced.
    for (const scrollTop of [0, 500, 5000, 25_000, 60_000]) {
      const height = 700
      const linear = layout.pages
        .filter((p) => p.top + p.height >= scrollTop && p.top <= scrollTop + height)
        .map((p) => p.page)

      expect(visibleRange(layout, scrollTop, height).visible).toEqual(linear)
    }
  })
})

describe('scrolling to a page', () => {
  const layout = computeLayout({ pageSizes: pages(10), scale: 1, containerWidth: 800 })

  it('aligns a page to the top', () => {
    const offset = scrollOffsetForPage(layout, 3, 'start')
    expect(offset).toBeCloseTo((layout.pages[3]?.top ?? 0) - 16)
  })

  it('centres a page in the viewport', () => {
    const offset = scrollOffsetForPage(layout, 3, 'center', 1000)
    expect(offset).toBeCloseTo((layout.pages[3]?.top ?? 0) - (1000 - 792) / 2)
  })

  it('never returns a negative offset', () => {
    expect(scrollOffsetForPage(layout, 0, 'center', 2000)).toBe(0)
  })

  it('returns zero for an unknown page', () => {
    expect(scrollOffsetForPage(layout, 99)).toBe(0)
  })
})

describe('fit scales', () => {
  it('fits a page to the container width', () => {
    const scale = fitWidthScale(letter, 1000, 16)
    expect(scale).toBeCloseTo((1000 - 32) / 612)
  })

  it('fits a whole page inside the container', () => {
    const scale = fitPageScale(letter, { width: 1000, height: 600 }, 16)
    // Height is the binding constraint.
    expect(scale).toBeCloseTo((600 - 32) / 792)
  })

  it('accounts for rotation when fitting', () => {
    const upright = fitWidthScale(letter, 1000)
    const turned = fitWidthScale(letter, 1000, 16, 90)
    expect(turned).toBeLessThan(upright)
  })

  it('never returns zero or a negative scale', () => {
    expect(fitWidthScale(letter, 0)).toBeGreaterThan(0)
    expect(fitPageScale({ width: 0, height: 0 }, { width: 100, height: 100 })).toBeGreaterThan(0)
  })
})

describe('zoom', () => {
  it('steps up and down through the preset scales', () => {
    expect(nextZoom(1)).toBe(1.25)
    expect(previousZoom(1)).toBe(0.8)
  })

  it('stops at the ends', () => {
    expect(nextZoom(4)).toBe(4)
    expect(previousZoom(0.5)).toBe(0.5)
  })

  it('handles a scale between steps', () => {
    expect(nextZoom(1.1)).toBe(1.25)
    expect(previousZoom(1.1)).toBe(1)
  })

  it('keeps the point under the cursor fixed when zooming', () => {
    // A point 300 pixels down the viewport, with the document scrolled 1000.
    // Its document offset is 1300; at 2x it should be 2600, so the scroll has
    // to become 2600 - 300 = 2300.
    expect(anchoredScroll(1, 2, 1000, 300)).toBe(2300)
  })

  it('never scrolls above the top', () => {
    expect(anchoredScroll(2, 0.5, 100, 50)).toBeGreaterThanOrEqual(0)
  })

  it('returns the scroll unchanged for a zero previous scale', () => {
    expect(anchoredScroll(0, 2, 500, 100)).toBe(500)
  })
})
