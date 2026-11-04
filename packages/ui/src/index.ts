/**
 * @inksign/ui
 *
 * Framework-agnostic UI building blocks: stroke rendering, the signature pad
 * controller, document layout and virtualization, theming, accessibility
 * helpers, and web components.
 *
 * Nothing here imports a framework. The React, Vue and Svelte adapters are
 * thin bindings over these, so behaviour is implemented once and the adapters
 * cannot drift apart.
 */

export {
  getStrokeOutline,
  getStrokePath,
  normalizeStrokes,
  outlineToPath,
  strokesBounds,
  type InputPoint,
  type StrokeOptions,
} from './signature/stroke.js'

export {
  SignaturePad,
  createTypedSignature,
  createUploadedSignature,
  scriptFontStack,
  type SignaturePadOptions,
} from './signature/pad.js'

export {
  DEFAULT_PREFIX,
  applyTheme,
  auditThemeContrast,
  contrastRatio,
  createTheme,
  darkTokens,
  hexToRgb,
  lightTokens,
  relativeLuminance,
  themeToCss,
  themeToResponsiveCss,
  themeToStyleString,
  themeToVariables,
  type Branding,
  type ColorTokens,
  type CreateThemeOptions,
  type ElevationTokens,
  type MotionTokens,
  type ShapeTokens,
  type SpaceTokens,
  type Theme,
  type ThemeOverride,
  type ThemeTokens,
  type TypographyTokens,
} from './theme/tokens.js'

export {
  anchoredScroll,
  computeLayout,
  fitPageScale,
  fitWidthScale,
  nextZoom,
  previousZoom,
  scrollOffsetForPage,
  visibleRange,
  zoomSteps,
  type DocumentLayout,
  type LayoutOptions,
  type PageLayout,
  type VisibleRange,
} from './viewer/layout.js'

export {
  announce,
  bindFieldNavigation,
  clearAnnouncer,
  describeField,
  describeProgress,
  prefersReducedMotion,
  trapFocus,
  type FieldNavigation,
} from './a11y/announce.js'

export {
  InkSignSignaturePadElement,
  defineInkSignElements,
} from './elements/signature-pad-element.js'
