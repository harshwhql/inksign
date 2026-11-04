/**
 * @inksign/pdf
 *
 * PDF concerns for InkSign: coordinate geometry, page rendering, anchor-based
 * placement, and flattening captured values into a final document.
 *
 * `pdfjs-dist` and `pdf-lib` are optional peer dependencies, loaded on first
 * use. Geometry needs neither, rendering needs pdfjs-dist, and writing needs
 * pdf-lib, so a server that only stamps PDFs never pulls in a renderer.
 */

export {
  FieldIndex,
  POINTS_PER_INCH,
  createViewport,
  cssPointToField,
  cssToField,
  fieldToCss,
  fieldToPdf,
  fitInside,
  hitTest,
  inches,
  millimeters,
  normalizeRotation,
  overlaps,
  pageSizes,
  pdfToField,
  withScale,
  type Box,
  type Point,
  type Rotation,
  type Viewport,
} from './geometry.js'

export {
  base64ToBytes,
  bytesToBase64,
  configureWorker,
  loadDocument,
  loadPdfJs,
  type LoadOptions,
  type LoadedDocument,
  type PdfDocumentProxy,
  type PdfPageProxy,
  type PdfTextItem,
} from './loader.js'

export {
  PageRenderer,
  visibleWindow,
  type CanvasLike,
  type RenderedPage,
  type RendererOptions,
} from './renderer.js'

export {
  applyAnchors,
  extractText,
  findAnchors,
  placeAtAnchor,
  resolveAnchoredFields,
  internals as anchorInternals,
  type AnchorMatch,
} from './anchors.js'

export {
  loadPdfLib,
  mergeDocuments,
  parseColor,
  stampDocument,
  type StampOptions,
  type StampStyle,
} from './stamp.js'

export {
  buildCertificate,
  type CertificateBranding,
  type CertificateOptions,
} from './certificate.js'
