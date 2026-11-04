import { InkSignError, formatValue, isEmpty } from '@inksign/core'
import type { Field, FieldValue, InkSignature, PageSize } from '@inksign/core'
import { fieldToPdf, fitInside } from './geometry.js'
import { base64ToBytes } from './loader.js'

/**
 * Flattens captured values into the PDF itself.
 *
 * "Flatten" is the important word. The values are drawn into the page content
 * rather than left as interactive form fields, so the output is a fixed
 * document that renders identically everywhere and cannot be edited by a PDF
 * reader. An AcroForm signature that any viewer can retype is not evidence of
 * anything.
 *
 * Vector paths are preferred over the raster copy whenever a signature has
 * them, so the mark stays sharp when printed or zoomed, and the file stays
 * small: a stroke is a few hundred bytes against tens of kilobytes for a PNG.
 */

interface PdfLibModule {
  PDFDocument: {
    load(
      bytes: Uint8Array | ArrayBuffer,
      options?: Record<string, unknown>,
    ): Promise<PdfLibDocument>
    create(): Promise<PdfLibDocument>
  }
  StandardFonts: Record<string, string>
  rgb(r: number, g: number, b: number): unknown
  degrees(value: number): unknown
}

interface PdfLibDocument {
  getPages(): PdfLibPage[]
  addPage(size?: [number, number]): PdfLibPage
  embedPng(bytes: Uint8Array): Promise<PdfLibImage>
  embedJpg(bytes: Uint8Array): Promise<PdfLibImage>
  embedFont(font: string | Uint8Array, options?: Record<string, unknown>): Promise<PdfLibFont>
  copyPages(source: PdfLibDocument, indices: number[]): Promise<PdfLibPage[]>
  save(options?: Record<string, unknown>): Promise<Uint8Array>
  setTitle(title: string): void
  setSubject(subject: string): void
  setProducer(producer: string): void
  setCreator(creator: string): void
  setKeywords(keywords: string[]): void
  setModificationDate(date: Date): void
}

interface PdfLibPage {
  getSize(): { width: number; height: number }
  drawText(text: string, options: Record<string, unknown>): void
  drawImage(image: PdfLibImage, options: Record<string, unknown>): void
  drawSvgPath(path: string, options: Record<string, unknown>): void
  drawRectangle(options: Record<string, unknown>): void
  drawLine(options: Record<string, unknown>): void
}

interface PdfLibImage {
  width: number
  height: number
  scale(factor: number): { width: number; height: number }
}

interface PdfLibFont {
  widthOfTextAtSize(text: string, size: number): number
  heightAtSize(size: number): number
}

let cached: PdfLibModule | undefined

export async function loadPdfLib(): Promise<PdfLibModule> {
  if (cached) return cached
  try {
    const specifier = 'pdf-lib'
    cached = (await import(/* @vite-ignore */ specifier)) as unknown as PdfLibModule
    return cached
  } catch (cause) {
    throw new InkSignError(
      'UNSUPPORTED',
      'Writing PDFs needs the "pdf-lib" peer dependency. Install it to flatten fields or build a certificate.',
      {},
      { cause },
    )
  }
}

export interface StampStyle {
  /** Default text colour as `#rrggbb`. */
  textColor?: string
  fontSize?: number
  /** Font for typed signatures. Supply bytes to embed a script typeface. */
  signatureFont?: Uint8Array
  /** Stroke width for drawn signatures, in points. */
  strokeWidth?: number
  strokeColor?: string
  /** Draw a thin rule under each signature, as a printed form would have. */
  signatureBaseline?: boolean
}

export interface StampOptions {
  /** The original PDF. */
  bytes: Uint8Array
  /** Fields to draw, with anchors already resolved. */
  fields: readonly Field[]
  /** Values by field ID. Fields with no value are skipped. */
  values: ReadonlyMap<string, FieldValue> | Readonly<Record<string, FieldValue>>
  style?: StampStyle
  /** Metadata written into the output document. */
  metadata?: {
    title?: string
    subject?: string
    envelopeId?: string
    /** Seal digest, recorded in the keywords so it travels with the file. */
    sealDigest?: string
  }
  locale?: string
}

