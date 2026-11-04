/**
 * Theming and branding.
 *
 * Every visual value resolves to a CSS custom property under one prefix, which
 * is deliberate and has three consequences worth stating:
 *
 * - **No runtime.** Theming costs nothing at render time. There is no
 *   CSS-in-JS runtime, no style recalculation on theme change, and no extra
 *   bytes per component instance. Changing a theme sets variables on one
 *   element and the browser repaints.
 * - **Any framework, or none.** Custom properties cascade, so the same theme
 *   applies to the React components, the web components, and markup a
 *   consumer wrote themselves.
 * - **Overridable without a fight.** Consumers can set any variable from their
 *   own stylesheet at the same or higher specificity. There is no need for
 *   `!important`, no internal class names to reverse engineer, and no styled
 *   component to wrap.
 *
 * The prefix is configurable so that two InkSign instances on one page, say a
 * sender preview beside an embedded ceremony, can be themed independently.
 */

export interface ColorTokens {
  /** Primary action colour, used for the main button and focus rings. */
  primary: string
  /** Text and icons on top of `primary`. */
  primaryContrast: string
  /** Hover state for primary surfaces. */
  primaryHover: string
  /** Page background. */
  surface: string
  /** Raised surfaces: panels, toolbars, the signature pad. */
  surfaceRaised: string
  /** Recessed surfaces: the area behind document pages. */
  surfaceSunken: string
  text: string
  textMuted: string
  border: string
  borderStrong: string
  danger: string
  dangerContrast: string
  success: string
  warning: string
  /** Field assigned to the current signer and not yet filled. */
  fieldIdle: string
  /** Border for a field that must be completed. */
  fieldRequired: string
  /** The field the signer is on. */
  fieldActive: string
  /** A field that holds a value. */
  fieldFilled: string
  /** A field belonging to a different signer. */
  fieldOther: string
  /** Field that failed validation. */
  fieldInvalid: string
  /** Ink colour for signatures. */
  ink: string
}

export interface TypographyTokens {
  fontFamily: string
  fontFamilyMono: string
  /** Face used for typed signatures. */
  fontFamilySignature: string
  fontSizeSmall: string
  fontSizeBase: string
  fontSizeLarge: string
  fontSizeHeading: string
  fontWeightNormal: string
  fontWeightMedium: string
  fontWeightBold: string
  lineHeight: string
}

export interface ShapeTokens {
  radiusSmall: string
  radius: string
  radiusLarge: string
  radiusPill: string
  borderWidth: string
  focusRingWidth: string
}

export interface SpaceTokens {
  space1: string
  space2: string
  space3: string
  space4: string
  space5: string
  space6: string
}

export interface ElevationTokens {
  shadowLow: string
  shadow: string
  shadowHigh: string
}

export interface MotionTokens {
  durationFast: string
  duration: string
  easing: string
}

export interface ThemeTokens {
  colors: ColorTokens
  typography: TypographyTokens
  shape: ShapeTokens
  space: SpaceTokens
  elevation: ElevationTokens
  motion: MotionTokens
}

export interface Branding {
  /** Product or organization name, shown in headers and emails. */
  name?: string
  /** Logo URL or data URL, rendered in the ceremony header. */
  logoUrl?: string
  /** Accessible description of the logo. Defaults to `name`. */
  logoAlt?: string
  /** Maximum logo height in CSS pixels. Defaults to 32. */
  logoHeight?: number
  /** Support contact shown when a signer needs help. */
  supportUrl?: string
  supportEmail?: string
  /** Replaces the default electronic record disclosure text. */
  consentText?: string
  /** URL of the full disclosure, linked from the consent step. */
  consentUrl?: string
  /**
   * Shows a small "Powered by InkSign" line. Defaults to false: this is a
   * library you are building a product with, not a brand to be advertised.
   */
  showAttribution?: boolean
  /** Extra footer text, for a legal notice. */
  footerText?: string
}

export interface Theme {
  tokens: ThemeTokens
  branding: Branding
  /** CSS custom property prefix, without the leading dashes. */
  prefix: string
  /** Colour scheme the tokens describe. */
  scheme: 'light' | 'dark'
}

