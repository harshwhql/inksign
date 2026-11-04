import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

/**
 * Generates a two page agreement to sign.
 *
 * Built at runtime rather than committed as a binary so the repository stays
 * text-only, and so the anchor text the example relies on is visible here
 * rather than hidden inside a PDF.
 */
export async function createSampleAgreement(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const body = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)

  const ink = rgb(0.08, 0.09, 0.11)
  const muted = rgb(0.42, 0.42, 0.47)
  const rule = rgb(0.86, 0.86, 0.88)

  const margin = 64
  const width = 612
  const height = 792

  const page1 = document.addPage([width, height])
  let y = height - margin

  page1.drawText('MUTUAL NONDISCLOSURE AGREEMENT', {
    x: margin,
    y,
    size: 15,
    font: bold,
    color: ink,
  })
  y -= 10
  page1.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 1.2,
    color: rule,
  })
  y -= 28

  const paragraphs: readonly (readonly [string, string])[] = [
    [
      '1. Purpose',
      'The parties wish to explore a business opportunity of mutual interest, and in connection with that discussion each may disclose to the other certain confidential technical and business information.',
    ],
    [
      '2. Definition',
      'Confidential Information means any information disclosed by one party to the other, either directly or indirectly, in writing, orally or by inspection of tangible objects, that is designated as confidential or would reasonably be understood to be confidential given its nature and the circumstances of disclosure.',
    ],
    [
      '3. Obligations',
      'Each party shall hold the other party Confidential Information in confidence, shall not disclose it to third parties, and shall not use it for any purpose outside the scope of the discussions described above. Each party shall take reasonable measures to protect the secrecy of the information, at least as protective as those it takes for its own confidential information.',
    ],
    [
      '4. Term',
      'The obligations in this agreement survive for three years from the date of disclosure, except that obligations with respect to trade secrets survive for as long as the information remains a trade secret.',
    ],
  ]

  for (const [heading, text] of paragraphs) {
    page1.drawText(heading, { x: margin, y, size: 10.5, font: bold, color: ink })
    y -= 16

    for (const line of wrap(text, body, 9.5, width - margin * 2)) {
      page1.drawText(line, { x: margin, y, size: 9.5, font: body, color: ink })
      y -= 14
    }
    y -= 12
  }

  page1.drawText('Page 1 of 2', {
    x: margin,
    y: margin - 20,
    size: 8,
    font: body,
    color: muted,
  })

  // Page two carries the signature block, which is what the example places
  // fields against.
  const page2 = document.addPage([width, height])
  y = height - margin

  page2.drawText('5. Governing law', { x: margin, y, size: 10.5, font: bold, color: ink })
  y -= 16
  for (const line of wrap(
    'This agreement is governed by the laws of the State of Delaware, without regard to its conflict of laws principles. Any dispute shall be resolved in the state or federal courts located in Delaware.',
    body,
    9.5,
    width - margin * 2,
  )) {
    page2.drawText(line, { x: margin, y, size: 9.5, font: body, color: ink })
    y -= 14
  }

  y -= 48
  page2.drawText('Agreed and accepted by the parties below.', {
    x: margin,
    y,
    size: 9.5,
    font: body,
    color: muted,
  })

  y -= 56

  // Two signature blocks. The labels double as anchor text.
  for (const party of ['Discloser', 'Recipient']) {
    page2.drawText(party.toUpperCase(), {
      x: margin,
      y,
      size: 8,
      font: bold,
      color: muted,
    })
    y -= 54

    page2.drawLine({
      start: { x: margin, y },
      end: { x: margin + 220, y },
      thickness: 0.75,
      color: rule,
    })
    page2.drawText('Authorized signature', {
      x: margin,
      y: y - 12,
      size: 8,
      font: body,
      color: muted,
    })

    page2.drawLine({
      start: { x: margin + 260, y },
      end: { x: margin + 400, y },
      thickness: 0.75,
      color: rule,
    })
    page2.drawText('Date', {
      x: margin + 260,
      y: y - 12,
      size: 8,
      font: body,
      color: muted,
    })

    y -= 34
    page2.drawLine({
      start: { x: margin, y },
      end: { x: margin + 220, y },
      thickness: 0.75,
      color: rule,
    })
    page2.drawText('Printed name and title', {
      x: margin,
      y: y - 12,
      size: 8,
      font: body,
      color: muted,
    })

    y -= 58
  }

  page2.drawText('Page 2 of 2', {
    x: margin,
    y: margin - 20,
    size: 8,
    font: body,
    color: muted,
  })

  return document.save()
}

interface Measurable {
  widthOfTextAtSize(text: string, size: number): number
}

/** Greedy word wrap against the measured font width. */
function wrap(text: string, font: Measurable, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/u)
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`
    if (font.widthOfTextAtSize(candidate, size) > maxWidth) {
      if (line.length > 0) lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line.length > 0) lines.push(line)
  return lines
}
