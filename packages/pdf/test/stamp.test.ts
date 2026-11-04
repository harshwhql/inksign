import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { buildCertificate, mergeDocuments, stampDocument } from '../src/index.js'
import { AuditTrail, createEnvelope, seal } from '@inksign/core'
import type { Field, FieldValue, InkSignature } from '@inksign/core'

/** Builds a two-page PDF with some text, to stamp into. */
async function blankPdf(pages = 2): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)

  for (let i = 0; i < pages; i += 1) {
    const page = document.addPage([612, 792])
    page.drawText('Authorized signature', { x: 72, y: 150, size: 11, font })
  }
  return document.save()
}

const drawn: InkSignature = {
  source: 'drawn',
  width: 320,
  height: 96,
  paths: ['M 10 50 C 40 10 80 90 120 50', 'M 130 40 L 200 40'],
}

const typed: InkSignature = {
  source: 'typed',
  width: 200,
  height: 60,
  text: 'Alice Chen',
  typeface: 'Helvetica',
}

function field(over: Partial<Field> = {}): Field {
  return {
    id: 'fld_sig',
    documentId: 'doc_1',
    recipientId: 'rcp_1',
    type: 'signature',
    rect: { page: 0, x: 72, y: 600, width: 180, height: 48 },
    ...over,
  }
}

describe('stamping', () => {
  it('writes a valid PDF that still opens', async () => {
    const bytes = await blankPdf()
    const values: Record<string, FieldValue> = { fld_sig: { kind: 'ink', value: drawn } }

    const out = await stampDocument({ bytes, fields: [field()], values })

    expect(out.byteLength).toBeGreaterThan(0)
    const reopened = await PDFDocument.load(out)
    expect(reopened.getPageCount()).toBe(2)
  })

  it('grows the file, showing content was actually drawn', async () => {
    const bytes = await blankPdf(1)
    const empty = await stampDocument({ bytes, fields: [], values: {} })
    const stamped = await stampDocument({
      bytes,
      fields: [field()],
      values: { fld_sig: { kind: 'ink', value: drawn } },
    })

    expect(stamped.byteLength).toBeGreaterThan(empty.byteLength)
  })

  it('accepts values as a Map as well as an object', async () => {
    const bytes = await blankPdf(1)
    const out = await stampDocument({
      bytes,
      fields: [field()],
      values: new Map<string, FieldValue>([['fld_sig', { kind: 'ink', value: drawn }]]),
    })
    expect(out.byteLength).toBeGreaterThan(0)
  })

  it('skips fields with no value', async () => {
    const bytes = await blankPdf(1)
    const out = await stampDocument({ bytes, fields: [field()], values: {} })
    await expect(PDFDocument.load(out)).resolves.toBeDefined()
  })

  it('skips an explicitly empty value', async () => {
    const bytes = await blankPdf(1)
    const out = await stampDocument({
      bytes,
      fields: [field()],
      values: { fld_sig: { kind: 'empty' } },
    })
    await expect(PDFDocument.load(out)).resolves.toBeDefined()
  })

  it('stamps every field type without error', async () => {
    const bytes = await blankPdf(1)

    const fields: Field[] = [
      field({ id: 'sig', type: 'signature' }),
      field({ id: 'ini', type: 'initials', rect: { page: 0, x: 300, y: 600, width: 48, height: 32 } }),
      field({ id: 'txt', type: 'text', rect: { page: 0, x: 72, y: 500, width: 200, height: 18 } }),
      field({ id: 'num', type: 'number', rect: { page: 0, x: 72, y: 470, width: 80, height: 18 } }),
      field({ id: 'chk', type: 'checkbox', rect: { page: 0, x: 72, y: 440, width: 16, height: 16 } }),
      field({ id: 'dte', type: 'date_signed', rect: { page: 0, x: 72, y: 410, width: 120, height: 18 } }),
      field({ id: 'drp', type: 'dropdown', rect: { page: 0, x: 72, y: 380, width: 120, height: 18 } }),
    ]

    const values: Record<string, FieldValue> = {
      sig: { kind: 'ink', value: drawn },
      ini: { kind: 'ink', value: typed },
      txt: { kind: 'text', value: 'General Counsel' },
      num: { kind: 'number', value: 42000 },
      chk: { kind: 'boolean', value: true },
      dte: { kind: 'date', value: Date.UTC(2026, 10, 4) },
      drp: { kind: 'choice', value: 'Delaware' },
    }

    const out = await stampDocument({ bytes, fields, values, locale: 'en-US' })
    const reopened = await PDFDocument.load(out)
    expect(reopened.getPageCount()).toBe(1)
  })

  it('does not draw an unchecked checkbox', async () => {
    const bytes = await blankPdf(1)
    const checkbox = field({ id: 'chk', type: 'checkbox' })

    const checked = await stampDocument({
      bytes,
      fields: [checkbox],
      values: { chk: { kind: 'boolean', value: true } },
    })
    const unchecked = await stampDocument({
      bytes,
      fields: [checkbox],
      values: { chk: { kind: 'boolean', value: false } },
    })

    expect(checked.byteLength).toBeGreaterThan(unchecked.byteLength)
  })

  it('reports a field placed past the last page by name', async () => {
    const bytes = await blankPdf(1)
    const offEnd = field({ label: 'Counterparty signature', rect: { page: 4, x: 72, y: 600, width: 180, height: 48 } })

    await expect(
      stampDocument({ bytes, fields: [offEnd], values: { fld_sig: { kind: 'ink', value: drawn } } }),
    ).rejects.toThrowError(/Counterparty signature.*page 5.*has 1/u)
  })

  it('records the seal digest in the document metadata', async () => {
    const bytes = await blankPdf(1)
    const out = await stampDocument({
      bytes,
      fields: [field()],
      values: { fld_sig: { kind: 'ink', value: drawn } },
      metadata: {
        title: 'Signed NDA',
        envelopeId: 'env_123',
        sealDigest: 'a'.repeat(64),
      },
    })

    const reopened = await PDFDocument.load(out)
    expect(reopened.getTitle()).toBe('Signed NDA')
    expect(reopened.getKeywords()).toContain(`inksign-seal:${'a'.repeat(64)}`)
    expect(reopened.getKeywords()).toContain('inksign-envelope:env_123')
  })

  it('embeds a repeated signature once rather than per field', async () => {
    const bytes = await blankPdf(1)
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
    const raster: InkSignature = { source: 'uploaded', width: 1, height: 1, png }

    const one = await stampDocument({
      bytes,
      fields: [field({ id: 'a' })],
      values: { a: { kind: 'ink', value: raster } },
    })
    const ten = await stampDocument({
      bytes,
      fields: Array.from({ length: 10 }, (_, i) =>
        field({ id: `f${i}`, rect: { page: 0, x: 72, y: 100 + i * 50, width: 100, height: 40 } }),
      ),
      values: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`f${i}`, { kind: 'ink', value: raster }]),
      ) as Record<string, FieldValue>,
    })

    // Ten references to one embedded image, not ten embedded images.
    expect(ten.byteLength).toBeLessThan(one.byteLength * 2)
  })
})

