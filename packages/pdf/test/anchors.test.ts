import { describe, expect, it } from 'vitest'
import {
  anchorInternals,
  findAnchors,
  placeAtAnchor,
  resolveAnchoredFields,
} from '../src/index.js'
import type { Field, PageSize } from '@inksign/core'
import type { PdfTextItem } from '../src/loader.js'

const page: PageSize = { width: 612, height: 792 }

/**
 * Builds a pdf.js-shaped text item. The transform carries the baseline
 * position in PDF space, where y measures up from the bottom of the page.
 */
function item(str: string, x: number, baselineY: number, width: number, height = 10): PdfTextItem {
  return { str, transform: [height, 0, 0, height, x, baselineY], width, height }
}

function assemble(items: readonly PdfTextItem[]) {
  return anchorInternals.assemblePage(items, page)
}

describe('text assembly', () => {
  it('joins adjacent runs without inventing a space', () => {
    // "Sig" and "nature" are one word split across two glyph runs.
    const assembled = assemble([item('Sig', 72, 700, 18), item('nature', 90, 700, 36)])
    expect(assembled.text).toBe('Signature')
  })

  it('inserts a space where the horizontal gap implies a word break', () => {
    const assembled = assemble([
      item('Authorized', 72, 700, 60),
      item('signature', 140, 700, 54),
    ])
    expect(assembled.text).toBe('Authorized signature')
  })

  it('inserts a space when the text moves to another line', () => {
    const assembled = assemble([item('first', 72, 700, 30), item('second', 72, 680, 36)])
    expect(assembled.text).toBe('first second')
  })

  it('converts the baseline to a top edge in field space', () => {
    const assembled = assemble([item('Hello', 72, 700, 30, 10)])
    const entry = assembled.items[0]
    // 792 - 700 - 10 = 82 points from the top.
    expect(entry?.y).toBeCloseTo(82)
  })

  it('skips items with no usable transform', () => {
    const assembled = assemble([{ str: 'orphan' }, item('kept', 72, 700, 24)])
    expect(assembled.text).toBe('kept')
  })

  it('does not double a space that is already there', () => {
    const assembled = assemble([item('Sign ', 72, 700, 30), item('here', 110, 700, 24)])
    expect(assembled.text).toBe('Sign here')
  })
})

describe('finding anchors', () => {
  const pages = [
    assemble([item('Authorized', 72, 700, 60), item('signature', 140, 700, 54)]),
    assemble([item('Authorized', 72, 600, 60), item('signature', 140, 600, 54)]),
  ]

  it('finds a match on each page', () => {
    const matches = findAnchors(pages, { text: 'Authorized signature' })
    expect(matches).toHaveLength(2)
    expect(matches[0]?.page).toBe(0)
    expect(matches[1]?.page).toBe(1)
  })

  it('ignores case by default', () => {
    expect(findAnchors(pages, { text: 'authorized SIGNATURE' })).toHaveLength(2)
  })

  it('respects caseSensitive', () => {
    expect(
      findAnchors(pages, { text: 'authorized signature', caseSensitive: true }),
    ).toHaveLength(0)
  })

  it('returns a bounding box spanning every matched run', () => {
    const match = findAnchors(pages, { text: 'Authorized signature' })[0]
    expect(match?.rect.x).toBeCloseTo(72)
    // From the left edge of "Authorized" to the right edge of "signature".
    expect(match?.rect.width).toBeCloseTo(140 + 54 - 72)
  })

  it('finds repeated occurrences on one page', () => {
    const repeated = [
      assemble([item('Initial', 72, 700, 36), item('Initial', 300, 700, 36)]),
    ]
    expect(findAnchors(repeated, { text: 'Initial' })).toHaveLength(2)
  })

  it('returns nothing for text that is absent', () => {
    expect(findAnchors(pages, { text: 'Notary seal' })).toHaveLength(0)
  })

  it('returns nothing for empty anchor text', () => {
    expect(findAnchors(pages, { text: '' })).toHaveLength(0)
  })
})

describe('placing at an anchor', () => {
  const match = {
    page: 0,
    rect: { x: 100, y: 200, width: 80, height: 10 },
    text: 'Sign here',
  }
  const size = { width: 160, height: 40 }

  it('offsets from the left edge by default', () => {
    const rect = placeAtAnchor(match, { text: 'Sign here' }, size)
    expect(rect).toEqual({ page: 0, x: 100, y: 200, width: 160, height: 40 })
  })

  it('places to the right of the text', () => {
    const rect = placeAtAnchor(match, { text: 'Sign here', from: 'right', offsetX: 6 }, size)
    expect(rect.x).toBe(186)
  })

  it('places below the text', () => {
    const rect = placeAtAnchor(match, { text: 'Sign here', from: 'bottom', offsetY: 4 }, size)
    expect(rect.y).toBe(214)
  })

  it('places above the text, clearing the field height', () => {
    const rect = placeAtAnchor(match, { text: 'Sign here', from: 'top' }, size)
    // Sits directly on top: 200 minus the 40 point field height.
    expect(rect.y).toBe(160)
  })
})

describe('resolving anchored fields', () => {
  const pages = [
    assemble([item('Initial', 72, 60, 36)]),
    assemble([item('Initial', 72, 60, 36)]),
    assemble([item('Initial', 72, 60, 36)]),
  ]

  const anchored: Field = {
    id: 'fld_1',
    documentId: 'doc_1',
    recipientId: 'rcp_1',
    type: 'initials',
    rect: { page: 0, x: 0, y: 0, width: 44, height: 28 },
    anchor: { text: 'Initial', from: 'right', offsetX: 8 },
  }

  it('expands one field into a copy per occurrence', () => {
    const { resolved, unmatched } = resolveAnchoredFields([anchored], pages, (f, i) => `${f.id}_${i}`)

    expect(unmatched).toHaveLength(0)
    expect(resolved).toHaveLength(3)
    expect(resolved.map((f) => f.rect.page)).toEqual([0, 1, 2])
    // The first keeps the original ID so existing references still resolve.
    expect(resolved[0]?.id).toBe('fld_1')
    expect(resolved[1]?.id).toBe('fld_1_1')
  })

  it('binds to a single occurrence when one is named', () => {
    const single: Field = { ...anchored, anchor: { text: 'Initial', occurrence: 1 } }
    const { resolved } = resolveAnchoredFields([single], pages, (f, i) => `${f.id}_${i}`)

    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.rect.page).toBe(1)
  })

  it('reports a field whose anchor text is missing', () => {
    const missing: Field = { ...anchored, anchor: { text: 'Nowhere' } }
    const { resolved, unmatched } = resolveAnchoredFields([missing], pages, (f, i) => `${f.id}_${i}`)

    expect(resolved).toHaveLength(0)
    expect(unmatched).toHaveLength(1)
  })

  it('reports a field whose named occurrence is out of range', () => {
    const tooFar: Field = { ...anchored, anchor: { text: 'Initial', occurrence: 9 } }
    const { unmatched } = resolveAnchoredFields([tooFar], pages, (f, i) => `${f.id}_${i}`)
    expect(unmatched).toHaveLength(1)
  })

  it('passes unanchored fields through unchanged', () => {
    const plain: Field = {
      id: 'fld_2',
      documentId: 'doc_1',
      type: 'signature',
      rect: { page: 0, x: 72, y: 600, width: 160, height: 40 },
    }
    const { resolved } = resolveAnchoredFields([plain], pages, (f, i) => `${f.id}_${i}`)
    expect(resolved).toEqual([plain])
  })
})
