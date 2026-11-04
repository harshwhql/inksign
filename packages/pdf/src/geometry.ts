import type { FieldRect, PageSize } from '@inksign/core'

/**
 * Coordinate conversion between the three spaces a signing UI has to reconcile.
 *
 * 1. PDF user space, which PDF itself uses: origin at the bottom-left of the
 *    page, y increasing upwards, measured in points (1/72 inch).
 * 2. Field space, which InkSign stores placements in: origin at the top-left,
 *    y increasing downwards, still in points. Top-left matches how people
 *    describe a page ("two inches from the top"), and it matches CSS, so the
 *    common case needs no flip.
 * 3. CSS pixel space, what the browser lays out: top-left origin, scaled by
 *    the zoom level and the device pixel ratio, and affected by page rotation.
 *
 * Keeping placements in points rather than pixels is deliberate. A field
 * recorded at a zoom level would drift when the user zooms, and would land in
 * the wrong place on a different screen. Points are absolute, so a placement
 * made on a phone stamps identically on a server.
 */

export type Rotation = 0 | 90 | 180 | 270

/** Normalizes any degree value to one of the four quarter turns. */
export function normalizeRotation(degrees: number | undefined): Rotation {
  const value = (((Math.round((degrees ?? 0) / 90) * 90) % 360) + 360) % 360
  return value as Rotation
}

