import { describe, expect, it } from 'vitest'
import {
  auditThemeContrast,
  contrastRatio,
  createTheme,
  darkTokens,
  hexToRgb,
  lightTokens,
  themeToCss,
  themeToResponsiveCss,
  themeToStyleString,
  themeToVariables,
} from '../src/theme/tokens.js'

describe('theme creation', () => {
  it('defaults to the light scheme', () => {
    const theme = createTheme()
    expect(theme.scheme).toBe('light')
    expect(theme.tokens.colors.surface).toBe(lightTokens.colors.surface)
  })

  it('uses dark tokens for the dark scheme', () => {
    const theme = createTheme({ scheme: 'dark' })
    expect(theme.tokens.colors.surface).toBe(darkTokens.colors.surface)
  })

  it('merges overrides per group without dropping siblings', () => {
    const theme = createTheme({ tokens: { colors: { primary: '#ff0000' } } })

    expect(theme.tokens.colors.primary).toBe('#ff0000')
    // Everything else in the group survives.
    expect(theme.tokens.colors.surface).toBe(lightTokens.colors.surface)
    expect(theme.tokens.typography.fontFamily).toBe(lightTokens.typography.fontFamily)
  })

  it('carries branding through', () => {
    const theme = createTheme({ branding: { name: 'Northwind', logoHeight: 40 } })
    expect(theme.branding.name).toBe('Northwind')
  })

  it('does not advertise itself by default', () => {
    expect(createTheme().branding.showAttribution).toBeUndefined()
  })
})

describe('brand colour derivation', () => {
  it('sets the primary colour from one hex value', () => {
    const theme = createTheme({ brandColor: '#7c3aed' })
    expect(theme.tokens.colors.primary).toBe('#7c3aed')
    expect(theme.tokens.colors.fieldActive).toBe('#7c3aed')
  })

  it('picks white text on a dark brand colour', () => {
    const theme = createTheme({ brandColor: '#1a1a2e' })
    expect(theme.tokens.colors.primaryContrast).toBe('#ffffff')
  })

  it('picks dark text on a light brand colour', () => {
    const theme = createTheme({ brandColor: '#f5d90a' })
    expect(theme.tokens.colors.primaryContrast).toBe('#14161d')
  })

  it('keeps the derived contrast readable for a range of brand colours', () => {
    const brands = ['#7c3aed', '#f5d90a', '#1d6f42', '#e11d48', '#0ea5e9', '#111111', '#eeeeee']

    for (const brand of brands) {
      const theme = createTheme({ brandColor: brand })
      const ratio = contrastRatio(theme.tokens.colors.primaryContrast, theme.tokens.colors.primary)
      // AA for large text and UI components.
      expect(ratio ?? 0).toBeGreaterThanOrEqual(3)
    }
  })

  it('lets an explicit token win over derivation', () => {
    const theme = createTheme({
      brandColor: '#7c3aed',
      tokens: { colors: { primary: '#000000' } },
    })
    expect(theme.tokens.colors.primary).toBe('#000000')
  })

  it('ignores an unparseable brand colour', () => {
    const theme = createTheme({ brandColor: 'not-a-colour' })
    expect(theme.tokens.colors.primary).toBe(lightTokens.colors.primary)
  })

  it('accepts shorthand hex', () => {
    expect(hexToRgb('#f00')).toEqual({ r: 255, g: 0, b: 0 })
    expect(hexToRgb('f00')).toEqual({ r: 255, g: 0, b: 0 })
  })
})

describe('contrast', () => {
  it('computes known ratios', () => {
    // Black on white is the maximum.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 2)
  })

  it('is order independent', () => {
    expect(contrastRatio('#123456', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#123456') ?? 0,
      5,
    )
  })

  it('returns undefined for an invalid colour', () => {
    expect(contrastRatio('nope', '#ffffff')).toBeUndefined()
  })
})

describe('contrast audit', () => {
  it('passes AA for the default light theme', () => {
    const results = auditThemeContrast(createTheme())
    const failures = results.filter((r) => !r.passesAA)
    expect(failures).toEqual([])
  })

  it('passes AA for the default dark theme', () => {
    const results = auditThemeContrast(createTheme({ scheme: 'dark' }))
    const failures = results.filter((r) => !r.passesAA)
    expect(failures).toEqual([])
  })

  it('reports a failure for an unreadable override', () => {
    const theme = createTheme({
      tokens: { colors: { text: '#eeeeee', surface: '#ffffff' } },
    })
    const results = auditThemeContrast(theme)
    expect(results.some((r) => r.token === 'text' && !r.passesAA)).toBe(true)
  })
})

describe('CSS output', () => {
  it('emits one custom property per token, without the group name', () => {
    const variables = themeToVariables(createTheme())

    expect(variables['--inksign-primary']).toBe(lightTokens.colors.primary)
    expect(variables['--inksign-font-family']).toBe(lightTokens.typography.fontFamily)
    expect(variables['--inksign-colors-primary']).toBeUndefined()
  })

  it('converts camelCase token names to kebab-case', () => {
    const variables = themeToVariables(createTheme())
    expect(variables['--inksign-primary-contrast']).toBeDefined()
    expect(variables['--inksign-surface-raised']).toBeDefined()
    expect(variables['--inksign-field-required']).toBeDefined()
  })

  it('honours a custom prefix, so two instances can coexist', () => {
    const variables = themeToVariables(createTheme({ prefix: 'preview' }))
    expect(variables['--preview-primary']).toBeDefined()
    expect(variables['--inksign-primary']).toBeUndefined()
  })

  it('includes the logo height when branding sets it', () => {
    const variables = themeToVariables(createTheme({ branding: { logoHeight: 48 } }))
    expect(variables['--inksign-logo-height']).toBe('48px')
  })

  it('builds a style attribute string', () => {
    const style = themeToStyleString(createTheme())
    expect(style).toContain('--inksign-primary:')
    expect(style).toContain('; ')
  })

  it('builds a CSS rule for a selector', () => {
    const css = themeToCss(createTheme(), '.my-signing-ui')
    expect(css.startsWith('.my-signing-ui {')).toBe(true)
    expect(css).toContain('--inksign-primary:')
    expect(css.trimEnd().endsWith('}')).toBe(true)
  })

  it('builds a responsive stylesheet covering both schemes', () => {
    const css = themeToResponsiveCss({ brandColor: '#7c3aed' })

    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).toContain("[data-inksign-scheme='dark']")
    expect(css).toContain("[data-inksign-scheme='light']")
    expect(css).toContain('#7c3aed')
  })
})
