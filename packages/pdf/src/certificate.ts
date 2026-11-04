import type { AuditEntry, Envelope, Seal } from '@inksign/core'
import { loadPdfLib, parseColor } from './stamp.js'

/**
 * Builds a certificate of completion.
 *
 * This is the page an auditor or a court reads: who signed, when, from where,
 * and under which digest. It restates what the audit trail already proves
 * cryptographically, in a form a person can check without tooling, and it
 * prints the seal digest so the file in hand can be tied back to the record.
 *
 * It is generated, never typed, so it cannot drift from the trail it reports.
 */

export interface CertificateBranding {
  /** Organization name in the header. */
  organizationName?: string
  /** PNG logo bytes, drawn at the top. Kept small; 240 points wide at most. */
  logo?: Uint8Array
  /** Accent colour as `#rrggbb`, used for rules and headings. */
  accentColor?: string
  /** Replaces the default "Certificate of completion" title. */
  title?: string
  /** Footer line, for a legal notice or a support address. */
  footer?: string
}

export interface CertificateOptions {
  envelope: Envelope
  trail: readonly AuditEntry[]
  seal?: Seal
  branding?: CertificateBranding
  locale?: string
  timeZone?: string
  /** Omit the per-event table and print only the summary. */
  summaryOnly?: boolean
}

const MARGIN = 54
const PAGE: [number, number] = [612, 792]