export interface Viewport {
  /** Page size in points, before rotation. */
  readonly page: PageSize
  /** Display scale: 1 means 1 point to 1 CSS pixel. */
  readonly scale: number
  readonly rotation: Rotation
  /** Width in CSS pixels, after rotation and scale. */
  readonly width: number
  /** Height in CSS pixels, after rotation and scale. */
  readonly height: number
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/**
 * Builds a viewport for a page.
 *
 * `scale` is the zoom the user sees. The device pixel ratio is deliberately
 * not folded in here: it belongs to the canvas backing store, not to layout,
 * and mixing the two is what produces blurry pages and misplaced fields.
 */
export function createViewport(
  page: PageSize,
  options: { scale?: number; rotation?: number } = {},
): Viewport {
  const scale = options.scale ?? 1
  // A page can carry its own rotation, and the viewer can add more on top.
  const rotation = normalizeRotation((page.rotation ?? 0) + (options.rotation ?? 0))
  const swapped = rotation === 90 || rotation === 270

  return {
    page,
    scale,
    rotation,
    width: (swapped ? page.height : page.width) * scale,
    height: (swapped ? page.width : page.height) * scale,
  }
}

/**
 * Returns the viewport at a different scale, keeping its rotation. Returns the
 * same object when the scale is unchanged, so identity checks still hold.
 */
export function withScale(viewport: Viewport, scale: number): Viewport {
  if (scale === viewport.scale) return viewport

  const swapped = viewport.rotation === 90 || viewport.rotation === 270
  return {
    ...viewport,
    scale,
    width: (swapped ? viewport.page.height : viewport.page.width) * scale,
    height: (swapped ? viewport.page.width : viewport.page.height) * scale,
  }
}

/**
 * Rotates a top-left-origin point from unrotated page space into the rotated
 * display space, in points.
 */
function rotatePoint(x: number, y: number, page: PageSize, rotation: Rotation): Point {
  switch (rotation) {
    case 0:
      return { x, y }
    case 90:
      // Quarter turn clockwise: the original top-left moves to the top-right.
      return { x: page.height - y, y: x }
    case 180:
      return { x: page.width - x, y: page.height - y }
    case 270:
      return { x: y, y: page.width - x }
  }
}

/** Inverse of `rotatePoint`. */
function unrotatePoint(x: number, y: number, page: PageSize, rotation: Rotation): Point {
  switch (rotation) {
    case 0:
      return { x, y }
    case 90:
      return { x: y, y: page.height - x }
    case 180:
      return { x: page.width - x, y: page.height - y }
    case 270:
      return { x: page.width - y, y: x }
  }
}

/**
 * Converts a stored field rect into a CSS box for absolute positioning.
 *
 * Both corners are transformed and then normalized, so a rotation that flips
 * the corner order still produces a box with positive dimensions rather than a
 * negative width that silently renders as nothing.
 */
export function fieldToCss(rect: FieldRect, viewport: Viewport): Box {
  const { page, rotation, scale } = viewport

  const a = rotatePoint(rect.x, rect.y, page, rotation)
  const b = rotatePoint(rect.x + rect.width, rect.y + rect.height, page, rotation)

  const left = Math.min(a.x, b.x) * scale
  const top = Math.min(a.y, b.y) * scale
  const width = Math.abs(b.x - a.x) * scale
  const height = Math.abs(b.y - a.y) * scale

  return { left, top, width, height }
}

/** Converts a CSS box back into a stored field rect, for a drag-and-drop editor. */
export function cssToField(box: Box, page: number, viewport: Viewport): FieldRect {
  const { page: size, rotation, scale } = viewport

  const a = unrotatePoint(box.left / scale, box.top / scale, size, rotation)
  const b = unrotatePoint(
    (box.left + box.width) / scale,
    (box.top + box.height) / scale,
    size,
    rotation,
  )

  return {
    page,
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  }
}

/** Converts a CSS point, such as a click, into field space. */
export function cssPointToField(point: Point, viewport: Viewport): Point {
  return unrotatePoint(
    point.x / viewport.scale,
    point.y / viewport.scale,
    viewport.page,
    viewport.rotation,
  )
}

/**
 * Converts a field rect into PDF user space, for stamping with a PDF writer.
 *
 * This is where the vertical flip happens: PDF measures y from the bottom, so
 * a field 100 points from the top of an 800 point page is drawn at y=700 minus
 * its own height.
 */
export function fieldToPdf(
  rect: FieldRect,
  page: PageSize,
): { x: number; y: number; width: number; height: number } {
  return {
    x: rect.x,
    y: page.height - rect.y - rect.height,
    width: rect.width,
    height: rect.height,
  }
}

/** Converts a PDF user space rect into field space. */
export function pdfToField(
  rect: { x: number; y: number; width: number; height: number },
  page: PageSize,
  pageIndex: number,
): FieldRect {
  return {
    page: pageIndex,
    x: rect.x,
    y: page.height - rect.y - rect.height,
    width: rect.width,
    height: rect.height,
  }
}

/** True when a field-space point falls inside a field rect. */
export function hitTest(point: Point, rect: FieldRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

/** True when two rects overlap, used to warn about stacked fields. */
export function overlaps(a: FieldRect, b: FieldRect): boolean {
  if (a.page !== b.page) return false
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/**
 * A spatial index for hit-testing many fields.
 *
 * A linear scan is fine for a handful of fields but not for a long contract
 * with hundreds, where every pointer move would walk the whole list. Bucketing
 * by a fixed grid turns that into a lookup of one cell, which is what makes
 * hover and drag stay smooth as a document grows.
 */
export class FieldIndex {
  private readonly cells = new Map<string, FieldRect[]>()
  private readonly ids = new Map<FieldRect, string>()

  constructor(private readonly cellSize = 72) {}

  insert(id: string, rect: FieldRect): void {
    this.ids.set(rect, id)
    for (const key of this.keysFor(rect)) {
      const bucket = this.cells.get(key)
      if (bucket) bucket.push(rect)
      else this.cells.set(key, [rect])
    }
  }

  /** IDs of every field containing the point, topmost insertion last. */
  query(page: number, point: Point): readonly string[] {
    const key = this.key(page, point.x, point.y)
    const bucket = this.cells.get(key)
    if (!bucket) return []

    const out: string[] = []
    for (const rect of bucket) {
      if (rect.page !== page) continue
      if (!hitTest(point, rect)) continue
      const id = this.ids.get(rect)
      if (id !== undefined) out.push(id)
    }
    return out
  }

  /** The topmost field at a point, or `undefined`. */
  hit(page: number, point: Point): string | undefined {
    const matches = this.query(page, point)
    return matches[matches.length - 1]
  }

  clear(): void {
    this.cells.clear()
    this.ids.clear()
  }

  get size(): number {
    return this.ids.size
  }

  private *keysFor(rect: FieldRect): Generator<string> {
    const x0 = Math.floor(rect.x / this.cellSize)
    const y0 = Math.floor(rect.y / this.cellSize)
    const x1 = Math.floor((rect.x + rect.width) / this.cellSize)
    const y1 = Math.floor((rect.y + rect.height) / this.cellSize)

    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        yield `${rect.page}:${cx}:${cy}`
      }
    }
  }

  private key(page: number, x: number, y: number): string {
    return `${page}:${Math.floor(x / this.cellSize)}:${Math.floor(y / this.cellSize)}`
  }
}

/**
 * Fits a box inside a rect while preserving its aspect ratio, used to place a
 * captured signature inside its field without distorting it.
 */
export function fitInside(
  content: { width: number; height: number },
  target: FieldRect,
  padding = 0,
): Box {
  const availableWidth = Math.max(0, target.width - padding * 2)
  const availableHeight = Math.max(0, target.height - padding * 2)

  if (content.width <= 0 || content.height <= 0) {
    return { left: target.x + padding, top: target.y + padding, width: 0, height: 0 }
  }

  const scale = Math.min(availableWidth / content.width, availableHeight / content.height)
  const width = content.width * scale
  const height = content.height * scale

  return {
    left: target.x + (target.width - width) / 2,
    top: target.y + (target.height - height) / 2,
    width,
    height,
  }
}

/** Points per inch, the PDF unit. */
export const POINTS_PER_INCH = 72

export const inches = (value: number): number => value * POINTS_PER_INCH
export const millimeters = (value: number): number => (value / 25.4) * POINTS_PER_INCH

/** Common page sizes in points. */
export const pageSizes = {
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
  tabloid: { width: 792, height: 1224 },
  a4: { width: 595.28, height: 841.89 },
  a3: { width: 841.89, height: 1190.55 },
  a5: { width: 419.53, height: 595.28 },
} as const satisfies Record<string, PageSize>