const sans =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
const mono =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
const script =
  '"Segoe Script", "Bradley Hand", "Snell Roundhand", "Apple Chancery", "Lucida Handwriting", cursive'

const sharedTypography: TypographyTokens = {
  fontFamily: sans,
  fontFamilyMono: mono,
  fontFamilySignature: script,
  fontSizeSmall: '0.8125rem',
  fontSizeBase: '0.9375rem',
  fontSizeLarge: '1.0625rem',
  fontSizeHeading: '1.375rem',
  fontWeightNormal: '400',
  fontWeightMedium: '500',
  fontWeightBold: '650',
  lineHeight: '1.5',
}

const sharedShape: ShapeTokens = {
  radiusSmall: '4px',
  radius: '8px',
  radiusLarge: '14px',
  radiusPill: '999px',
  borderWidth: '1px',
  focusRingWidth: '2px',
}

const sharedSpace: SpaceTokens = {
  space1: '4px',
  space2: '8px',
  space3: '12px',
  space4: '16px',
  space5: '24px',
  space6: '32px',
}

const sharedMotion: MotionTokens = {
  durationFast: '120ms',
  duration: '200ms',
  easing: 'cubic-bezier(0.2, 0, 0.2, 1)',
}

export const lightTokens: ThemeTokens = {
  colors: {
    primary: '#1f2a5e',
    primaryContrast: '#ffffff',
    primaryHover: '#18214a',
    surface: '#ffffff',
    surfaceRaised: '#ffffff',
    surfaceSunken: '#f1f2f6',
    text: '#14161d',
    textMuted: '#5c6070',
    border: '#dfe1e8',
    borderStrong: '#b9bdc9',
    danger: '#b3261e',
    dangerContrast: '#ffffff',
    success: '#1d6f42',
    warning: '#8a5a00',
    fieldIdle: 'rgba(31, 42, 94, 0.08)',
    fieldRequired: '#1f2a5e',
    fieldActive: '#1f2a5e',
    fieldFilled: 'rgba(29, 111, 66, 0.1)',
    fieldOther: 'rgba(92, 96, 112, 0.14)',
    fieldInvalid: '#b3261e',
    ink: '#14161d',
  },
  typography: sharedTypography,
  shape: sharedShape,
  space: sharedSpace,
  elevation: {
    shadowLow: '0 1px 2px rgba(20, 22, 29, 0.06)',
    shadow: '0 2px 8px rgba(20, 22, 29, 0.1)',
    shadowHigh: '0 12px 32px rgba(20, 22, 29, 0.16)',
  },
  motion: sharedMotion,
}

export const darkTokens: ThemeTokens = {
  colors: {
    primary: '#9aacff',
    primaryContrast: '#0d1020',
    primaryHover: '#b2c0ff',
    surface: '#15171f',
    surfaceRaised: '#1d2029',
    surfaceSunken: '#0f1117',
    text: '#eef0f6',
    textMuted: '#a0a5b8',
    border: '#2c303c',
    borderStrong: '#434857',
    danger: '#ff8a80',
    dangerContrast: '#2a0a08',
    success: '#7fd1a0',
    warning: '#f0c070',
    fieldIdle: 'rgba(154, 172, 255, 0.14)',
    fieldRequired: '#9aacff',
    fieldActive: '#9aacff',
    fieldFilled: 'rgba(127, 209, 160, 0.16)',
    fieldOther: 'rgba(160, 165, 184, 0.16)',
    fieldInvalid: '#ff8a80',
    ink: '#eef0f6',
  },
  typography: sharedTypography,
  shape: sharedShape,
  space: sharedSpace,
  elevation: {
    shadowLow: '0 1px 2px rgba(0, 0, 0, 0.4)',
    shadow: '0 2px 10px rgba(0, 0, 0, 0.5)',
    shadowHigh: '0 14px 36px rgba(0, 0, 0, 0.6)',
  },
  motion: sharedMotion,
}

export const DEFAULT_PREFIX = 'inksign'

