import type { InkSignature } from '@inksign/core'
import { SignaturePad, type SignaturePadOptions } from '../signature/pad.js'

/**
 * `<inksign-signature-pad>`, a custom element wrapping the signature pad.
 *
 * This is the escape hatch that makes the "works with any framework" claim
 * true rather than aspirational. Custom elements are part of the platform, so
 * Vue, Svelte, Angular, Solid, Astro, Rails with Hotwire, and plain HTML can
 * all use this today without an adapter being written for each. The dedicated
 * adapters exist to give idiomatic bindings, not to enable support.
 *
 * ```html
 * <inksign-signature-pad ink="#1f2a5e" height="180"></inksign-signature-pad>
 * <script type="module">
 *   const pad = document.querySelector('inksign-signature-pad')
 *   pad.addEventListener('change', (event) => {
 *     console.log(event.detail.isEmpty)
 *   })
 *   const signature = pad.toSignature()
 * </script>
 * ```
 *
 * Shadow DOM is used so the host page's styles cannot break the canvas
 * geometry, which would misalign the ink from the pointer. Theming still works
 * because custom properties pierce the shadow boundary.
 */
export class InkSignSignaturePadElement extends HTMLElement {
  static readonly observedAttributes = [
    'ink',
    'background',
    'size',
    'thinning',
    'disabled',
    'height',
  ] as const

  private pad: SignaturePad | undefined
  private canvas: HTMLCanvasElement | undefined
  private observer: ResizeObserver | undefined

  connectedCallback(): void {
    if (!this.shadowRoot) this.render()
    this.mountPad()

    // The canvas backing store has to follow the element's size or the ink
    // stops lining up with the pointer.
    const ResizeObserverCtor = (globalThis as { ResizeObserver?: typeof ResizeObserver })
      .ResizeObserver
    if (ResizeObserverCtor && this.canvas) {
      this.observer = new ResizeObserverCtor(() => this.pad?.resize())
      this.observer.observe(this)
    }
  }

  disconnectedCallback(): void {
    this.observer?.disconnect()
    this.observer = undefined
    this.pad?.dispose()
    this.pad = undefined
  }

  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (previous === next) return

    if (name === 'height') {
      this.style.setProperty('--inksign-pad-height', next ? `${next}px` : null)
      this.pad?.resize()
      return
    }
    this.pad?.setOptions(this.optionsFromAttributes())
  }

  // Public API, usable from any framework

  get isEmpty(): boolean {
    return this.pad?.isEmpty ?? true
  }

  get canUndo(): boolean {
    return this.pad?.canUndo ?? false
  }

  clear(): void {
    this.pad?.clear()
  }

  undo(): void {
    this.pad?.undo()
  }

  redo(): void {
    this.pad?.redo()
  }

  /** The captured signature, or `undefined` when nothing is drawn. */
  toSignature(): InkSignature | undefined {
    return this.pad?.toSignature()
  }

  toDataUrl(type?: string): string | undefined {
    return this.pad?.toDataUrl(type)
  }

  toSvg(): string | undefined {
    return this.pad?.toSvg()
  }

  /** Loads a previously captured signature. */
  fromSignature(signature: InkSignature): void {
    this.pad?.fromSignature(signature)
  }

  private render(): void {
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>
        :host {
          display: block;
          position: relative;
          box-sizing: border-box;
          min-height: var(--inksign-pad-height, 160px);
          background: var(--inksign-surface-raised, #fff);
          border: var(--inksign-border-width, 1px) dashed
            var(--inksign-border-strong, #b9bdc9);
          border-radius: var(--inksign-radius, 8px);
          overflow: hidden;
        }
        :host([disabled]) { opacity: 0.6; pointer-events: none; }
        :host(:focus-within) {
          border-color: var(--inksign-primary, #1f2a5e);
          border-style: solid;
          outline: var(--inksign-focus-ring-width, 2px) solid
            var(--inksign-primary, #1f2a5e);
          outline-offset: 2px;
        }
        canvas {
          display: block;
          width: 100%;
          height: 100%;
          position: absolute;
          inset: 0;
          cursor: crosshair;
        }
        .guide {
          position: absolute;
          left: 12px;
          right: 12px;
          bottom: 28%;
          border-bottom: 1px solid var(--inksign-border, #dfe1e8);
          pointer-events: none;
        }
        .hint {
          position: absolute;
          left: 50%;
          bottom: calc(28% - 22px);
          transform: translateX(-50%);
          font-family: var(--inksign-font-family, system-ui, sans-serif);
          font-size: var(--inksign-font-size-small, 0.8125rem);
          color: var(--inksign-text-muted, #5c6070);
          pointer-events: none;
          transition: opacity var(--inksign-duration, 200ms)
            var(--inksign-easing, ease);
        }
        :host([data-drawn]) .hint { opacity: 0; }
        @media (prefers-reduced-motion: reduce) {
          .hint { transition: none; }
        }
      </style>
      <div class="guide"></div>
      <span class="hint" part="hint">Draw your signature</span>
      <canvas tabindex="0" role="img"></canvas>
    `

    this.canvas = root.querySelector('canvas') as HTMLCanvasElement
    this.canvas.setAttribute('aria-label', this.getAttribute('label') ?? 'Signature drawing area')
  }

  private mountPad(): void {
    if (!this.canvas || this.pad) return

    this.pad = new SignaturePad(this.canvas, {
      ...this.optionsFromAttributes(),
      onChange: (state) => {
        if (state.isEmpty) this.removeAttribute('data-drawn')
        else this.setAttribute('data-drawn', '')

        this.dispatchEvent(
          new CustomEvent('change', { detail: state, bubbles: true, composed: true }),
        )
      },
      onStrokeEnd: () => {
        this.dispatchEvent(new CustomEvent('strokeend', { bubbles: true, composed: true }))
      },
    })

    // The element may have been sized by CSS after the canvas was created.
    requestAnimationFrame(() => this.pad?.resize())
  }

  private optionsFromAttributes(): SignaturePadOptions {
    const number = (name: string): number | undefined => {
      const raw = this.getAttribute(name)
      if (raw === null) return undefined
      const value = Number(raw)
      return Number.isFinite(value) ? value : undefined
    }

    const size = number('size')
    const thinning = number('thinning')
    const ink = this.getAttribute('ink')
    const background = this.getAttribute('background')

    return {
      ...(ink !== null ? { color: ink } : {}),
      ...(background !== null ? { background } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(thinning !== undefined ? { thinning } : {}),
    }
  }
}

/**
 * Registers the custom elements.
 *
 * Called explicitly rather than on import, because a module with registration
 * side effects breaks server rendering and makes the package impossible to
 * tree-shake. It is safe to call more than once.
 */
export function defineInkSignElements(prefix = 'inksign'): void {
  const registry = (globalThis as { customElements?: CustomElementRegistry }).customElements
  if (!registry) return

  const name = `${prefix}-signature-pad`
  if (!registry.get(name)) registry.define(name, InkSignSignaturePadElement)
}

declare global {
  interface HTMLElementTagNameMap {
    'inksign-signature-pad': InkSignSignaturePadElement
  }
}