describe('merging', () => {
  it('concatenates page counts', async () => {
    const merged = await mergeDocuments([await blankPdf(2), await blankPdf(3)])
    const reopened = await PDFDocument.load(merged)
    expect(reopened.getPageCount()).toBe(5)
  })

  it('returns the input unchanged for a single document', async () => {
    const one = await blankPdf(1)
    expect(await mergeDocuments([one])).toBe(one)
  })

  it('rejects an empty list', async () => {
    await expect(mergeDocuments([])).rejects.toThrowError(/at least one document/u)
  })
})

describe('certificate of completion', () => {
  async function fixture() {
    const envelope = createEnvelope({ subject: 'Mutual NDA' })
      .document('nda', {
        name: 'NDA.pdf',
        source: { kind: 'url', url: 'https://example.com/nda.pdf' },
        pageCount: 2,
      })
      .signer('alice', {
        name: 'Alice Chen',
        email: 'alice@example.com',
        auth: { kind: 'access_code' },
      })
      .carbonCopy('legal', { name: 'Legal Team', email: 'legal@example.com' })
      .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 600 })
      .build()

    const trail = new AuditTrail(envelope.id)
    await trail.append({ action: 'envelope_created' })
    await trail.append({ action: 'envelope_sent' })
    await trail.append({
      action: 'recipient_authenticated',
      recipientId: envelope.recipients[0]?.id,
      context: { ipAddress: '203.0.113.42', timeZone: 'Europe/London' },
    })
    await trail.append({ action: 'recipient_signed', recipientId: envelope.recipients[0]?.id })

    const sealed = await seal({
      envelope,
      values: {},
      documents: [{ id: envelope.documents[0]?.id ?? 'd', bytes: new Uint8Array([1, 2, 3]) }],
      trail: trail.list(),
    })

    return { envelope, trail, sealed }
  }

  it('produces a readable PDF', async () => {
    const { envelope, trail, sealed } = await fixture()
    const bytes = await buildCertificate({ envelope, trail: trail.list(), seal: sealed })

    const reopened = await PDFDocument.load(bytes)
    expect(reopened.getPageCount()).toBeGreaterThanOrEqual(1)
    expect(reopened.getTitle()).toContain('Mutual NDA')
    expect(reopened.getKeywords()).toContain(`inksign-seal:${sealed.digest}`)
  })

  it('works without a seal', async () => {
    const { envelope, trail } = await fixture()
    const bytes = await buildCertificate({ envelope, trail: trail.list() })
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined()
  })

  it('honours branding', async () => {
    const { envelope, trail } = await fixture()
    const bytes = await buildCertificate({
      envelope,
      trail: trail.list(),
      branding: {
        organizationName: 'Northwind Legal',
        title: 'Signing record',
        accentColor: '#7c3aed',
        footer: 'Questions? legal@northwind.example',
      },
    })

    const reopened = await PDFDocument.load(bytes)
    expect(reopened.getTitle()).toContain('Signing record')
  })

  it('omits the event table in summary mode', async () => {
    const { envelope, trail } = await fixture()
    const full = await buildCertificate({ envelope, trail: trail.list() })
    const summary = await buildCertificate({ envelope, trail: trail.list(), summaryOnly: true })

    expect(summary.byteLength).toBeLessThan(full.byteLength)
  })

  it('falls back to ISO timestamps for an invalid time zone', async () => {
    const { envelope, trail } = await fixture()
    const bytes = await buildCertificate({
      envelope,
      trail: trail.list(),
      timeZone: 'Not/AZone',
    })
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined()
  })

  it('survives a logo that will not decode', async () => {
    const { envelope, trail } = await fixture()
    const bytes = await buildCertificate({
      envelope,
      trail: trail.list(),
      branding: { logo: new Uint8Array([0, 1, 2, 3]) },
    })
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined()
  })
})