/** A theme token override, nested the same way as `ThemeTokens`. */
export type ThemeOverride = {
  [K in keyof ThemeTokens]?: Partial<ThemeTokens[K]>
}

export interface CreateThemeOptions {
  scheme?: 'light' | 'dark'
  /** Token overrides, merged per group over the chosen base. */
  tokens?: ThemeOverride
  branding?: Branding
  prefix?: string
  /**
   * Derives a full colour ramp from one brand colour.
   *
   * This is the common case: a developer has a hex value from their brand
   * guide and wants the components to match without specifying twenty
   * colours. Only tokens not given explicitly in `tokens` are derived.
   */
  brandColor?: string
}

/** Builds a theme from a base scheme plus overrides. */
export function createTheme(options: CreateThemeOptions = {}): Theme {
  const scheme = options.scheme ?? 'light'
  const base = scheme === 'dark' ? darkTokens : lightTokens

  const derived = options.brandColor ? deriveFromBrandColor(options.brandColor, scheme) : undefined

  return {
    scheme,
    prefix: options.prefix ?? DEFAULT_PREFIX,
    branding: options.branding ?? {},
    tokens: {
      colors: { ...base.colors, ...derived, ...options.tokens?.colors },
      typography: { ...base.typography, ...options.tokens?.typography },
      shape: { ...base.shape, ...options.tokens?.shape },
      space: { ...base.space, ...options.tokens?.space },
      elevation: { ...base.elevation, ...options.tokens?.elevation },
      motion: { ...base.motion, ...options.tokens?.motion },
    },
  }
}

/**
 * Derives the brand-dependent colours from a single hex value.
 *
 * The contrast colour is chosen by measuring the actual contrast ratio of each
 * candidate and taking the better one, rather than by comparing luminance
 * against a threshold. A threshold gets mid-tone colours wrong: sky blue sits
 * just below any sensible cut-off, so it picks white text at about 2.8:1 when
 * dark text would have given 7:1. Measuring cannot make that mistake.
 *
 * This is an accessibility requirement, not a preference. A signer who cannot
 * read the button cannot sign.
 */
