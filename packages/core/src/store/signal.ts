/**
 * Minimal reactive primitives, with no runtime dependencies.
 *
 * The design target is a signing ceremony on a long document with hundreds of
 * fields, where a keystroke in one field must not wake the other 399. Two
 * properties get us there:
 *
 * 1. Notifications are keyed. A listener registers against a topic string and
 *    hears only about that topic.
 * 2. Notifications are batched to a microtask, so a burst of writes inside one
 *    event handler produces exactly one notification per affected topic.
 */

export type Unsubscribe = () => void
export type Listener = () => void

export interface ReadableSignal<T> {
  get(): T
  subscribe(listener: Listener): Unsubscribe
}

export interface WritableSignal<T> extends ReadableSignal<T> {
  set(next: T): void
  update(fn: (current: T) => T): void
}

/**
 * Creates a single reactive value.
 *
 * Listeners take no arguments and read the current value through `get()`. That
 * keeps the contract identical to React's `useSyncExternalStore`, so adapters
 * do not need a shim.
 */
export function signal<T>(
  initial: T,
  equals: (a: T, b: T) => boolean = Object.is,
): WritableSignal<T> {
  let value = initial
  const listeners = new Set<Listener>()

  return {
    get: () => value,
    set(next: T) {
      if (equals(value, next)) return
      value = next
      scheduleNotify(listeners)
    },
    update(fn: (current: T) => T) {
      this.set(fn(value))
    },
    subscribe(listener: Listener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * A notifier keyed by topic. Writers mark topics dirty; each listener is
 * called at most once per flush no matter how many of its topics changed.
 */
export class TopicNotifier {
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly dirty = new Set<string>()
  private flushScheduled = false
  private batchDepth = 0

  subscribe(topic: string, listener: Listener): Unsubscribe {
    let set = this.listeners.get(topic)
    if (!set) {
      set = new Set()
      this.listeners.set(topic, set)
    }
    set.add(listener)
    return () => {
      const current = this.listeners.get(topic)
      if (!current) return
      current.delete(listener)
      // Drop empty buckets so long sessions do not accumulate dead keys.
      if (current.size === 0) this.listeners.delete(topic)
    }
  }

  /** Marks a topic dirty. The flush is deferred to the end of the batch. */
  mark(topic: string): void {
    if (this.listeners.has(topic)) this.dirty.add(topic)
    this.schedule()
  }

  markAll(topics: Iterable<string>): void {
    for (const topic of topics) {
      if (this.listeners.has(topic)) this.dirty.add(topic)
    }
    this.schedule()
  }

  /**
   * Runs `fn`, holding all notifications until it returns. Nested batches
   * collapse into the outermost one.
   */
  batch<T>(fn: () => T): T {
    this.batchDepth += 1
    try {
      return fn()
    } finally {
      this.batchDepth -= 1
      if (this.batchDepth === 0) this.flush()
    }
  }

  /** Delivers pending notifications immediately. */
  flush(): void {
    if (this.dirty.size === 0) {
      this.flushScheduled = false
      return
    }
    const topics = Array.from(this.dirty)
    this.dirty.clear()
    this.flushScheduled = false

    // Collect first, then call. A listener that subscribes or unsubscribes
    // during the flush cannot then corrupt the iteration.
    const pending = new Set<Listener>()
    for (const topic of topics) {
      const set = this.listeners.get(topic)
      if (!set) continue
      for (const listener of set) pending.add(listener)
    }
    for (const listener of pending) listener()
  }

  /** Number of live listeners, for diagnostics and leak tests. */
  get listenerCount(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }

  private schedule(): void {
    if (this.batchDepth > 0 || this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => {
      this.flushScheduled = false
      if (this.batchDepth === 0) this.flush()
    })
  }
}

function scheduleNotify(listeners: ReadonlySet<Listener>): void {
  if (listeners.size === 0) return
  const snapshot = Array.from(listeners)
  queueMicrotask(() => {
    for (const listener of snapshot) listener()
  })
}

/**
 * Derives a value from a source signal, recomputing only when the source
 * changes and only while something is listening.
 */
export function derived<T, R>(
  source: ReadableSignal<T>,
  compute: (value: T) => R,
  equals: (a: R, b: R) => boolean = Object.is,
): ReadableSignal<R> {
  let cached: { input: T; output: R } | undefined

  const read = (): R => {
    const input = source.get()
    if (cached && Object.is(cached.input, input)) return cached.output
    const output = compute(input)
    if (cached && equals(cached.output, output)) {
      // Keep the previous output identity so downstream identity checks hold.
      cached = { input, output: cached.output }
      return cached.output
    }
    cached = { input, output }
    return output
  }

  return {
    get: read,
    subscribe: (listener) => source.subscribe(listener),
  }
}
