/**
 * Variable-width stroke rendering.
 *
 * A signature drawn as a fixed-width polyline looks like a signature drawn
 * with a mouse, which undermines the whole point: people expect their
 * signature to look like theirs. Real ink varies in width, so this models
 * that, and the result is what most people judge the product by.
 *
 * The approach is to build an outline rather than stroke a path. For each
 * input point a radius is computed, then two offset points are placed
 * perpendicular to the direction of travel. Walking the offsets up one side
 * and back down the other produces a closed shape that is filled, which is
 * what lets the width change along the stroke. Stroking a path cannot do that:
 * `stroke-width` is constant for the whole path.
 *
 * Radius comes from pressure when the hardware reports it, and from velocity
 * otherwise, because a fast stroke with a real pen deposits less ink. Mice and
 * most trackpads report a constant pressure, so the velocity path is what
 * actually runs for the majority of signatures.
 *
 * No dependencies. The algorithm is about 150 lines and shipping it keeps the
 * package free of a transitive dependency on anything.
 */

export interface InputPoint {
  x: number
  y: number
  /** 0 to 1. Pointer events report 0.5 for devices with no pressure sensor. */
  pressure?: number
  /** Milliseconds, used to derive velocity. */
  t?: number
}

export interface StrokeOptions {
  /** Base stroke width in pixels. */
  size?: number
  /**
   * How much pressure affects width, 0 to 1. At 0 the stroke is uniform.
   */
  thinning?: number
  /** Corner smoothing, 0 to 1. Higher is rounder. */
  smoothing?: number
  /** How aggressively input jitter is averaged out, 0 to 1. */
  streamline?: number
  /** Round the start of the stroke. */
  capStart?: boolean
  /** Round the end of the stroke. */
  capEnd?: boolean
  /**
   * Taper the first N pixels of the stroke, as a pen does on contact.
   */
  taperStart?: number
  taperEnd?: number
  /**
   * Use velocity instead of pressure. Defaults to automatic: velocity is used
   * when the input reports no real pressure variation.
   */
  simulatePressure?: boolean
  /** The stroke is finished, so the end cap is drawn. */
  last?: boolean
}

const defaults = {
  size: 8,
  thinning: 0.62,
  smoothing: 0.5,
  streamline: 0.5,
  capStart: true,
  capEnd: true,
  taperStart: 0,
  taperEnd: 0,
} as const

type Vec = readonly [number, number]

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]]
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]]
const mul = (a: Vec, n: number): Vec => [a[0] * n, a[1] * n]
const len = (a: Vec): number => Math.hypot(a[0], a[1])
const dist = (a: Vec, b: Vec): number => Math.hypot(a[0] - b[0], a[1] - b[1])
/** Rotates 90 degrees, giving the perpendicular used for the offsets. */
const perp = (a: Vec): Vec => [a[1], -a[0]]
const lerpVec = (a: Vec, b: Vec, t: number): Vec => add(a, mul(sub(b, a), t))

function normalize(a: Vec): Vec {
  const l = len(a)
  return l === 0 ? [0, 0] : [a[0] / l, a[1] / l]
}

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n))

interface SamplePoint {
  point: Vec
  pressure: number
  vector: Vec
  distance: number
  runningLength: number
}

/**
 * Resamples the raw input.
 *
 * Two things happen here. Points are averaged towards their predecessor, which
 * removes the hand tremor and digitizer noise that would otherwise show as a
 * visible wobble. Points closer together than a quarter of a pixel are
 * dropped, since they contribute nothing but cost geometry later.
 */
function resample(points: readonly InputPoint[], streamline: number): SamplePoint[] {
  if (points.length === 0) return []

  const first = points[0] as InputPoint
  const out: SamplePoint[] = [
    {
      point: [first.x, first.y],
      pressure: first.pressure ?? 0.5,
      vector: [1, 1],
      distance: 0,
      runningLength: 0,
    },
  ]

  // A high streamline value lags the stroke behind the cursor, so it is
  // damped rather than applied directly.
  const smoothing = 0.15 + (1 - streamline) * 0.85
  let previous = out[0] as SamplePoint

  for (let i = 1; i < points.length; i += 1) {
    const raw = points[i] as InputPoint
    const target: Vec = [raw.x, raw.y]
    const point = streamline > 0 ? lerpVec(previous.point, target, smoothing) : target

    const distance = dist(point, previous.point)
    // Sub-quarter-pixel moves are noise, not intent.
    if (distance < 0.25 && i < points.length - 1) continue

    const sample: SamplePoint = {
      point,
      pressure: raw.pressure ?? 0.5,
      vector: normalize(sub(previous.point, point)),
      distance,
      runningLength: previous.runningLength + distance,
    }
    out.push(sample)
    previous = sample
  }

  // The first point's direction is unknowable until the second arrives.
  const second = out[1]
  if (second) (out[0] as SamplePoint).vector = second.vector

  return out
}

