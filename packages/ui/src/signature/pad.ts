import type { InkSignature } from '@inksign/core'
import {
  getStrokeOutline,
  getStrokePath,
  normalizeStrokes,
  outlineToPath,
  strokesBounds,
  type InputPoint,
  type StrokeOptions,
} from './stroke.js'

/**
 * Signature pad controller.
 *
 * Framework-agnostic on purpose: it owns a canvas and a pointer listener and
 * exposes imperative methods, so the React, Vue and Svelte adapters are each
 * a thin binding over the same behaviour rather than three reimplementations
 * of drawing. It is also usable directly from plain JavaScript.
 *
 * The rendering strategy is split in two. While a stroke is in progress only
 * that stroke is redrawn, which keeps input latency flat regardless of how
 * much has already been drawn. Completed strokes are composited once, when the
 * pointer lifts. Redrawing everything on every pointer move is what makes
 * naive signature pads lag after a few seconds of writing.
 */

export interface SignaturePadOptions extends StrokeOptions {
  /** Ink colour. Any CSS colour. */
  color?: string
  /** Canvas background. Transparent by default, which suits stamping. */
  background?: string
  /** Caps the backing store resolution. Defaults to 2. */
  maxPixelRatio?: number
  /** Called whenever the drawn content changes. */
  onChange?: (state: { isEmpty: boolean; strokeCount: number }) => void
  /** Called when a stroke begins. */
  onStrokeStart?: () => void
  /** Called when a stroke ends. */
  onStrokeEnd?: () => void
}

export class SignaturePad {
  private canvas: HTMLCanvasElement
  private context: CanvasRenderingContext2D
  private options: SignaturePadOptions

  private strokes: InputPoint[][] = []
  private current: InputPoint[] = []
  private drawing = false
  private pointerId: number | undefined

  /** Undone strokes, kept so redo can put them back. */
  private redoStack: InputPoint[][] = []

  private pixelRatio = 1
  private frame: number | undefined
  private disposed = false

  private readonly listeners: (() => void)[] = []

  constructor(canvas: HTMLCanvasElement, options: SignaturePadOptions = {}) {
    this.canvas = canvas
    this.options = options

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('SignaturePad needs a canvas with a 2D context')
    }
    this.context = context

