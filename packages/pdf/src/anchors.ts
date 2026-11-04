import type { AnchorPlacement, Field, FieldRect, PageSize } from '@inksign/core'
import type { LoadedDocument, PdfTextItem } from './loader.js'

/**
 * Anchor-based field placement.
 *
 * Absolute coordinates break whenever a document is regenerated: add a clause
 * and every signature below it is in the wrong place. Anchoring binds a field
 * to text instead ("18 points below the words 'Authorized signature'"), so
 * placements survive edits to the document.
 *
 * The work is in reassembling the text. A PDF has no notion of a word: it has
 * positioned glyph runs, and "Authorized signature" may arrive as four items
 * with the space implied by a gap in coordinates. So the text is rebuilt into
 * a searchable string while keeping a map from each character back to the item
 * it came from, which is what lets a match be turned back into coordinates.
 */

export interface AnchorMatch {
  page: number
  /** Bounding box of the matched text, in field space (top-left origin). */
  rect: Omit<FieldRect, 'page'>
  text: string
}

interface IndexedItem {
  item: PdfTextItem
  /** Where this item's text starts in the assembled page string. */
  start: number
  end: number
  x: number
  /** Top edge in field space. */
  y: number
  width: number
  height: number
}

interface PageText {
  text: string
  items: readonly IndexedItem[]
}

/**
 * Rebuilds a page's text with positions.
 *
 * A space is inserted between items when the horizontal gap is wide enough to
 * be a word break, which is how a PDF represents one. Without this,
 * "Authorizedsignature" would never match the anchor the author wrote.
 */
function assemblePage(items: readonly PdfTextItem[], page: PageSize): PageText {
  const indexed: IndexedItem[] = []
  let text = ''
  let previous: IndexedItem | undefined

  for (const item of items) {
    const str = item.str ?? ''
    const transform = item.transform
    if (!transform || transform.length < 6) continue

    const x = transform[4] as number
    const baselineY = transform[5] as number
    const height = item.height ?? Math.abs(transform[3] as number) ?? 0
    const width = item.width ?? 0

    // pdf.js reports the baseline in PDF space, which measures up from the
    // bottom. Field space measures down from the top, and wants the top edge.
    const y = page.height - baselineY - height

    if (previous) {
      const gap = x - (previous.x + previous.width)
      const sameLine = Math.abs(y - previous.y) < Math.max(2, height * 0.5)
      const needsSpace =
        !text.endsWith(' ') &&
        str.length > 0 &&
        !str.startsWith(' ') &&
        (previous.item.hasEOL || !sameLine || gap > height * 0.2)
      if (needsSpace) text += ' '
    }

    const start = text.length
    text += str
    const entry: IndexedItem = { item, start, end: text.length, x, y, width, height }
    indexed.push(entry)
    previous = entry
  }

  return { text, items: indexed }
}

/** The bounding box covering the items a match spans. */
function boundsFor(
  pageText: PageText,
  matchStart: number,
  matchEnd: number,
): Omit<FieldRect, 'page'> | undefined {
  const touched = pageText.items.filter((entry) => entry.end > matchStart && entry.start < matchEnd)
  if (touched.length === 0) return undefined

  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY

  for (const entry of touched) {
    left = Math.min(left, entry.x)
    top = Math.min(top, entry.y)
    right = Math.max(right, entry.x + entry.width)
    bottom = Math.max(bottom, entry.y + entry.height)
  }

  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Reads and indexes the text of every page, once per document. */
export async function extractText(document: LoadedDocument): Promise<readonly PageText[]> {
  const pages: PageText[] = []

  for (let i = 0; i < document.pageCount; i += 1) {
    const page = await document.proxy.getPage(i + 1)
    const size = document.pageSizes[i] ?? { width: 612, height: 792 }
    try {
      const content = await page.getTextContent()
      pages.push(assemblePage(content.items, size))
    } finally {
      page.cleanup()
    }
  }

  return pages
}

/** Finds every occurrence of an anchor's text across the document. */
export function findAnchors(
  pages: readonly PageText[],
  anchor: AnchorPlacement,
): readonly AnchorMatch[] {
  const needle = anchor.caseSensitive ? anchor.text : anchor.text.toLowerCase()
  if (needle.length === 0) return []

  const matches: AnchorMatch[] = []

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const pageText = pages[pageIndex]
    if (!pageText) continue

    const haystack = anchor.caseSensitive ? pageText.text : pageText.text.toLowerCase()
    let from = 0

    while (true) {
      const at = haystack.indexOf(needle, from)
      if (at < 0) break
      const rect = boundsFor(pageText, at, at + needle.length)
      if (rect) {
        matches.push({
          page: pageIndex,
          rect,
          text: pageText.text.slice(at, at + needle.length),
        })
      }
      from = at + needle.length
    }
  }

  return matches
}