/** Flattens values into the document and returns the new PDF bytes. */
export async function stampDocument(options: StampOptions): Promise<Uint8Array> {
  const pdfLib = await loadPdfLib()
  const { PDFDocument, rgb, StandardFonts } = pdfLib

  const document = await PDFDocument.load(options.bytes, { updateMetadata: false })
  const pages = document.getPages()
  const style = options.style ?? {}
  const values = toMap(options.values)

  const helvetica = await document.embedFont(StandardFonts.Helvetica as string)
  const signatureFont = style.signatureFont
    ? await document.embedFont(style.signatureFont, { subset: true })
    : await document.embedFont(StandardFonts.HelveticaOblique as string)

  const textColor = parseColor(style.textColor ?? '#111111', rgb)
  const strokeColor = parseColor(style.strokeColor ?? '#1a1a2e', rgb)
  const baseFontSize = style.fontSize ?? 10
  const strokeWidth = style.strokeWidth ?? 1.6

  // Embed each distinct signature image once. A signature typically repeats on
  // every page, and embedding it per field would multiply the file size by the
  // page count.
  const imageCache = new Map<string, PdfLibImage>()

  for (const field of options.fields) {
    const value = values.get(field.id)
    if (!value || isEmpty(value)) continue

    const page = pages[field.rect.page]
    if (!page) {
      throw new InkSignError(
        'RENDER_FAILED',
        `Field ${field.label ?? field.id} is on page ${field.rect.page + 1}, but the document has ${pages.length}`,
        { fieldId: field.id, page: field.rect.page, pageCount: pages.length },
      )
    }

    const size = page.getSize()
    const pageSize: PageSize = { width: size.width, height: size.height }

    switch (value.kind) {
      case 'ink':
        await drawInk({
          page,
          document,
          field,
          ink: value.value,
          pageSize,
          imageCache,
          font: signatureFont,
          strokeColor,
          strokeWidth,
          baseline: style.signatureBaseline ?? false,
          rgb,
        })
        break

      case 'boolean':
        if (value.value) drawCheck(page, field, pageSize, strokeColor, strokeWidth)
        break

      default: {
        const text = formatValue(value, options.locale)
        if (text.length === 0) break
        drawFieldText({
          page,
          field,
          text,
          pageSize,
          font: helvetica,
          color: textColor,
          baseFontSize,
        })
        break
      }
    }
  }

  const metadata = options.metadata
  if (metadata) {
    if (metadata.title) document.setTitle(metadata.title)
    if (metadata.subject) document.setSubject(metadata.subject)
    document.setProducer('InkSign')
    document.setCreator('InkSign')
    document.setModificationDate(new Date())

    const keywords: string[] = []
    if (metadata.envelopeId) keywords.push(`inksign-envelope:${metadata.envelopeId}`)
    if (metadata.sealDigest) keywords.push(`inksign-seal:${metadata.sealDigest}`)
    if (keywords.length > 0) document.setKeywords(keywords)
  }

  // Object streams keep the output compact, which matters when a document is
  // emailed to every recipient.
  return document.save({ useObjectStreams: true })
}

interface DrawInkArgs {
  page: PdfLibPage
  document: PdfLibDocument
  field: Field
  ink: InkSignature
  pageSize: PageSize
  imageCache: Map<string, PdfLibImage>
  font: PdfLibFont
  strokeColor: unknown
  strokeWidth: number
  baseline: boolean
  rgb: PdfLibModule['rgb']
}

async function drawInk(args: DrawInkArgs): Promise<void> {
  const { page, field, ink, pageSize, baseline } = args
  const target = fieldToPdf(field.rect, pageSize)

  if (baseline) {
    page.drawLine({
      start: { x: target.x, y: target.y + 1 },
      end: { x: target.x + target.width, y: target.y + 1 },
      thickness: 0.5,
      color: args.rgb(0.78, 0.78, 0.8),
    })
  }

  // Vector first: sharp at any size, and a fraction of the bytes.
  if (ink.paths && ink.paths.length > 0 && ink.width > 0 && ink.height > 0) {
    const fitted = fitInside(
      { width: ink.width, height: ink.height },
      field.rect,
      Math.min(2, field.rect.height * 0.08),
    )
    const scale = ink.width > 0 ? fitted.width / ink.width : 1

    for (const path of ink.paths) {
      page.drawSvgPath(path, {
        // drawSvgPath reads the path in SVG coordinates, y increasing
        // downwards, anchored at this point. So the anchor is the box's top
        // edge converted into PDF space, where y measures up from the bottom.
        x: fitted.left,
        y: pageSize.height - fitted.top,
        scale,
        borderColor: args.strokeColor,
        borderWidth: args.strokeWidth * scale,
        borderLineCap: 1,
      })
    }
    return
  }

  if (ink.png) {
    const key = ink.png
    let image = args.imageCache.get(key)
    if (!image) {
      const bytes = base64ToBytes(ink.png)
      image = ink.png.includes('image/jpeg')
        ? await args.document.embedJpg(bytes)
        : await args.document.embedPng(bytes)
      args.imageCache.set(key, image)
    }

    const fitted = fitInside({ width: image.width, height: image.height }, field.rect, 1)
    page.drawImage(image, {
      x: fitted.left,
      y: pageSize.height - fitted.top - fitted.height,
      width: fitted.width,
      height: fitted.height,
    })
    return
  }

  if (ink.text) {
    const fontSize = fitTextToBox(ink.text, field.rect, args.font, field.rect.height * 0.7)
    page.drawText(ink.text, {
      x: target.x + 2,
      y: target.y + (target.height - args.font.heightAtSize(fontSize)) / 2 + fontSize * 0.2,
      size: fontSize,
      font: args.font,
      color: args.strokeColor,
    })
  }
}