/** True when the input carries real pressure data rather than a constant. */
function hasRealPressure(points: readonly InputPoint[]): boolean {
  let seen: number | undefined
  for (const point of points) {
    const pressure = point.pressure
    if (pressure === undefined) return false
    // A mouse reports exactly 0.5 while down, and 0 or 1 is a flat default.
    if (seen === undefined) seen = pressure
    else if (Math.abs(pressure - seen) > 0.02) return true
  }
  return false
}

/**
 * Produces the outline of a stroke as a list of points, ready to be filled.
 *
 * Returned points trace one side of the stroke and then the other, so the
 * shape closes on itself.
 */
export function getStrokeOutline(
  rawPoints: readonly InputPoint[],
  options: StrokeOptions = {},
): readonly Vec[] {
  const size = options.size ?? defaults.size
  const thinning = options.thinning ?? defaults.thinning
  const streamline = options.streamline ?? defaults.streamline
  const capStart = options.capStart ?? defaults.capStart
  const capEnd = options.capEnd ?? defaults.capEnd
  const taperStart = options.taperStart ?? defaults.taperStart
  const taperEnd = options.taperEnd ?? defaults.taperEnd
  const last = options.last ?? false

  const simulate = options.simulatePressure ?? !hasRealPressure(rawPoints)
  const points = resample(rawPoints, streamline)

  if (points.length === 0) return []

  const totalLength = (points[points.length - 1] as SamplePoint).runningLength
  const radius = size / 2

  // A single point is a dot, drawn as a circle.
  if (points.length === 1) {
    const only = points[0] as SamplePoint
    const r = simulate ? radius : radius * (0.5 + only.pressure * 0.5)
    return circle(only.point, Math.max(r, 0.5))
  }

  /** Radius at one sample, from pressure or speed, plus the end tapers. */
  const radiusAt = (sample: SamplePoint, index: number): number => {
    let scale: number

    if (thinning === 0) {
      scale = 1
    } else if (simulate) {
      // Velocity-based: a fast stroke is thin, like a pen moving quickly.
      // The 0.1 divisor maps typical drawing speeds onto a useful range.
      const speed = clamp(sample.distance / 10, 0, 1)
      scale = 1 - speed * thinning
    } else {
      scale = 1 - thinning + sample.pressure * thinning * 2
      scale = clamp(scale, 1 - thinning, 1 + thinning * 0.4)
    }

    let r = radius * clamp(scale, 0.08, 1.6)

    if (taperStart > 0) {
      const t = clamp(sample.runningLength / taperStart, 0, 1)
      // Square root gives a quick taper that then flattens, which reads as a
      // pen touching down rather than fading in linearly.
      r *= Math.sqrt(t)
    }
    if (taperEnd > 0 && last) {
      const remaining = totalLength - sample.runningLength
      r *= Math.sqrt(clamp(remaining / taperEnd, 0, 1))
    }
    // The very first points have no reliable velocity, so ease them in.
    if (index < 2 && taperStart === 0) {
      r *= 0.75 + index * 0.125
    }

    return Math.max(r, 0.4)
  }

  const left: Vec[] = []
  const right: Vec[] = []

  for (let i = 0; i < points.length; i += 1) {
    const sample = points[i] as SamplePoint
    const r = radiusAt(sample, i)

    // Average the incoming and outgoing directions so corners are mitred
    // rather than producing a spike on a sharp change of direction.
    const previous = points[i - 1]
    const next = points[i + 1]
    let direction = sample.vector
    if (next) direction = normalize(add(sample.vector, next.vector))
    else if (previous) direction = sample.vector

    const offset = mul(perp(direction), r)
    left.push(sub(sample.point, offset))
    right.push(add(sample.point, offset))
  }

  const startPoint = points[0] as SamplePoint
  const endPoint = points[points.length - 1] as SamplePoint

  const startCap = capStart
    ? arc(startPoint.point, radiusAt(startPoint, 0), startPoint.vector, true)
    : []
  const endCap =
    capEnd && last
      ? arc(endPoint.point, radiusAt(endPoint, points.length - 1), endPoint.vector, false)
      : []

  // Up one side, round the end, back down the other, round the start.
  // Smoothing is applied when the outline is converted to a path, not here.
  return [...left, ...endCap, ...right.reverse(), ...startCap]
}

