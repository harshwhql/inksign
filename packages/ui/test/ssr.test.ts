import { describe, expect, it } from 'vitest'

/**
 * Server rendering.
 *
 * This file runs in the default Node environment, with no DOM, which is what a
 * server-rendered Nuxt, SvelteKit or Next page looks like when it imports the
 * package.
 *
 * It exists because the package used to crash on import there: the custom
 * element declared `class X extends HTMLElement`, which is evaluated at import
 * time, and `HTMLElement` does not exist on a server. Nothing on the server
 * ever used the element, but merely importing anything from `@inksign/ui`
 * brought the whole page down. Every entry point is touched here so a future
 * top-level DOM reference fails in CI rather than in someone's production
 * build.
 */

describe('importing without a DOM', () => {
  it('has no DOM globals, which is the condition being tested', () => {
    expect((globalThis as { document?: unknown }).document).toBeUndefined()
    expect((globalThis as { HTMLElement?: unknown }).HTMLElement).toBeUndefined()
  })

  it('imports the package entry point', async () => {
    const module = await import('../src/index.js')
    expect(typeof module.createTheme).toBe('function')
  })

  it('imports the custom element module without evaluating HTMLElement', async () => {
    const module = await import('../src/elements/signature-pad-element.js')
    expect(typeof module.InkSignSignaturePadElement).toBe('function')
    expect(typeof module.defineInkSignElements).toBe('function')
  })

  it('does nothing when asked to register elements without customElements', async () => {
    const { defineInkSignElements } = await import('../src/elements/signature-pad-element.js')
    // A no-op rather than a throw, so a host can call it unconditionally.
    expect(() => defineInkSignElements()).not.toThrow()
  })

  it('builds a theme, which is the part a server actually needs', async () => {
    const { createTheme, themeToCss } = await import('../src/index.js')
    const theme = createTheme({ brandColor: '#7c3aed' })
    const css = themeToCss(theme, '.signing')

    // Server-rendered markup needs the custom properties inlined, so this is
    // the one part of the UI package that has to work without a DOM.
    expect(css).toContain('--inksign-primary: #7c3aed')
  })

  it('computes layout and stroke geometry without a DOM', async () => {
    const { computeLayout, getStrokePath } = await import('../src/index.js')

    const layout = computeLayout({
      pageSizes: [{ width: 612, height: 792 }],
      scale: 1,
      containerWidth: 800,
    })
    expect(layout.pages).toHaveLength(1)

    const path = getStrokePath(
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      { last: true },
    )
    expect(path.startsWith('M ')).toBe(true)
  })

  it('reports a clear error rather than crashing when announcing without a DOM', async () => {
    const { announce } = await import('../src/index.js')
    // Announcements are a no-op on a server, not a crash.
    expect(() => announce('Signing complete')).not.toThrow()
  })
})
