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
  announce,
  bindFieldNavigation,
  clearAnnouncer,
  describeField,
  describeProgress,
  type FieldNavigation,
  prefersReducedMotion,
  trapFocus,
} from './a11y/announce.js'
export {
  defineInkSignElements,
  InkSignSignaturePadElement,
} from './elements/signature-pad-element.js'
export {
  createTypedSignature,
  createUploadedSignature,
  SignaturePad,
  type SignaturePadOptions,
  scriptFontStack,
} from './signature/pad.js'
export {
  getStrokeOutline,
  getStrokePath,
  type InputPoint,
  normalizeStrokes,
  outlineToPath,
  type StrokeOptions,
  strokesBounds,
} from './signature/stroke.js'
export {
  applyTheme,
  auditThemeContrast,
  type Branding,
  type ColorTokens,
  type CreateThemeOptions,
  contrastRatio,
  createTheme,
  DEFAULT_PREFIX,
  darkTokens,
  type ElevationTokens,
  hexToRgb,
  lightTokens,
  type MotionTokens,
  relativeLuminance,
  type ShapeTokens,
  type SpaceTokens,
  type Theme,
  type ThemeOverride,
  type ThemeTokens,
  type TypographyTokens,
  themeToCss,
  themeToResponsiveCss,
  themeToStyleString,
  themeToVariables,
} from './theme/tokens.js'
export {
  anchoredScroll,
  computeLayout,
  type DocumentLayout,
  fitPageScale,
  fitWidthScale,
  type LayoutOptions,
  nextZoom,
  type PageLayout,
  previousZoom,
  scrollOffsetForPage,
  type VisibleRange,
  visibleRange,
  zoomSteps,
} from './viewer/layout.js'