/**
 * Turns a match into a field rect, applying the anchor's offset and the
 * field's own size.
 *
 * `from` decides which edge the offset is measured from, which is what lets an
 * author say "to the right of this label" or "just below this line" without
 * knowing how wide the text happens to be.
 */
export function placeAtAnchor(
  match: AnchorMatch,
  anchor: AnchorPlacement,
  size: { width: number; height: number },
): FieldRect {
  const offsetX = anchor.offsetX ?? 0
  const offsetY = anchor.offsetY ?? 0
  const from = anchor.from ?? 'left'

  let x: number
  let y: number

  switch (from) {
    case 'left':
      x = match.rect.x + offsetX
      y = match.rect.y + offsetY
      break
    case 'right':
      x = match.rect.x + match.rect.width + offsetX
      y = match.rect.y + offsetY
      break
    case 'top':
      x = match.rect.x + offsetX
      y = match.rect.y - size.height + offsetY
      break
    case 'bottom':
      x = match.rect.x + offsetX
      y = match.rect.y + match.rect.height + offsetY
      break
  }

  return { page: match.page, x, y, width: size.width, height: size.height }
}

/**
 * Resolves every anchored field on an envelope into concrete coordinates.
 *
 * A field whose anchor names a specific occurrence yields one field. One that
 * does not yields a copy per occurrence, which is how "initial every page"
 * works: the author places one field against a footer that appears on every
 * page and gets a field on each.
 */
export function resolveAnchoredFields(
  fields: readonly Field[],
  pages: readonly PageText[],
  idFor: (field: Field, occurrence: number) => string,
): { resolved: readonly Field[]; unmatched: readonly Field[] } {
  const resolved: Field[] = []
  const unmatched: Field[] = []

  for (const field of fields) {
    if (!field.anchor) {
      resolved.push(field)
      continue
    }

    const matches = findAnchors(pages, field.anchor)
    if (matches.length === 0) {
      unmatched.push(field)
      continue
    }

    const wanted = field.anchor.occurrence
    const selected = wanted === undefined ? matches : matches.slice(wanted, wanted + 1)

    if (selected.length === 0) {
      unmatched.push(field)
      continue
    }

    selected.forEach((match, index) => {
      const rect = placeAtAnchor(match, field.anchor as AnchorPlacement, {
        width: field.rect.width,
        height: field.rect.height,
      })
      resolved.push({
        ...field,
        id: index === 0 ? field.id : idFor(field, index),
        rect,
      })
    })
  }

  return { resolved, unmatched }
}

/** Reads the text of a document and resolves its anchored fields in one pass. */
export async function applyAnchors(
  document: LoadedDocument,
  fields: readonly Field[],
  idFor: (field: Field, occurrence: number) => string = (field, i) => `${field.id}_${i}`,
): Promise<{ resolved: readonly Field[]; unmatched: readonly Field[] }> {
  const anchored = fields.some((field) => field.anchor)
  // Reading the text layer of a long document is not cheap, so skip it when
  // nothing needs it.
  if (!anchored) return { resolved: fields, unmatched: [] }

  const pages = await extractText(document)
  return resolveAnchoredFields(fields, pages, idFor)
}

/** Exposed for tests, which need to build a page without a real PDF. */
export const internals = { assemblePage }
