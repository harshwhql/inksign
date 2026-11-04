import type { Envelope, InkSignature, RecipientId } from '@inksign/core'
import {
  AuditTrail,
  createEnvelope,
  createSession,
  EnvelopeStore,
  MemoryIdentityAdapter,
  seal,
  verifySeal,
  verifyTrail,
} from '@inksign/core'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  applyAnchors,
  buildCertificate,
  loadDocument,
  mergeDocuments,
  setPdfJs,
  stampDocument,
} from '../src/index.js'

/**
 * End-to-end pipeline.
 *
 * The unit tests cover each stage, but the stages have to agree with each
 * other: anchors resolve against the text layer, the session writes values the
 * stamper can draw, and the seal has to verify over the bytes the stamper
 * actually produced. A regression in any of those seams passes every unit test
 * and still ships a broken product, so this walks the whole path.
 */

beforeAll(async () => {
  // pdf.js ships two builds. The default one reaches for DOM globals such as
  // DOMMatrix, so under Node it has to be the legacy build. `setPdfJs` exists
  // for exactly this: the library cannot know which build a host wants, and
  // guessing would break either the browser or the server.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  setPdfJs(pdfjs)
})

/** A two page agreement whose second page carries the signature block. */
async function sampleAgreement(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)

  const page1 = document.addPage([612, 792])
  page1.drawText('MUTUAL NONDISCLOSURE AGREEMENT', { x: 64, y: 720, size: 15, font: bold })
  page1.drawText('The parties agree to keep information confidential.', {
    x: 64,
    y: 680,
    size: 10,
    font,
  })

  const page2 = document.addPage([612, 792])
  page2.drawText('Agreed and accepted by the parties below.', { x: 64, y: 600, size: 10, font })
  page2.drawText('Authorized signature', { x: 64, y: 480, size: 8, font })
  page2.drawText('Date', { x: 340, y: 480, size: 8, font })
  page2.drawText('Printed name and title', { x: 64, y: 420, size: 8, font })

  return document.save()
}

const drawn: InkSignature = {
  source: 'drawn',
  width: 320,
  height: 96,
  paths: ['M 10 60 C 50 10 110 90 160 40 S 250 70 300 30'],
}

