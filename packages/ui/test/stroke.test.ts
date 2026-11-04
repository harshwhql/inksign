import { describe, expect, it } from 'vitest'
import {
  getStrokeOutline,
  getStrokePath,
  normalizeStrokes,
  outlineToPath,
  strokesBounds,
  type InputPoint,
} from '../src/signature/stroke.js'

/** A straight horizontal stroke with constant spacing. */
function line(count = 20, spacing = 5): InputPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    x: 10 + i * spacing,
    y: 50,
    pressure: 0.5,
    t: i * 16,
  }))
}

describe('stroke outline', () => {
  it('returns nothing for no input', () => {
    expect(getStrokeOutline([])).toEqual([])
  })

  it('renders a single point as a closed dot', () => {
    const outline = getStrokeOutline([{ x: 50, y: 50, pressure: 0.5 }])
    expect(outline.length).toBeGreaterThan(8)

    // Every point sits on a circle around the input point.
    for (const [x, y] of outline) {
      expect(Math.hypot(x - 50, y - 50)).toBeGreaterThan(0)
    }
  })

  it('produces a closed outline for a line', () => {
    const outline = getStrokeOutline(line(), { last: true })
    // Two sides plus two caps.
    expect(outline.length).toBeGreaterThan(line().length * 2)
  })

  it('straddles the input path on both sides', () => {
    const outline = getStrokeOutline(line(), { last: true, thinning: 0 })

    const above = outline.filter(([, y]) => y < 50)
    const below = outline.filter(([, y]) => y > 50)
    expect(above.length).toBeGreaterThan(0)
    expect(below.length).toBeGreaterThan(0)
  })

  it('scales width with the size option', () => {
    const thin = getStrokeOutline(line(), { size: 4, thinning: 0, last: true })
    const thick = getStrokeOutline(line(), { size: 20, thinning: 0, last: true })

    const spread = (outline: readonly (readonly [number, number])[]): number => {
      const ys = outline.map(([, y]) => y)
      return Math.max(...ys) - Math.min(...ys)
    }

    expect(spread(thick)).toBeGreaterThan(spread(thin))
  })

  it('produces a uniform width when thinning is zero', () => {
    const outline = getStrokeOutline(line(), { size: 10, thinning: 0, last: true })
    const ys = outline.map(([, y]) => y)
    const spread = Math.max(...ys) - Math.min(...ys)

    // A 10 pixel stroke spans about 10 pixels, allowing for the round caps.
    expect(spread).toBeGreaterThan(8)
    expect(spread).toBeLessThan(13)
  })

  it('varies width with real pressure data', () => {
    const varying: InputPoint[] = line(20).map((point, i) => ({
      ...point,
      pressure: 0.1 + (i / 19) * 0.85,
    }))

    const outline = getStrokeOutline(varying, { size: 12, thinning: 0.8, last: true })

    // Width at the light end should be clearly less than at the heavy end.
    const widthNear = widthAt(outline, 15)
    const widthFar = widthAt(outline, 100)
    expect(widthFar).toBeGreaterThan(widthNear)
  })

  it('thins a fast stroke when simulating pressure', () => {
    const slow = line(20, 2).map((p) => ({ ...p, pressure: 0.5 }))
    const fast = line(20, 30).map((p) => ({ ...p, pressure: 0.5 }))

    const slowOutline = getStrokeOutline(slow, { size: 12, simulatePressure: true, last: true })
    const fastOutline = getStrokeOutline(fast, { size: 12, simulatePressure: true, last: true })

    expect(widthAt(fastOutline, 200)).toBeLessThan(widthAt(slowOutline, 30))
  })

  it('omits the end cap until the stroke is finished', () => {
    const open = getStrokeOutline(line(), { last: false })
    const closed = getStrokeOutline(line(), { last: true })
    expect(closed.length).toBeGreaterThan(open.length)
  })

  it('tapers the start when asked', () => {
    const tapered = getStrokeOutline(line(30, 5), {
      size: 14,
      thinning: 0,
      taperStart: 40,
      last: true,
    })

    // Near the beginning the stroke is narrower than further along.
    expect(widthAt(tapered, 14)).toBeLessThan(widthAt(tapered, 120))
  })

  it('handles duplicate points without producing NaN', () => {
    const outline = getStrokeOutline(
      [
        { x: 10, y: 10, pressure: 0.5 },
        { x: 10, y: 10, pressure: 0.5 },
        { x: 10, y: 10, pressure: 0.5 },
      ],
      { last: true },
    )

    for (const [x, y] of outline) {
      expect(Number.isFinite(x)).toBe(true)
      expect(Number.isFinite(y)).toBe(true)
    }
  })

  it('handles a sharp reversal without producing NaN', () => {
    const outline = getStrokeOutline(
      [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 50, y: 0, pressure: 0.5 },
        { x: 0, y: 0, pressure: 0.5 },
      ],
      { last: true },
    )

    for (const [x, y] of outline) {
      expect(Number.isFinite(x)).toBe(true)
      expect(Number.isFinite(y)).toBe(true)
    }
  })

  it('copes with missing pressure values', () => {
    const outline = getStrokeOutline([
      { x: 0, y: 0 },
      { x: 20, y: 10 },
      { x: 40, y: 0 },
    ], { last: true })

    expect(outline.length).toBeGreaterThan(0)
  })

  it('stays finite over a long stroke', () => {
    const long = Array.from({ length: 2000 }, (_, i) => ({
      x: i * 0.7,
      y: 50 + Math.sin(i / 8) * 25,
      pressure: 0.5,
    }))
    const outline = getStrokeOutline(long, { last: true })

    expect(outline.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true)
  })
})

