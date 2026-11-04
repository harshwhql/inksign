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
  type AnchorMatch,
  applyAnchors,
  extractText,
  findAnchors,
  internals as anchorInternals,
  placeAtAnchor,
  resolveAnchoredFields,
} from './anchors.js'
export {
  buildCertificate,
  type CertificateBranding,
  type CertificateOptions,
} from './certificate.js'
export {
  type Box,
  createViewport,
  cssPointToField,
  cssToField,
  FieldIndex,
  fieldToCss,
  fieldToPdf,
  fitInside,
  hitTest,
  inches,
  millimeters,
  normalizeRotation,
  overlaps,
  POINTS_PER_INCH,
  type Point,
  pageSizes,
  pdfToField,
  type Rotation,
  type Viewport,
  withScale,
} from './geometry.js'
export {
  base64ToBytes,
  bytesToBase64,
  configureWorker,
  type LoadedDocument,
  type LoadOptions,
  loadDocument,
  loadPdfJs,
  type PdfDocumentProxy,
  type PdfPageProxy,
  type PdfTextItem,
  setPdfJs,
} from './loader.js'
export {
  type CanvasLike,
  PageRenderer,
  type RenderedPage,
  type RendererOptions,
  visibleWindow,
} from './renderer.js'
export {
  loadPdfLib,
  mergeDocuments,
  parseColor,
  type StampOptions,
  type StampStyle,
  setPdfLib,
  stampDocument,
} from './stamp.js'