function deriveFromBrandColor(hex: string, scheme: 'light' | 'dark'): Partial<ColorTokens> {
  const rgb = hexToRgb(hex)
  if (!rgb) return {}

  const brand = rgbToHex(rgb)
  const onDark = contrastRatio('#ffffff', brand) ?? 0
  const onLight = contrastRatio('#14161d', brand) ?? 0
  const contrast = onLight >= onDark ? '#14161d' : '#ffffff'

  const hover = scheme === 'dark' ? lighten(rgb, 0.12) : darken(rgb, 0.12)

  return {
    primary: rgbToHex(rgb),
    primaryContrast: contrast,
    primaryHover: hover,
    fieldRequired: rgbToHex(rgb),
    fieldActive: rgbToHex(rgb),
    fieldIdle: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${scheme === 'dark' ? 0.16 : 0.08})`,
  }
}

interface Rgb {
  r: number
  g: number
  b: number
}

export function hexToRgb(hex: string): Rgb | undefined {
  const clean = hex.replace('#', '').trim()
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean

  if (!/^[0-9a-f]{6}$/iu.test(full)) return undefined

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

function rgbToHex({ r, g, b }: Rgb): string {
  const part = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/** WCAG relative luminance, used to pick a readable contrast colour. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const v = value / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number | undefined {
  const left = hexToRgb(a)
  const right = hexToRgb(b)
  if (!left || !right) return undefined

  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right))
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right))
  return (lighter + 0.05) / (darker + 0.05)
}

function lighten(rgb: Rgb, amount: number): string {
  return rgbToHex({
    r: rgb.r + (255 - rgb.r) * amount,
    g: rgb.g + (255 - rgb.g) * amount,
    b: rgb.b + (255 - rgb.b) * amount,
  })
}

function darken(rgb: Rgb, amount: number): string {
  return rgbToHex({
    r: rgb.r * (1 - amount),
    g: rgb.g * (1 - amount),
    b: rgb.b * (1 - amount),
  })
}

/** Converts a camelCase token name into a kebab-case CSS variable segment. */
function kebab(name: string): string {
  return name.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)
}

/** The flat custom-property map a theme resolves to. */
export function themeToVariables(theme: Theme): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  const prefix = theme.prefix

  for (const [group, tokens] of Object.entries(theme.tokens)) {
    for (const [name, value] of Object.entries(tokens as Record<string, string>)) {
      // The group is dropped from the name: `--inksign-primary`, not
      // `--inksign-colors-primary`, because token names are already unique
      // and the shorter form is what consumers have to type to override.
      void group
      out[`--${prefix}-${kebab(name)}`] = value
    }
  }

  if (theme.branding.logoHeight !== undefined) {
    out[`--${prefix}-logo-height`] = `${theme.branding.logoHeight}px`
  }

  return out
}

/** A `style` attribute string, for server rendering or a plain element. */
export function themeToStyleString(theme: Theme): string {
  return Object.entries(themeToVariables(theme))
    .map(([name, value]) => `${name}: ${value}`)
    .join('; ')
}

/**
 * Applies a theme to an element by setting its custom properties.
 *
 * Returns a function that removes them, so a component can clean up after
 * itself without leaving variables behind on a shared root.
 */
export function applyTheme(element: HTMLElement, theme: Theme): () => void {
  const variables = themeToVariables(theme)
  const previous = new Map<string, string>()

  for (const [name, value] of Object.entries(variables)) {
    previous.set(name, element.style.getPropertyValue(name))
    element.style.setProperty(name, value)
  }
  element.dataset.inksignScheme = theme.scheme

  return () => {
    for (const [name, value] of previous) {
      if (value) element.style.setProperty(name, value)
      else element.style.removeProperty(name)
    }
    delete element.dataset.inksignScheme
  }
}

/**
 * A CSS rule block for a selector, for consumers who prefer a stylesheet to
 * inline styles, or who need the theme in a `@media (prefers-color-scheme)`
 * query.
 */
export function themeToCss(theme: Theme, selector = ':root'): string {
  const body = Object.entries(themeToVariables(theme))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n')
  return `${selector} {\n${body}\n}`
}

/**
 * Light and dark in one stylesheet, switching on the system preference and
 * overridable with `data-inksign-scheme` on any ancestor.
 */
export function themeToResponsiveCss(
  options: Omit<CreateThemeOptions, 'scheme'> = {},
  selector = ':root',
): string {
  const light = createTheme({ ...options, scheme: 'light' })
  const dark = createTheme({ ...options, scheme: 'dark' })

  return [
    themeToCss(light, selector),
    '',
    '@media (prefers-color-scheme: dark) {',
    themeToCss(dark, `${selector}:not([data-inksign-scheme='light'])`)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
    '}',
    '',
    themeToCss(dark, `${selector}[data-inksign-scheme='dark']`),
  ].join('\n')
}

/**
 * Checks a theme's text and action colours against WCAG AA.
 *
 * Worth running in a test when a brand colour is configured, because a brand
 * palette chosen for a marketing site is often unreadable as a button.
 */
export function auditThemeContrast(theme: Theme): readonly {
  token: string
  against: string
  ratio: number
  passesAA: boolean
}[] {
  const { colors } = theme.tokens
  const pairs: readonly (readonly [string, string, string])[] = [
    ['text', colors.text, colors.surface],
    ['textMuted', colors.textMuted, colors.surface],
    ['primaryContrast', colors.primaryContrast, colors.primary],
    ['dangerContrast', colors.dangerContrast, colors.danger],
  ]

  const out: { token: string; against: string; ratio: number; passesAA: boolean }[] = []
  for (const [token, foreground, background] of pairs) {
    const ratio = contrastRatio(foreground, background)
    if (ratio === undefined) continue
    out.push({
      token,
      against: background,
      ratio: Math.round(ratio * 100) / 100,
      // 4.5:1 is the AA threshold for body text.
      passesAA: ratio >= 4.5,
    })
  }
  return out
}
