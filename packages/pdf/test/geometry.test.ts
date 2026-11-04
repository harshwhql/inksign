import { describe, expect, it } from 'vitest'
import {
  FieldIndex,
  createViewport,
  cssPointToField,
  cssToField,
  fieldToCss,
  fieldToPdf,
  fitInside,
  hitTest,
  inches,
  normalizeRotation,
  overlaps,
  pageSizes,
  pdfToField,
  withScale,
} from '../src/geometry.js'
import type { FieldRect } from '@inksign/core'

const letter = pageSizes.letter
const rect = (over: Partial<FieldRect> = {}): FieldRect => ({
  page: 0,
  x: 100,
  y: 200,
  width: 160,
  height: 40,
  ...over,
})

describe('rotation normalization', () => {
  it('maps any angle onto a quarter turn', () => {
    expect(normalizeRotation(0)).toBe(0)
    expect(normalizeRotation(90)).toBe(90)
    expect(normalizeRotation(360)).toBe(0)
    expect(normalizeRotation(450)).toBe(90)
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(undefined)).toBe(0)
  })

  it('rounds an off-axis angle to the nearest quarter turn', () => {
    expect(normalizeRotation(88)).toBe(90)
    expect(normalizeRotation(100)).toBe(90)
  })
})

describe('viewport', () => {
  it('matches the page size at scale 1', () => {
    const viewport = createViewport(letter)
    expect(viewport.width).toBe(612)
    expect(viewport.height).toBe(792)
  })

  it('scales both dimensions', () => {
    const viewport = createViewport(letter, { scale: 2 })
    expect(viewport.width).toBe(1224)
    expect(viewport.height).toBe(1584)
  })

  it('swaps dimensions on a quarter turn', () => {
    expect(createViewport(letter, { rotation: 90 }).width).toBe(792)
    expect(createViewport(letter, { rotation: 90 }).height).toBe(612)
    expect(createViewport(letter, { rotation: 270 }).width).toBe(792)
  })

  it('keeps dimensions on a half turn', () => {
    const viewport = createViewport(letter, { rotation: 180 })
    expect(viewport.width).toBe(612)
    expect(viewport.height).toBe(792)
  })

  it('adds the page rotation to the viewer rotation', () => {
    const rotatedPage = { ...letter, rotation: 90 }
    // 90 from the page plus 90 from the viewer is a half turn.
    expect(createViewport(rotatedPage, { rotation: 90 }).rotation).toBe(180)
  })

  it('returns the same object when the scale is unchanged', () => {
    const viewport = createViewport(letter, { scale: 1.5 })
    expect(withScale(viewport, 1.5)).toBe(viewport)
    expect(withScale(viewport, 2).width).toBe(1224)
  })
})

describe('field to CSS', () => {
  it('is the identity at scale 1 without rotation', () => {
    const box = fieldToCss(rect(), createViewport(letter))
    expect(box).toEqual({ left: 100, top: 200, width: 160, height: 40 })
  })

  it('scales the box', () => {
    const box = fieldToCss(rect(), createViewport(letter, { scale: 2 }))
    expect(box).toEqual({ left: 200, top: 400, width: 320, height: 80 })
  })

  it('produces positive dimensions at every rotation', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const box = fieldToCss(rect(), createViewport(letter, { rotation }))
      expect(box.width).toBeGreaterThan(0)
      expect(box.height).toBeGreaterThan(0)
    }
  })

  it('swaps width and height on a quarter turn', () => {
    const box = fieldToCss(rect(), createViewport(letter, { rotation: 90 }))
    expect(box.width).toBeCloseTo(40)
    expect(box.height).toBeCloseTo(160)
  })

  it('keeps the box inside the rotated viewport', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const viewport = createViewport(letter, { rotation })
      const box = fieldToCss(rect(), viewport)
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.left + box.width).toBeLessThanOrEqual(viewport.width + 0.01)
      expect(box.top + box.height).toBeLessThanOrEqual(viewport.height + 0.01)
    }
  })

  it('places a top-left field at the top-right once turned a quarter clockwise', () => {
    const corner = rect({ x: 0, y: 0, width: 50, height: 20 })
    const viewport = createViewport(letter, { rotation: 90 })
    const box = fieldToCss(corner, viewport)

    // The original top-left corner ends up against the right edge.
    expect(box.left + box.width).toBeCloseTo(viewport.width)
    expect(box.top).toBeCloseTo(0)
  })
})

describe('CSS to field', () => {
  it('round-trips through every rotation and scale', () => {
    const original = rect()

    for (const rotation of [0, 90, 180, 270]) {
      for (const scale of [0.5, 1, 1.75, 3]) {
        const viewport = createViewport(letter, { rotation, scale })
        const box = fieldToCss(original, viewport)
        const back = cssToField(box, 0, viewport)

        expect(back.x).toBeCloseTo(original.x, 6)
        expect(back.y).toBeCloseTo(original.y, 6)
        expect(back.width).toBeCloseTo(original.width, 6)
        expect(back.height).toBeCloseTo(original.height, 6)
      }
    }
  })

  it('round-trips a click point', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const viewport = createViewport(letter, { rotation, scale: 1.5 })
      const field = rect()
      const box = fieldToCss(field, viewport)
      const point = cssPointToField({ x: box.left + 1, y: box.top + 1 }, viewport)

      expect(hitTest(point, field)).toBe(true)
    }
  })
})