/** Points approximating a full circle, for a single-tap dot. */
function circle(center: Vec, radius: number, segments = 16): readonly Vec[] {
  const out: Vec[] = []
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2
    out.push([center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius])
  }
  return out
}

/** Half circle capping one end of the stroke. */
function arc(center: Vec, radius: number, direction: Vec, start: boolean, segments = 8): Vec[] {
  const base = Math.atan2(direction[1], direction[0])
  const from = start ? base - Math.PI / 2 : base + Math.PI / 2
  const out: Vec[] = []

  for (let i = 0; i <= segments; i += 1) {
    const angle = from + (start ? -1 : 1) * (i / segments) * Math.PI
    out.push([center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius])
  }
  return out
}

/**
 * Converts an outline into SVG path data.
 *
 * Quadratic curves through the midpoints of consecutive outline points, which
 * is the standard trick for turning a dense polyline into a smooth curve
 * without solving for control points: each segment's midpoint becomes an
 * on-curve anchor, and the original vertex becomes the control point.
 */
export function outlineToPath(outline: readonly Vec[], smooth = true): string {
  if (outline.length === 0) return ''

  const first = outline[0] as Vec
  if (outline.length < 3) {
    return `M ${round(first[0])} ${round(first[1])} Z`
  }

  if (!smooth) {
    const lines = outline
      .slice(1)
      .map((p) => `L ${round(p[0])} ${round(p[1])}`)
      .join(' ')
    return `M ${round(first[0])} ${round(first[1])} ${lines} Z`
  }

  let path = `M ${round(first[0])} ${round(first[1])}`

  for (let i = 1; i < outline.length; i += 1) {
    const current = outline[i] as Vec
    const next = outline[(i + 1) % outline.length] as Vec
    const midX = (current[0] + next[0]) / 2
    const midY = (current[1] + next[1]) / 2
    path += ` Q ${round(current[0])} ${round(current[1])} ${round(midX)} ${round(midY)}`
  }

  return `${path} Z`
}

/** Two decimal places: finer makes the path longer with no visible gain. */
function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** Builds SVG path data for one stroke, in one call. */
export function getStrokePath(points: readonly InputPoint[], options?: StrokeOptions): string {
  return outlineToPath(getStrokeOutline(points, options), (options?.smoothing ?? 0.5) > 0)
}

/** Bounding box of a set of strokes, for trimming whitespace. */
export function strokesBounds(
  strokes: readonly (readonly InputPoint[])[],
  padding = 0,
): { x: number; y: number; width: number; height: number } | undefined {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let seen = false

  for (const stroke of strokes) {
    for (const point of stroke) {
      seen = true
      if (point.x < minX) minX = point.x
      if (point.y < minY) minY = point.y
      if (point.x > maxX) maxX = point.x
      if (point.y > maxY) maxY = point.y
    }
  }

  if (!seen) return undefined

  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  }
}

/**
 * Shifts and scales strokes so the drawn mark fills its box.
 *
 * People sign in the middle of a large pad and leave wide margins. Stamping
 * that into a field would produce a tiny signature floating in a big box, so
 * the ink is trimmed to its own bounds first.
 */
export function normalizeStrokes(
  strokes: readonly (readonly InputPoint[])[],
  target: { width: number; height: number },
  padding = 4,
): { strokes: readonly (readonly InputPoint[])[]; width: number; height: number } {
  const bounds = strokesBounds(strokes)
  if (!bounds || bounds.width === 0 || bounds.height === 0) {
    return { strokes, width: target.width, height: target.height }
  }

  const available = {
    width: Math.max(1, target.width - padding * 2),
    height: Math.max(1, target.height - padding * 2),
  }
  const scale = Math.min(available.width / bounds.width, available.height / bounds.height)

  const offsetX = padding + (available.width - bounds.width * scale) / 2
  const offsetY = padding + (available.height - bounds.height * scale) / 2

  const moved = strokes.map((stroke) =>
    stroke.map((point) => ({
      ...point,
      x: (point.x - bounds.x) * scale + offsetX,
      y: (point.y - bounds.y) * scale + offsetY,
    })),
  )

  return { strokes: moved, width: target.width, height: target.height }
}