describe('full signing pipeline', () => {
  it('goes from a blank PDF to a sealed, verified document', async () => {
    // 1. The sender builds an envelope, placing fields by anchor text.
    const original = await sampleAgreement()
    const loaded = await loadDocument({ kind: 'bytes', bytes: original })

    expect(loaded.pageCount).toBe(2)
    expect(loaded.pageSizes[0]).toMatchObject({ width: 612, height: 792 })

    const draft = createEnvelope({ subject: 'Mutual NDA' })
      .document('nda', {
        name: 'NDA.pdf',
        source: { kind: 'bytes', bytes: original },
        pageCount: loaded.pageCount,
        pageSizes: loaded.pageSizes,
      })
      .signer('alice', {
        name: 'Alice Chen',
        email: 'alice@example.com',
        auth: { kind: 'access_code' },
      })
      .settings({ requireConsent: true })
      .field({
        recipient: 'alice',
        type: 'signature',
        anchor: { text: 'Authorized signature', from: 'top', offsetY: -6 },
        width: 200,
        height: 44,
        required: true,
        label: 'Signature',
      })
      .field({
        recipient: 'alice',
        type: 'date_signed',
        anchor: { text: 'Date', occurrence: 0, from: 'top', offsetY: -6 },
        width: 120,
        height: 16,
      })
      .field({
        recipient: 'alice',
        type: 'text',
        anchor: { text: 'Printed name and title', from: 'top', offsetY: -6 },
        width: 220,
        height: 16,
        label: 'Name and title',
        required: true,
      })
      .build({ validate: false })

    // 2. Anchors resolve against the real text layer.
    const { resolved, unmatched } = await applyAnchors(loaded, draft.fields)
    await loaded.destroy()

    expect(unmatched).toEqual([])
    expect(resolved).toHaveLength(3)

    // Every field landed on the signature page, above its label.
    for (const field of resolved) {
      expect(field.rect.page).toBe(1)
      expect(field.rect.y).toBeGreaterThan(0)
      expect(field.rect.x).toBeGreaterThan(0)
    }

    const signatureField = resolved.find((field) => field.type === 'signature')
    // 792 - 480 - 8 is roughly the label's top edge; the field sits above it.
    expect(signatureField?.rect.y).toBeLessThan(792 - 480)

    // 3. The recipient signs.
    const envelope: Envelope = {
      ...draft,
      fields: resolved,
      status: 'sent',
      sentAt: Date.now(),
    }
    const store = new EnvelopeStore(envelope)
    const trail = new AuditTrail(envelope.id)
    const aliceId = envelope.recipients[0]?.id as RecipientId

    await trail.append({ action: 'envelope_created' })
    await trail.append({ action: 'envelope_sent' })

    const identity = new MemoryIdentityAdapter(new Map([[aliceId, '4821']]))
    const session = createSession(store, aliceId, { adapters: { identity }, trail })

    expect(session.stage).toBe('authenticating')
    expect(await session.authenticate('wrong')).toBe(false)
    expect(await session.authenticate('4821')).toBe(true)

    expect(session.stage).toBe('consent')
    await session.acceptConsent()
    expect(session.stage).toBe('filling')

    // The date field filled itself.
    const dateField = session.assignedFields().find((field) => field.type === 'date_signed')
    expect(session.getValue(dateField?.id ?? '').kind).toBe('date')

    expect(session.canFinish()).toBe(false)
    await session.adoptSignature(drawn)

    const nameField = session.assignedFields().find((field) => field.label === 'Name and title')
    session.setValue(nameField?.id ?? '', { kind: 'text', value: 'Alice Chen, General Counsel' })

    expect(session.canFinish()).toBe(true)
    await session.finish()
    expect(store.getMeta().status).toBe('completed')

    // 4. The captured values are flattened into the PDF.
    const values = new Map(store.valueEntries())
    const stamped = await stampDocument({
      bytes: original,
      fields: resolved,
      values,
      metadata: { title: 'Signed NDA', envelopeId: envelope.id },
    })

    expect(stamped.byteLength).toBeGreaterThan(original.byteLength)
    const reopened = await PDFDocument.load(stamped)
    expect(reopened.getPageCount()).toBe(2)

    // 5. Seal over the finished artefacts.
    const finalEnvelope = store.toEnvelope()
    const sealed = await seal({
      envelope: finalEnvelope,
      values: Object.fromEntries(values),
      documents: [{ id: finalEnvelope.documents[0]?.id ?? 'd', bytes: stamped }],
      trail: trail.list(),
      secret: 'server-held-secret',
    })

    expect(sealed.digest).toHaveLength(64)
    expect(sealed.issuerSignature).toHaveLength(64)

    // 6. The certificate records it, and the whole thing verifies.
    const certificate = await buildCertificate({
      envelope: finalEnvelope,
      trail: trail.list(),
      seal: sealed,
      branding: { organizationName: 'Northwind Legal' },
    })

    const delivered = await mergeDocuments([stamped, certificate])
    const deliveredDoc = await PDFDocument.load(delivered)
    expect(deliveredDoc.getPageCount()).toBeGreaterThan(2)

    const trailCheck = await verifyTrail(trail.list())
    expect(trailCheck.valid).toBe(true)

    const sealCheck = await verifySeal(sealed, {
      envelope: finalEnvelope,
      values: Object.fromEntries(values),
      documents: [{ id: finalEnvelope.documents[0]?.id ?? 'd', bytes: stamped }],
      trail: trail.list(),
      secret: 'server-held-secret',
    })

    expect(sealCheck.valid).toBe(true)
    expect(sealCheck.checks).toMatchObject({
      digest: true,
      envelope: true,
      values: true,
      documents: true,
      trail: true,
      issuer: true,
    })
  })

  it('detects a document altered after sealing', async () => {
    const original = await sampleAgreement()
    const envelope = createEnvelope({ subject: 'Tamper check' })
      .document('d', {
        name: 'd.pdf',
        source: { kind: 'bytes', bytes: original },
        pageCount: 2,
      })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .field({ recipient: 'alice', type: 'signature', page: 1, x: 64, y: 300 })
      .build()

    const trail = new AuditTrail(envelope.id)
    await trail.append({ action: 'envelope_sent' })

    const stamped = await stampDocument({
      bytes: original,
      fields: envelope.fields,
      values: { [envelope.fields[0]?.id ?? 'f']: { kind: 'ink', value: drawn } },
    })

    const documentId = envelope.documents[0]?.id ?? 'd'
    const sealed = await seal({
      envelope,
      values: {},
      documents: [{ id: documentId, bytes: stamped }],
      trail: trail.list(),
    })

    // Someone adds a page after the fact.
    const tamperedDoc = await PDFDocument.load(stamped)
    tamperedDoc.addPage([612, 792])
    const tampered = await tamperedDoc.save()

    const check = await verifySeal(sealed, {
      envelope,
      values: {},
      documents: [{ id: documentId, bytes: tampered }],
      trail: trail.list(),
    })

    expect(check.valid).toBe(false)
    expect(check.checks.documents).toBe(false)
    expect(check.mismatchedDocuments).toEqual([documentId])
    expect(check.reason).toMatch(/Document bytes changed/u)
  })

  it('places a repeated anchor on every page it appears on', async () => {
    const document = await PDFDocument.create()
    const font = await document.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < 4; i += 1) {
      const page = document.addPage([612, 792])
      page.drawText('Initial here', { x: 64, y: 64, size: 8, font })
    }
    const bytes = await document.save()
    const loaded = await loadDocument({ kind: 'bytes', bytes })

    const draft = createEnvelope({ subject: 'Initial every page' })
      .document('d', { name: 'd.pdf', source: { kind: 'bytes', bytes }, pageCount: 4 })
      .signer('alice', { name: 'Alice', email: 'alice@example.com' })
      .field({
        recipient: 'alice',
        type: 'initials',
        anchor: { text: 'Initial here', from: 'right', offsetX: 8 },
        width: 44,
        height: 28,
      })
      .build({ validate: false })

    const { resolved } = await applyAnchors(loaded, draft.fields)
    await loaded.destroy()

    // One authored field becomes four, one per page.
    expect(resolved).toHaveLength(4)
    expect(resolved.map((field) => field.rect.page).sort()).toEqual([0, 1, 2, 3])
    // IDs stay unique, or the store would reject them.
    expect(new Set(resolved.map((field) => field.id)).size).toBe(4)
  })
})
