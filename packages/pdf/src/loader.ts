import type { DocumentSource, PageSize } from '@inksign/core'
import { InkSignError } from '@inksign/core'

/**
 * Structural types for the slice of pdf.js this package uses.
 *
 * Declaring them here rather than importing from `pdfjs-dist` keeps the
 * package compiling across the whole supported version range (4.x and 5.x),
 * whose published types differ, and keeps pdf.js a genuinely optional peer: a
 * consumer who only needs geometry or stamping never installs it.
 */

export interface PdfPageProxy {
  readonly pageNumber: number
  getViewport(options: { scale: number; rotation?: number }): {
    width: number
    height: number
    rotation: number
  }
  render(options: {
    canvasContext: CanvasRenderingContext2D
    viewport: { width: number; height: number }
    intent?: string
  }): { promise: Promise<void>; cancel(): void }
  getTextContent(): Promise<{ items: readonly PdfTextItem[] }>
  cleanup(): void
}

export interface PdfTextItem {
  str?: string
  /** Text transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]. */
  transform?: readonly number[]
  width?: number
  height?: number
  hasEOL?: boolean
}

export interface PdfDocumentProxy {
  readonly numPages: number
  getPage(pageNumber: number): Promise<PdfPageProxy>
  destroy(): Promise<void>
}

interface PdfJsModule {
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocumentProxy> }
  GlobalWorkerOptions: { workerSrc: string }
  version?: string
}

let cached: PdfJsModule | undefined

/**
 * Supplies the pdf.js module explicitly, instead of letting it be imported.
 *
 * Use this when your bundler needs the dependency named at a call site it
 * controls, when you pin a specific pdf.js build, or when you load it from a
 * CDN. Calling it means `loadPdfJs` never performs an import of its own.
 *
 * ```ts
 * import * as pdfjs from 'pdfjs-dist'
 * setPdfJs(pdfjs)
 * ```
 */
export function setPdfJs(module: unknown): void {
  cached = module as PdfJsModule
}

/**
 * Loads pdf.js on first use.
 *
 * The import is dynamic so bundlers put pdf.js and its worker in a separate
 * chunk, fetched only when a page is actually rendered. The specifier is a
 * literal, which matters: a variable specifier cannot be resolved by any
 * browser bundler, and a bare name like `pdfjs-dist` means nothing to a
 * browser at runtime, so the import has to be statically analyzable for the
 * bundler to rewrite it.
 */
export async function loadPdfJs(): Promise<PdfJsModule> {
  if (cached) return cached
  try {
    cached = (await import('pdfjs-dist')) as unknown as PdfJsModule
    return cached
  } catch (cause) {
    throw new InkSignError(
      'UNSUPPORTED',
      'Rendering PDFs needs the "pdfjs-dist" peer dependency. Install it, or call setPdfJs() with your own instance.',
      {},
      { cause },
    )
  }
}

/**
 * Points pdf.js at its worker script.
 *
 * This has to be set once by the application, because only the application
 * knows how its bundler serves assets. Without it pdf.js falls back to running
 * on the main thread, which blocks every interaction while a page rasterizes.
 */
export async function configureWorker(workerSrc: string): Promise<void> {
  const pdfjs = await loadPdfJs()
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
}

export interface LoadOptions {
  /** Passed through to pdf.js, for example `cMapUrl` or `withCredentials`. */
  pdfJsOptions?: Record<string, unknown>
  /** Password for an encrypted document. */
  password?: string
  /** Resolves a storage key to bytes, for `{ kind: 'storage' }` sources. */
  resolve?: (key: string) => Promise<Uint8Array>
}

/** A loaded document, with its page geometry read up front. */
export interface LoadedDocument {
  readonly proxy: PdfDocumentProxy
  readonly pageCount: number
  /** Page sizes in points, indexed by zero-based page. */
  readonly pageSizes: readonly PageSize[]
  destroy(): Promise<void>
}

/**
 * Opens a PDF and reads its page geometry.
 *
 * Page sizes are read eagerly because field placement and layout both need
 * them before anything can be drawn, and reading them is cheap next to
 * rasterizing. The pages themselves stay unrendered until asked for.
 */
export async function loadDocument(
  source: DocumentSource,
  options: LoadOptions = {},
): Promise<LoadedDocument> {
  const pdfjs = await loadPdfJs()
  const request = await toRequest(source, options)

  let proxy: PdfDocumentProxy
  try {
    proxy = await pdfjs.getDocument({
      ...request,
      ...(options.password !== undefined ? { password: options.password } : {}),
      ...options.pdfJsOptions,
    }).promise
  } catch (cause) {
    throw new InkSignError(
      'RENDER_FAILED',
      `Could not open the PDF: ${cause instanceof Error ? cause.message : String(cause)}`,
      { source: source.kind },
      { cause },
    )
  }

  const pageSizes: PageSize[] = []
  for (let i = 1; i <= proxy.numPages; i += 1) {
    const page = await proxy.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    pageSizes.push({
      width: viewport.width,
      height: viewport.height,
      rotation: viewport.rotation,
    })
    page.cleanup()
  }

  return {
    proxy,
    pageCount: proxy.numPages,
    pageSizes,
    destroy: () => proxy.destroy(),
  }
}

async function toRequest(
  source: DocumentSource,
  options: LoadOptions,
): Promise<Record<string, unknown>> {
  switch (source.kind) {
    case 'url':
      return { url: source.url }
    case 'bytes':
      // pdf.js takes ownership of the buffer it is handed and detaches it, so
      // a copy keeps the caller's array usable afterwards.
      return { data: source.bytes.slice() }
    case 'base64':
      return { data: base64ToBytes(source.data) }
    case 'storage': {
      if (!options.resolve) {
        throw new InkSignError(
          'ADAPTER_MISSING',
          'This document has a storage source, so loadDocument needs a `resolve` function to read the key',
          { key: source.key },
        )
      }
      const bytes = await options.resolve(source.key)
      return { data: bytes.slice() }
    }
  }
}

export function base64ToBytes(data: string): Uint8Array {
  const clean = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data

  const fromBuffer = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer
  if (fromBuffer) return new Uint8Array(fromBuffer.from(clean, 'base64'))

  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  const fromBuffer = (
    globalThis as {
      Buffer?: { from(b: Uint8Array): { toString(e: string): string } }
    }
  ).Buffer
  if (fromBuffer) return fromBuffer.from(bytes).toString('base64')

  // Chunked so a large document does not blow the argument limit on apply.
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