interface DrawTextArgs {
  page: PdfLibPage
  field: Field
  text: string
  pageSize: PageSize
  font: PdfLibFont
  color: unknown
  baseFontSize: number
}

function drawFieldText(args: DrawTextArgs): void {
  const { page, field, text, pageSize, font } = args
  const target = fieldToPdf(field.rect, pageSize)

  const requested = field.style?.fontSize ?? args.baseFontSize
  // Shrink to fit rather than overflow. A value that spills outside its box
  // onto neighbouring text is worse than one a point smaller.
  const fontSize = Math.min(requested, fitTextToBox(text, field.rect, font, requested))

  const textWidth = font.widthOfTextAtSize(text, fontSize)
  const align = field.style?.align ?? 'left'
  const padding = 2

  let x = target.x + padding
  if (align === 'center') x = target.x + (target.width - textWidth) / 2
  else if (align === 'right') x = target.x + target.width - textWidth - padding

  // Vertically centre on the box, offsetting by the descender so the glyphs
  // look centred rather than the line box.
  const y = target.y + (target.height - fontSize) / 2 + fontSize * 0.22

  page.drawText(text, {
    x,
    y,
    size: fontSize,
    font,
    color: args.color,
    maxWidth: target.width - padding * 2,
  })
}

function drawCheck(
  page: PdfLibPage,
  field: Field,
  pageSize: PageSize,
  color: unknown,
  strokeWidth: number,
): void {
  const target = fieldToPdf(field.rect, pageSize)
  const inset = Math.min(target.width, target.height) * 0.22

  const left = target.x + inset
  const right = target.x + target.width - inset
  const bottom = target.y + inset
  const top = target.y + target.height - inset
  const midX = left + (right - left) * 0.38
  const thickness = Math.max(1, Math.min(strokeWidth, (right - left) * 0.18))

  // A tick drawn as two strokes, which prints and scales better than a glyph
  // that may not exist in the embedded font.
  page.drawLine({
    start: { x: left, y: bottom + (top - bottom) * 0.45 },
    end: { x: midX, y: bottom },
    thickness,
    color,
    lineCap: 1,
  })
  page.drawLine({
    start: { x: midX, y: bottom },
    end: { x: right, y: top },
    thickness,
    color,
    lineCap: 1,
  })
}

/** Largest font size at which the text fits the box, down to 4 points. */
function fitTextToBox(
  text: string,
  rect: { width: number; height: number },
  font: PdfLibFont,
  startSize: number,
): number {
  const available = rect.width - 4
  let size = Math.min(startSize, rect.height * 0.8)

  while (size > 4 && font.widthOfTextAtSize(text, size) > available) {
    size -= 0.5
  }
  return Math.max(4, size)
}

function toMap(
  values: ReadonlyMap<string, FieldValue> | Readonly<Record<string, FieldValue>>,
): ReadonlyMap<string, FieldValue> {
  if (values instanceof Map) return values
  return new Map(Object.entries(values as Record<string, FieldValue>))
}

export function parseColor(hex: string, rgb: PdfLibModule['rgb']): unknown {
  const clean = hex.replace('#', '').trim()
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean

  if (full.length !== 6) return rgb(0, 0, 0)

  const r = Number.parseInt(full.slice(0, 2), 16) / 255
  const g = Number.parseInt(full.slice(2, 4), 16) / 255
  const b = Number.parseInt(full.slice(4, 6), 16) / 255

  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return rgb(0, 0, 0)
  return rgb(r, g, b)
}

/** Concatenates PDFs, used to attach supplemental documents and certificates. */
export async function mergeDocuments(parts: readonly Uint8Array[]): Promise<Uint8Array> {
  if (parts.length === 0) {
    throw new InkSignError('RENDER_FAILED', 'mergeDocuments needs at least one document')
  }
  const first = parts[0] as Uint8Array
  if (parts.length === 1) return first

  const { PDFDocument } = await loadPdfLib()
  const out = await PDFDocument.create()

  for (const part of parts) {
    const source = await PDFDocument.load(part)
    const indices = source.getPages().map((_, i) => i)
    const copied = await out.copyPages(source, indices)
    for (const page of copied) {
      // copyPages returns detached pages; addPage is what inserts them.
      ;(out as unknown as { addPage(p: PdfLibPage): void }).addPage(page)
    }
  }

  out.setProducer('InkSign')
  return out.save({ useObjectStreams: true })
}