/** Renders the certificate as a standalone PDF. */
export async function buildCertificate(options: CertificateOptions): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib()
  const document = await PDFDocument.create()

  const regular = await document.embedFont(StandardFonts.Helvetica as string)
  const bold = await document.embedFont(StandardFonts.HelveticaBold as string)
  const mono = await document.embedFont(StandardFonts.Courier as string)

  const branding = options.branding ?? {}
  const accent = parseColor(branding.accentColor ?? '#1a1a2e', rgb)
  const ink = rgb(0.1, 0.1, 0.12)
  const muted = rgb(0.42, 0.42, 0.47)
  const hairline = rgb(0.86, 0.86, 0.88)

  const formatTime = buildTimeFormatter(options.locale, options.timeZone)

  let page = document.addPage(PAGE)
  let y = PAGE[1] - MARGIN

  const newPage = (): void => {
    page = document.addPage(PAGE)
    y = PAGE[1] - MARGIN
  }

  /** Reserves vertical space, starting a new page when it runs out. */
  const reserve = (height: number): void => {
    if (y - height < MARGIN) newPage()
  }

  const text = (
    value: string,
    options2: {
      size?: number
      font?: typeof regular
      color?: unknown
      x?: number
      indent?: number
    } = {},
  ): void => {
    const size = options2.size ?? 9.5
    page.drawText(value, {
      x: options2.x ?? MARGIN + (options2.indent ?? 0),
      y,
      size,
      font: options2.font ?? regular,
      color: options2.color ?? ink,
    })
  }

  // Header
  if (branding.logo) {
    try {
      const image = await document.embedPng(branding.logo)
      const width = Math.min(180, image.width)
      const height = (image.height / image.width) * width
      reserve(height + 12)
      page.drawImage(image, { x: MARGIN, y: y - height, width, height })
      y -= height + 18
    } catch {
      // A logo that will not decode must not stop the certificate being made.
    }
  }

  if (branding.organizationName) {
    text(branding.organizationName, { size: 9, font: bold, color: muted })
    y -= 16
  }

  text(branding.title ?? 'Certificate of completion', { size: 19, font: bold })
  y -= 26

  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE[0] - MARGIN, y },
    thickness: 1.4,
    color: accent,
  })
  y -= 22

  // Envelope summary
  const envelope = options.envelope
  const rows: readonly (readonly [string, string])[] = [
    ['Subject', envelope.subject],
    ['Envelope ID', envelope.id],
    ['Status', humanizeStatus(envelope.status)],
    ['Created', formatTime(envelope.createdAt)],
    ...(envelope.sentAt !== undefined
      ? ([['Sent', formatTime(envelope.sentAt)]] as const)
      : ([] as const)),
    ...(envelope.completedAt !== undefined
      ? ([['Completed', formatTime(envelope.completedAt)]] as const)
      : ([] as const)),
    ['Documents', String(envelope.documents.length)],
    ['Recipients', String(envelope.recipients.length)],
  ]

  for (const [label, value] of rows) {
    reserve(15)
    text(label, { size: 8.5, color: muted })
    text(value, { size: 9.5, x: MARGIN + 110 })
    y -= 15
  }

  if (envelope.voidReason) {
    reserve(15)
    text('Reason', { size: 8.5, color: muted })
    text(envelope.voidReason, { size: 9.5, x: MARGIN + 110 })
    y -= 15
  }

  y -= 12

  // Documents
  y = section(page, 'Documents', y, { bold, accent, hairline })
  for (const doc of envelope.documents) {
    reserve(24)
    text(doc.name, { size: 9.5, font: bold })
    y -= 12
    const detail = [
      doc.pageCount !== undefined ? `${doc.pageCount} pages` : undefined,
      doc.digest ? `SHA-256 ${doc.digest.slice(0, 16)}...` : undefined,
    ]
      .filter(Boolean)
      .join('   ')
    if (detail) {
      text(detail, { size: 8, font: mono, color: muted })
      y -= 14
    }
  }
  y -= 8

  // Recipients
  y = section(page, 'Recipients', y, { bold, accent, hairline })
  for (const recipient of envelope.recipients) {
    reserve(42)
    text(recipient.name, { size: 10, font: bold })
    text(humanizeStatus(recipient.status), {
      size: 8.5,
      color: muted,
      x: PAGE[0] - MARGIN - 90,
    })
    y -= 13

    const contact = [recipient.email, recipient.phone].filter(Boolean).join('   ')
    if (contact) {
      text(contact, { size: 8.5, color: muted })
      y -= 12
    }

    const meta = [
      `Role: ${humanizeRole(recipient.role)}`,
      `Order: ${recipient.routingOrder}`,
      recipient.completedAt !== undefined
        ? `Completed: ${formatTime(recipient.completedAt)}`
        : undefined,
      recipient.auth && recipient.auth.kind !== 'none'
        ? `Verified by: ${humanizeAuth(recipient.auth.kind)}`
        : undefined,
    ]
      .filter(Boolean)
      .join('   ')

    text(meta, { size: 8, color: muted })
    y -= 12

    if (recipient.declineReason) {
      text(`Declined: ${recipient.declineReason}`, { size: 8.5, color: muted })
      y -= 12
    }
    y -= 4
  }
  y -= 8

  // Seal
  if (options.seal) {
    y = section(page, 'Tamper-evident seal', y, { bold, accent, hairline })
    const seal = options.seal

    reserve(70)
    text('Sealed at', { size: 8.5, color: muted })
    text(formatTime(seal.sealedAt), { size: 9, x: MARGIN + 110 })
    y -= 14

    text('Seal digest', { size: 8.5, color: muted })
    y -= 12
    text(seal.digest, { size: 7.5, font: mono })
    y -= 16

    text('Audit chain head', { size: 8.5, color: muted })
    y -= 12
    text(seal.trailHead, { size: 7.5, font: mono })
    y -= 16

    text(`Covers ${seal.trailLength} audit entries.`, { size: 8, color: muted })
    y -= 12

    if (seal.issuerSignature) {
      text('Signed by the issuing service.', { size: 8, color: muted })
      y -= 12
    }
    if (seal.timestampAuthority) {
      text(`Timestamped by ${seal.timestampAuthority}.`, { size: 8, color: muted })
      y -= 12
    }
    y -= 8
  }

  // Audit trail
  if (!options.summaryOnly && options.trail.length > 0) {
    y = section(page, 'Audit trail', y, { bold, accent, hairline })
    const names = new Map(envelope.recipients.map((r) => [r.id, r.name]))

    for (const entry of options.trail) {
      reserve(26)

      text(formatTime(entry.at), { size: 7.5, font: mono, color: muted })
      text(humanizeAction(entry.action), { size: 9, x: MARGIN + 118 })
      y -= 11

      const who = entry.recipientId ? names.get(entry.recipientId) : undefined
      const where = [
        who,
        entry.context?.ipAddress ? `IP ${entry.context.ipAddress}` : undefined,
        entry.context?.timeZone,
      ]
        .filter(Boolean)
        .join('   ')

      if (where) {
        text(where, { size: 7.5, color: muted, x: MARGIN + 118 })
        y -= 11
      }
      y -= 3
    }
  }

  // Footer on every page
  const footerText =
    branding.footer ??
    'This certificate was generated from a hash-chained audit trail. Each entry commits to the one before it, so altering any entry invalidates every digest that follows.'

  const pages = document.getPages()
  for (const each of pages) {
    each.drawLine({
      start: { x: MARGIN, y: MARGIN - 14 },
      end: { x: PAGE[0] - MARGIN, y: MARGIN - 14 },
      thickness: 0.5,
      color: hairline,
    })
    each.drawText(wrap(footerText, 110)[0] ?? '', {
      x: MARGIN,
      y: MARGIN - 26,
      size: 6.8,
      font: regular,
      color: muted,
    })
    const second = wrap(footerText, 110)[1]
    if (second) {
      each.drawText(second, {
        x: MARGIN,
        y: MARGIN - 35,
        size: 6.8,
        font: regular,
        color: muted,
      })
    }
  }

  document.setTitle(`${branding.title ?? 'Certificate of completion'} - ${envelope.subject}`)
  document.setProducer('InkSign')
  document.setCreator('InkSign')
  if (options.seal) document.setKeywords([`inksign-seal:${options.seal.digest}`])

  return document.save({ useObjectStreams: true })
}