/** Vertical extent of the outline near a given x, as a width proxy. */
function widthAt(outline: readonly (readonly [number, number])[], x: number, window = 8): number {
  const nearby = outline.filter(([px]) => Math.abs(px - x) < window)
  if (nearby.length < 2) return 0
  const ys = nearby.map(([, y]) => y)
  return Math.max(...ys) - Math.min(...ys)
}

describe('path generation', () => {
  it('returns an empty string for an empty outline', () => {
    expect(outlineToPath([])).toBe('')
  })

  it('starts with a move and closes the path', () => {
    const path = getStrokePath(line(), { last: true })
    expect(path.startsWith('M ')).toBe(true)
    expect(path.endsWith('Z')).toBe(true)
  })

  it('uses quadratic curves when smoothing is on', () => {
    expect(getStrokePath(line(), { last: true, smoothing: 0.5 })).toContain('Q ')
  })

  it('uses straight lines when smoothing is off', () => {
    const path = getStrokePath(line(), { last: true, smoothing: 0 })
    expect(path).toContain('L ')
    expect(path).not.toContain('Q ')
  })

  it('emits no NaN in the path data', () => {
    const path = getStrokePath(line(), { last: true })
    expect(path).not.toContain('NaN')
    expect(path).not.toContain('Infinity')
  })

  it('rounds coordinates to keep the path compact', () => {
    const path = getStrokePath([{ x: 1.23456789, y: 2.3456789 }], { last: true })
    // At most two decimal places.
    expect(path).not.toMatch(/\d\.\d{3}/u)
  })
})

describe('bounds', () => {
  it('returns undefined for no strokes', () => {
    expect(strokesBounds([])).toBeUndefined()
    expect(strokesBounds([[]])).toBeUndefined()
  })

  it('covers every point across strokes', () => {
    const bounds = strokesBounds([
      [
        { x: 10, y: 20 },
        { x: 30, y: 40 },
      ],
      [{ x: 5, y: 60 }],
    ])

    expect(bounds).toEqual({ x: 5, y: 20, width: 25, height: 40 })
  })

  it('applies padding', () => {
    const bounds = strokesBounds([[{ x: 10, y: 10 }]], 5)
    expect(bounds).toEqual({ x: 5, y: 5, width: 10, height: 10 })
  })
})

describe('normalizing strokes', () => {
  it('scales a small mark up to fill the constraining dimension', () => {
    // 20 by 10 of ink, so 2:1, inside a 3:1 box. Height is what binds, and
    // the width must not be stretched past it.
    const tiny = [
      [
        { x: 100, y: 100 },
        { x: 120, y: 110 },
      ],
    ]
    const { strokes } = normalizeStrokes(tiny, { width: 300, height: 100 }, 4)

    const bounds = strokesBounds(strokes)
    // Fills the available height after padding.
    expect(bounds?.height).toBeCloseTo(92, 0)
    // And the width follows from the preserved 2:1 ratio.
    expect(bounds?.width).toBeCloseTo(184, 0)
  })

  it('fills the width when width is the constraining dimension', () => {
    // 10 by 20 of ink, so 1:2, inside a 3:1 box. Width binds here.
    const tall = [
      [
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ],
    ]
    const { strokes } = normalizeStrokes(tall, { width: 60, height: 400 }, 0)

    const bounds = strokesBounds(strokes)
    expect(bounds?.width).toBeCloseTo(60, 0)
    expect(bounds?.height).toBeCloseTo(120, 0)
  })

  it('preserves the aspect ratio', () => {
    const wide = [
      [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 50 },
      ],
    ]
    const { strokes } = normalizeStrokes(wide, { width: 100, height: 100 }, 0)
    const bounds = strokesBounds(strokes)

    // 4:1 input stays 4:1.
    expect((bounds?.width ?? 0) / (bounds?.height ?? 1)).toBeCloseTo(4, 1)
  })

  it('centres the mark in the box', () => {
    const square = [
      [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
      ],
    ]
    const { strokes } = normalizeStrokes(square, { width: 200, height: 100 }, 0)
    const bounds = strokesBounds(strokes)

    const leftGap = bounds?.x ?? 0
    const rightGap = 200 - ((bounds?.x ?? 0) + (bounds?.width ?? 0))
    expect(leftGap).toBeCloseTo(rightGap, 1)
  })

  it('leaves a degenerate stroke alone rather than dividing by zero', () => {
    const point = [[{ x: 10, y: 10 }]]
    const { strokes, width } = normalizeStrokes(point, { width: 200, height: 100 })

    expect(strokes).toBe(point)
    expect(width).toBe(200)
  })
})