    this.resize()
    this.attach()
  }

  // State

  get isEmpty(): boolean {
    return this.strokes.length === 0 && this.current.length === 0
  }

  get strokeCount(): number {
    return this.strokes.length
  }

  get canUndo(): boolean {
    return this.strokes.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  // Commands

  /** Applies new options and repaints. */
  setOptions(options: Partial<SignaturePadOptions>): void {
    this.options = { ...this.options, ...options }
    this.repaint()
  }

  clear(): void {
    this.strokes = []
    this.current = []
    this.redoStack = []
    this.repaint()
    this.emitChange()
  }

  undo(): void {
    const removed = this.strokes.pop()
    if (!removed) return
    this.redoStack.push(removed)
    this.repaint()
    this.emitChange()
  }

  redo(): void {
    const restored = this.redoStack.pop()
    if (!restored) return
    this.strokes.push(restored)
    this.repaint()
    this.emitChange()
  }

  /**
   * Matches the backing store to the element's displayed size.
   *
   * Call this when the element resizes. A canvas whose backing store does not
   * match its CSS size renders blurry, and the pointer coordinates stop
   * lining up with the ink.
   */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = Math.min(
      (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1,
      this.options.maxPixelRatio ?? 2,
    )

    const width = Math.max(1, Math.round((rect.width || this.canvas.width) * dpr))
    const height = Math.max(1, Math.round((rect.height || this.canvas.height) * dpr))

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }

    this.pixelRatio = dpr
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.repaint()
  }

  /** Removes listeners and cancels pending frames. */
  dispose(): void {
    this.disposed = true
    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame)
      this.frame = undefined
    }
    for (const off of this.listeners) off()
    this.listeners.length = 0
  }

  // Output

  /** SVG path data per stroke, in CSS pixel space. */
  toPaths(): readonly string[] {
    return this.strokes.map((stroke) =>
      getStrokePath(stroke, { ...this.strokeOptions(), last: true }),
    )
  }

  /** A standalone SVG document, useful for previews and email. */
  toSvg(): string {
    const { width, height } = this.size()
    const paths = this.toPaths()
      .map((path) => `<path d="${path}" fill="${this.options.color ?? '#111827'}"/>`)
      .join('')

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${paths}</svg>`
  }

  toDataUrl(type = 'image/png', quality?: number): string {
    return this.canvas.toDataURL(type, quality)
  }

  /**
   * Produces the value to store on a field.
   *
   * The ink is trimmed to its own bounds and scaled to fill the box, because
   * people sign in the middle of the pad and leave margins. Both vector paths
   * and a raster copy are emitted: paths so the stamped output stays sharp,
   * the PNG so any renderer can display it without a path rasterizer.
   */
  toSignature(options: { trim?: boolean; includeRaster?: boolean } = {}): InkSignature | undefined {
    if (this.isEmpty) return undefined

    const { width, height } = this.size()
    const trim = options.trim ?? true

    const source = trim
      ? normalizeStrokes(this.strokes, { width, height }).strokes
      : this.strokes

    const paths = source.map((stroke) =>
      getStrokePath(stroke, { ...this.strokeOptions(), last: true }),
    )

    const signature: InkSignature = {
      source: 'drawn',
      width,
      height,
      paths,
    }

    if (options.includeRaster ?? true) {
      signature.png = this.toDataUrl()
    }
    return signature
  }

  /** Restores a previously captured signature, for an edit flow. */
  fromSignature(signature: InkSignature): void {
    this.strokes = []
    this.current = []
    this.redoStack = []

    if (signature.paths && signature.paths.length > 0) {
      // Paths are already outlines, so they are painted directly rather than
      // reconstructed into input points, which would be lossy guesswork.
      this.repaintPaths(signature.paths, signature)
      return
    }
    this.repaint()
  }

  /** Bounding box of the drawn ink, or `undefined` when empty. */
  bounds(): { x: number; y: number; width: number; height: number } | undefined {
    return strokesBounds(this.strokes)
  }

  // Internals

  private size(): { width: number; height: number } {
    return {
      width: this.canvas.width / this.pixelRatio,
      height: this.canvas.height / this.pixelRatio,
    }
  }

  private strokeOptions(): StrokeOptions {
    const { color: _color, background: _background, onChange: _onChange, ...rest } = this.options
    return rest
  }

  private attach(): void {
    const canvas = this.canvas

    // `touch-action: none` is what stops a drawing gesture from scrolling the
    // page. Setting it here rather than relying on a stylesheet means the pad
    // works without the consumer importing any CSS.
    canvas.style.touchAction = 'none'

    const down = (event: PointerEvent): void => {
      // Ignore secondary buttons and extra fingers mid-stroke.
      if (event.button !== 0 && event.pointerType === 'mouse') return
      if (this.drawing) return

      this.drawing = true
      this.pointerId = event.pointerId
      this.redoStack = []
      this.current = [this.toPoint(event)]

      try {
        canvas.setPointerCapture(event.pointerId)
      } catch {
        // Pointer capture is unavailable in some embedded webviews. Drawing
        // still works; it just stops tracking if the pointer leaves the canvas.
      }
      event.preventDefault()
      this.options.onStrokeStart?.()
      this.scheduleDraw()
    }

    const move = (event: PointerEvent): void => {
      if (!this.drawing || event.pointerId !== this.pointerId) return

      // Coalesced events give every sample the browser captured between
      // frames, not just the latest, so fast strokes keep their shape instead
      // of being reduced to a few straight segments.
      const events =
        typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []

      if (events.length > 0) {
        for (const each of events) this.current.push(this.toPoint(each))
      } else {
        this.current.push(this.toPoint(event))
      }

      event.preventDefault()
      this.scheduleDraw()
    }

    const up = (event: PointerEvent): void => {
      if (!this.drawing || event.pointerId !== this.pointerId) return

      this.drawing = false
      this.pointerId = undefined

      if (this.current.length > 0) {
        this.strokes.push(this.current)
        this.current = []
      }

      try {
        canvas.releasePointerCapture(event.pointerId)
      } catch {
        // Already released, which is not a problem.
      }

      this.repaint()
      this.options.onStrokeEnd?.()
      this.emitChange()
    }

    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
    canvas.addEventListener('pointerleave', up)

    this.listeners.push(
      () => canvas.removeEventListener('pointerdown', down),
      () => canvas.removeEventListener('pointermove', move),
      () => canvas.removeEventListener('pointerup', up),
      () => canvas.removeEventListener('pointercancel', up),
      () => canvas.removeEventListener('pointerleave', up),
    )
  }

  private toPoint(event: PointerEvent): InputPoint {
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      pressure: event.pressure > 0 ? event.pressure : 0.5,
      t: event.timeStamp,
    }
  }

  /** Coalesces draws to one per animation frame. */
  private scheduleDraw(): void {
    if (this.frame !== undefined || this.disposed) return
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined
      this.drawCurrent()
    })
  }

  /**
   * Draws only the in-progress stroke.
   *
   * The completed strokes are already on the canvas, so repainting them would
   * make every pointer move cost more as the signature grows. Drawing just
   * the live stroke keeps the cost constant.
   */
  private drawCurrent(): void {
    if (this.current.length === 0) return

    const outline = getStrokeOutline(this.current, { ...this.strokeOptions(), last: false })
    if (outline.length === 0) return

    this.context.fillStyle = this.options.color ?? '#111827'
    this.fillPath(outlineToPath(outline))
  }

  private repaint(): void {
    const { width, height } = this.size()
    this.context.clearRect(0, 0, width, height)

    if (this.options.background) {
      this.context.fillStyle = this.options.background
      this.context.fillRect(0, 0, width, height)
    }

    this.context.fillStyle = this.options.color ?? '#111827'
    for (const stroke of this.strokes) {
      const outline = getStrokeOutline(stroke, { ...this.strokeOptions(), last: true })
      if (outline.length > 0) this.fillPath(outlineToPath(outline))
    }

    if (this.current.length > 0) this.drawCurrent()
  }

  /** Paints outline paths that came from a stored signature. */
  private repaintPaths(paths: readonly string[], signature: InkSignature): void {
    const { width, height } = this.size()
    this.context.clearRect(0, 0, width, height)

    if (this.options.background) {
      this.context.fillStyle = this.options.background
      this.context.fillRect(0, 0, width, height)
    }

    // Scale the stored signature into the current canvas size.
    const scale =
      signature.width > 0 && signature.height > 0
        ? Math.min(width / signature.width, height / signature.height)
        : 1

    this.context.save()
    this.context.scale(scale, scale)
    this.context.fillStyle = this.options.color ?? '#111827'
    for (const path of paths) this.fillPath(path)
    this.context.restore()
  }

  private fillPath(data: string): void {
    // Path2D is in every browser that supports pointer events, so no fallback
    // parser is needed. The guard is for jsdom, which lacks it.
    const PathCtor = (globalThis as { Path2D?: new (d: string) => Path2D }).Path2D
    if (!PathCtor) return
    this.context.fill(new PathCtor(data))
  }

  private emitChange(): void {
    this.options.onChange?.({ isEmpty: this.isEmpty, strokeCount: this.strokes.length })
  }
}

/**
 * Builds a typed signature.
 *
 * Typing is the option most people take, and it has to produce something that
 * reads as a signature rather than as a form field. The text is rendered in a
 * script face to an SVG path-free signature value, with the font recorded so
 * the same mark can be reproduced when stamping.
 */
export function createTypedSignature(options: {
  text: string
  typeface?: string
  width?: number
  height?: number
}): InkSignature {
  const width = options.width ?? 320
  const height = options.height ?? 96

  return {
    source: 'typed',
    text: options.text,
    typeface: options.typeface ?? scriptFontStack,
    width,
    height,
  }
}

/**
 * Font stack for typed signatures.
 *
 * No webfont is bundled: a signature library has no business shipping a
 * typeface and the licence questions that come with it. These are faces
 * commonly present on desktop and mobile, ending in a generic cursive so
 * something script-like is always used. Pass your own `typeface` to use a
 * webfont you have licensed.
 */
export const scriptFontStack =
  '"Segoe Script", "Bradley Hand", "Snell Roundhand", "Apple Chancery", "Lucida Handwriting", cursive'

/** Builds an `InkSignature` from an uploaded image. */
export function createUploadedSignature(options: {
  dataUrl: string
  width: number
  height: number
}): InkSignature {
  return {
    source: 'uploaded',
    png: options.dataUrl,
    width: options.width,
    height: options.height,
  }
}