describe('field to PDF space', () => {
  it('flips the vertical axis', () => {
    // A field 200 points from the top of a 792 point page, 40 points tall,
    // has its bottom edge at 792 - 200 - 40 = 552.
    const out = fieldToPdf(rect(), letter)
    expect(out).toEqual({ x: 100, y: 552, width: 160, height: 40 })
  })

  it('puts a field at the top of the page near the page height', () => {
    const out = fieldToPdf(rect({ x: 0, y: 0, height: 40 }), letter)
    expect(out.y).toBe(752)
  })

  it('round-trips through pdfToField', () => {
    const original = rect()
    const back = pdfToField(fieldToPdf(original, letter), letter, 0)
    expect(back).toEqual(original)
  })
})

describe('hit testing', () => {
  it('includes the edges', () => {
    const field = rect()
    expect(hitTest({ x: 100, y: 200 }, field)).toBe(true)
    expect(hitTest({ x: 260, y: 240 }, field)).toBe(true)
  })

  it('excludes points outside', () => {
    const field = rect()
    expect(hitTest({ x: 99, y: 200 }, field)).toBe(false)
    expect(hitTest({ x: 100, y: 241 }, field)).toBe(false)
  })
})

describe('overlap detection', () => {
  it('detects overlapping fields on the same page', () => {
    expect(overlaps(rect(), rect({ x: 150, y: 210 }))).toBe(true)
  })

  it('ignores fields on different pages', () => {
    expect(overlaps(rect(), rect({ page: 1 }))).toBe(false)
  })

  it('treats touching edges as not overlapping', () => {
    expect(overlaps(rect(), rect({ x: 260 }))).toBe(false)
  })
})

describe('field index', () => {
  it('finds a field at a point', () => {
    const index = new FieldIndex()
    index.insert('a', rect())
    index.insert('b', rect({ x: 400, y: 600 }))

    expect(index.hit(0, { x: 120, y: 210 })).toBe('a')
    expect(index.hit(0, { x: 420, y: 610 })).toBe('b')
    expect(index.hit(0, { x: 10, y: 10 })).toBeUndefined()
  })

  it('returns the last inserted field when fields stack', () => {
    const index = new FieldIndex()
    index.insert('under', rect())
    index.insert('over', rect())

    expect(index.hit(0, { x: 120, y: 210 })).toBe('over')
    expect(index.query(0, { x: 120, y: 210 })).toEqual(['under', 'over'])
  })

  it('keeps pages separate', () => {
    const index = new FieldIndex()
    index.insert('p0', rect({ page: 0 }))
    index.insert('p1', rect({ page: 1 }))

    expect(index.hit(0, { x: 120, y: 210 })).toBe('p0')
    expect(index.hit(1, { x: 120, y: 210 })).toBe('p1')
  })

  it('finds a field that spans several grid cells', () => {
    const index = new FieldIndex(20)
    index.insert('wide', rect({ x: 0, y: 0, width: 300, height: 100 }))

    expect(index.hit(0, { x: 5, y: 5 })).toBe('wide')
    expect(index.hit(0, { x: 290, y: 95 })).toBe('wide')
  })

  it('handles a realistic field count', () => {
    const index = new FieldIndex()
    for (let i = 0; i < 500; i += 1) {
      index.insert(`f${i}`, rect({ x: (i % 20) * 30, y: Math.floor(i / 20) * 35 }))
    }
    expect(index.size).toBe(500)
    expect(index.hit(0, { x: 5, y: 5 })).toBe('f0')
  })

  it('clears', () => {
    const index = new FieldIndex()
    index.insert('a', rect())
    index.clear()
    expect(index.size).toBe(0)
    expect(index.hit(0, { x: 120, y: 210 })).toBeUndefined()
  })
})

describe('fitInside', () => {
  it('centres content and preserves its aspect ratio', () => {
    const box = fitInside({ width: 200, height: 50 }, rect({ width: 100, height: 100 }))
    // 4:1 content in a square box fills the width.
    expect(box.width).toBeCloseTo(100)
    expect(box.height).toBeCloseTo(25)
    expect(box.top).toBeCloseTo(200 + 37.5)
  })

  it('honours padding', () => {
    const box = fitInside({ width: 100, height: 100 }, rect({ width: 100, height: 100 }), 10)
    expect(box.width).toBeCloseTo(80)
  })

  it('handles zero-sized content without dividing by zero', () => {
    const box = fitInside({ width: 0, height: 0 }, rect())
    expect(box.width).toBe(0)
    expect(Number.isFinite(box.left)).toBe(true)
  })
})

describe('unit helpers', () => {
  it('converts inches to points', () => {
    expect(inches(1)).toBe(72)
    expect(inches(0.5)).toBe(36)
  })

  it('exposes standard page sizes', () => {
    expect(pageSizes.letter).toEqual({ width: 612, height: 792 })
    expect(pageSizes.a4.width).toBeCloseTo(595.28)
  })
})