function section(
  page: {
    drawText(t: string, o: Record<string, unknown>): void
    drawLine(o: Record<string, unknown>): void
  },
  title: string,
  y: number,
  style: { bold: unknown; accent: unknown; hairline: unknown },
): number {
  page.drawText(title.toUpperCase(), {
    x: MARGIN,
    y,
    size: 8,
    font: style.bold,
    color: style.accent,
  })
  page.drawLine({
    start: { x: MARGIN, y: y - 6 },
    end: { x: PAGE[0] - MARGIN, y: y - 6 },
    thickness: 0.5,
    color: style.hairline,
  })
  return y - 20
}

function buildTimeFormatter(locale?: string, timeZone?: string): (at: number) => string {
  try {
    const formatter = new Intl.DateTimeFormat(locale ?? 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'long',
      ...(timeZone !== undefined ? { timeZone } : {}),
    })
    return (at) => formatter.format(at)
  } catch {
    // An invalid time zone must not stop the certificate being produced.
    return (at) => new Date(at).toISOString()
  }
}

function humanizeStatus(status: string): string {
  return status.replace(/_/gu, ' ').replace(/^./u, (c) => c.toUpperCase())
}

function humanizeRole(role: string): string {
  return role.replace(/_/gu, ' ')
}

function humanizeAuth(kind: string): string {
  const labels: Record<string, string> = {
    access_code: 'access code',
    sms: 'SMS code',
    phone_call: 'phone call',
    knowledge_based: 'knowledge-based questions',
    id_verification: 'government ID',
    federated: 'single sign-on',
  }
  return labels[kind] ?? kind.replace(/_/gu, ' ')
}

function humanizeAction(action: string): string {
  const labels: Record<string, string> = {
    envelope_created: 'Envelope created',
    envelope_sent: 'Envelope sent',
    envelope_completed: 'Envelope completed',
    envelope_voided: 'Envelope voided',
    envelope_expired: 'Envelope expired',
    envelope_sealed: 'Envelope sealed',
    document_added: 'Document added',
    document_viewed: 'Document viewed',
    document_downloaded: 'Document downloaded',
    document_printed: 'Document printed',
    recipient_added: 'Recipient added',
    recipient_notified: 'Recipient notified',
    recipient_opened: 'Recipient opened the envelope',
    recipient_authenticated: 'Identity verified',
    recipient_auth_failed: 'Identity verification failed',
    consent_accepted: 'Electronic record disclosure accepted',
    consent_declined: 'Electronic record disclosure declined',
    signature_adopted: 'Signature adopted',
    field_filled: 'Field completed',
    field_cleared: 'Field cleared',
    recipient_signed: 'Signed',
    recipient_declined: 'Declined to sign',
    recipient_delegated: 'Delegated to another signer',
    reminder_sent: 'Reminder sent',
    seal_verified: 'Seal verified',
  }
  return labels[action] ?? humanizeStatus(action)
}

/** Naive word wrap, adequate for the fixed-width footer. */
function wrap(text: string, width: number): readonly string[] {
  const words = text.split(/\s+/u)
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else {
      line = line.length === 0 ? word : `${line} ${word}`
    }
  }
  if (line.length > 0) lines.push(line)
  return lines
}
