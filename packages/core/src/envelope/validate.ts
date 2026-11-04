import type { ValidationIssue, ValidationResult } from '../errors.js'
import { validateConditions } from '../fields/conditions.js'
import { describeField, isInkField } from '../fields/registry.js'
import { isBlockingRole, isPassiveRole } from '../recipients/routing.js'
import type { Envelope, Field, Recipient, RecipientId } from '../types.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/u

/**
 * Checks an envelope before it is sent.
 *
 * This is the last point at which a structural mistake is cheap to fix. Once
 * recipients have been notified, correcting a misassigned field means voiding
 * and reissuing, so the checks here are deliberately strict and the messages
 * name the offending part.
 */
export function validateEnvelope(envelope: Envelope): ValidationResult {
  const issues: ValidationIssue[] = []

  if (envelope.subject.trim().length === 0) {
    issues.push({
      code: 'INVALID_ENVELOPE',
      message: 'The envelope needs a subject',
      path: 'subject',
      severity: 'error',
    })
  }

  if (envelope.documents.length === 0) {
    issues.push({
      code: 'INVALID_ENVELOPE',
      message: 'The envelope needs at least one document',
      path: 'documents',
      severity: 'error',
    })
  }

  if (envelope.recipients.length === 0) {
    issues.push({
      code: 'INVALID_ENVELOPE',
      message: 'The envelope needs at least one recipient',
      path: 'recipients',
      severity: 'error',
    })
  }

  issues.push(...checkUniqueIds(envelope))
  issues.push(...checkRecipients(envelope.recipients))
  issues.push(...checkFields(envelope))
  issues.push(...validateConditions(new Map(envelope.fields.map((f) => [f.id, f]))))
  issues.push(...checkSigningWork(envelope))

  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
  }
}

function checkUniqueIds(envelope: Envelope): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const collections: readonly [string, readonly { id: string }[]][] = [
    ['documents', envelope.documents],
    ['recipients', envelope.recipients],
    ['fields', envelope.fields],
  ]

  for (const [name, items] of collections) {
    const seen = new Set<string>()
    for (const item of items) {
      if (seen.has(item.id)) {
        issues.push({
          code: 'INVALID_ENVELOPE',
          message: `Duplicate ${name.slice(0, -1)} id ${item.id}`,
          path: name,
          severity: 'error',
        })
      }
      seen.add(item.id)
    }
  }

  return issues
}

function checkRecipients(recipients: readonly Recipient[]): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const ids = new Set(recipients.map((r) => r.id))
  const seenContacts = new Set<string>()

  for (const recipient of recipients) {
    const path = `recipients.${recipient.id}`

    if (recipient.name.trim().length === 0) {
      issues.push({
        code: 'INVALID_ENVELOPE',
        message: 'Every recipient needs a name',
        path: `${path}.name`,
        severity: 'error',
      })
    }

    // An email is the usual delivery channel, but an in-person signer is
    // hosted on the sender's device and needs no address of their own.
    const needsContact = recipient.role !== 'in_person_signer'
    if (needsContact && !recipient.email && !recipient.phone) {
      issues.push({
        code: 'INVALID_ENVELOPE',
        message: `"${recipient.name}" needs an email address or a phone number`,
        path: `${path}.email`,
        severity: 'error',
      })
    }

    if (recipient.email && !EMAIL_PATTERN.test(recipient.email)) {
      issues.push({
        code: 'INVALID_ENVELOPE',
        message: `"${recipient.email}" is not a valid email address`,
        path: `${path}.email`,
        severity: 'error',
      })
    }

    // The same person twice at the same routing order usually means a mistake
    // in a template merge, but it is legal, so warn rather than reject.
    if (recipient.email) {
      const key = `${recipient.email.toLowerCase()}:${recipient.routingOrder}`
      if (seenContacts.has(key)) {
        issues.push({
          code: 'INVALID_ENVELOPE',
          message: `"${recipient.email}" appears more than once at routing order ${recipient.routingOrder}`,
          path: `${path}.email`,
          severity: 'warning',
        })
      }
      seenContacts.add(key)
    }

    if (!Number.isInteger(recipient.routingOrder) || recipient.routingOrder < 0) {
      issues.push({
        code: 'INVALID_ENVELOPE',
        message: 'Routing order must be a non-negative whole number',
        path: `${path}.routingOrder`,
        severity: 'error',
      })
    }

    if (recipient.attestsFor !== undefined) {
      if (!ids.has(recipient.attestsFor)) {
        issues.push({
          code: 'UNKNOWN_RECIPIENT',
          message: `"${recipient.name}" attests for recipient ${recipient.attestsFor}, who is not on this envelope`,
          path: `${path}.attestsFor`,
          severity: 'error',
        })
      }
      if (recipient.attestsFor === recipient.id) {
        issues.push({
          code: 'INVALID_ENVELOPE',
          message: `"${recipient.name}" cannot attest for themselves`,
          path: `${path}.attestsFor`,
          severity: 'error',
        })
      }
    }

    if ((recipient.role === 'witness' || recipient.role === 'notary') && !recipient.attestsFor) {
      issues.push({
        code: 'INVALID_ENVELOPE',
        message: `"${recipient.name}" is a ${recipient.role} but is not linked to the recipient they attest for`,
        path: `${path}.attestsFor`,
        severity: 'warning',
      })
    }
  }

  return issues
}

function checkFields(envelope: Envelope): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const documentIds = new Set(envelope.documents.map((d) => d.id))
  const recipients = new Map(envelope.recipients.map((r) => [r.id, r]))

  for (const field of envelope.fields) {
    const path = `fields.${field.id}`
    const name = field.label ?? field.id

    if (!documentIds.has(field.documentId)) {
      issues.push({
        code: 'UNKNOWN_DOCUMENT',
        message: `Field "${name}" is placed on document ${field.documentId}, which is not in this envelope`,
        path: `${path}.documentId`,
        fieldId: field.id,
        severity: 'error',
      })
    }

    if (field.recipientId !== undefined) {
      const recipient = recipients.get(field.recipientId)
      if (!recipient) {
        issues.push({
          code: 'UNKNOWN_RECIPIENT',
          message: `Field "${name}" is assigned to recipient ${field.recipientId}, who is not on this envelope`,
          path: `${path}.recipientId`,
          fieldId: field.id,
          severity: 'error',
        })
      } else if (isPassiveRole(recipient.role)) {
        issues.push({
          code: 'FIELD_NOT_ASSIGNED',
          message: `Field "${name}" is assigned to "${recipient.name}", who only receives a copy and cannot fill anything in`,
          path: `${path}.recipientId`,
          fieldId: field.id,
          severity: 'error',
        })
      }
    }

    issues.push(...checkGeometry(field, envelope, name))

    if ((field.type === 'dropdown' || field.type === 'radio_group') && !field.options?.length) {
      issues.push({
        code: 'INVALID_ENVELOPE',
        message: `Field "${name}" is a ${field.type} with no options`,
        path: `${path}.options`,
        fieldId: field.id,
        severity: 'error',
      })
    }

    if (field.options) {
      const values = new Set<string>()
      for (const option of field.options) {
        if (values.has(option.value)) {
          issues.push({
            code: 'INVALID_ENVELOPE',
            message: `Field "${name}" has a duplicate option value "${option.value}"`,
            path: `${path}.options`,
            fieldId: field.id,
            severity: 'error',
          })
        }
        values.add(option.value)
      }
      const defaults = field.options.filter((option) => option.default)
      if (field.type === 'radio_group' && defaults.length > 1) {
        issues.push({
          code: 'INVALID_ENVELOPE',
          message: `Field "${name}" has ${defaults.length} default options but a radio group allows one`,
          path: `${path}.options`,
          fieldId: field.id,
          severity: 'error',
        })
      }
    }

    if (field.validation?.pattern) {
      try {
        new RegExp(field.validation.pattern, 'u')
      } catch {
        issues.push({
          code: 'INVALID_ENVELOPE',
          message: `Field "${name}" has an invalid validation pattern`,
          path: `${path}.validation.pattern`,
          fieldId: field.id,
          severity: 'error',
        })
      }
    }

    const { minLength, maxLength, min, max } = field.validation ?? {}
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      issues.push({
        code: 'INVALID_ENVELOPE',
        message: `Field "${name}" has a minimum length above its maximum`,
        path: `${path}.validation`,
        fieldId: field.id,
        severity: 'error',
      })
    }
    if (min !== undefined && max !== undefined && min > max) {
      issues.push({
        code: 'INVALID_ENVELOPE',
        message: `Field "${name}" has a minimum above its maximum`,
        path: `${path}.validation`,
        fieldId: field.id,
        severity: 'error',
      })
    }

    if (isInkField(field.type) && field.recipientId === undefined) {
      issues.push({
        code: 'FIELD_NOT_ASSIGNED',
        message: `Field "${name}" captures a signature but is not assigned to a recipient`,
        path: `${path}.recipientId`,
        fieldId: field.id,
        severity: 'error',
      })
    }
  }

  return issues
}

function checkGeometry(
  field: Field,
  envelope: Envelope,
  name: string,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const path = `fields.${field.id}.rect`
  const { page, x, y, width, height } = field.rect

  // Anchored fields get their coordinates resolved against the text layer at
  // render time, so an unresolved placeholder rect is expected.
  const anchored = field.anchor !== undefined

  if (!Number.isInteger(page) || page < 0) {
    issues.push({
      code: 'INVALID_ENVELOPE',
      message: `Field "${name}" has page ${page}, which is not a valid page index`,
      path,
      fieldId: field.id,
      severity: 'error',
    })
    return issues
  }

  if (width <= 0 || height <= 0) {
    issues.push({
      code: 'INVALID_ENVELOPE',
      message: `Field "${name}" has no area (${width} by ${height})`,
      path,
      fieldId: field.id,
      severity: 'error',
    })
  }

  if (!anchored && (x < 0 || y < 0)) {
    issues.push({
      code: 'INVALID_ENVELOPE',
      message: `Field "${name}" sits off the top or left edge of the page`,
      path,
      fieldId: field.id,
      severity: 'error',
    })
  }

  const document = envelope.documents.find((d) => d.id === field.documentId)

  if (document?.pageCount !== undefined && page >= document.pageCount) {
    issues.push({
      code: 'INVALID_ENVELOPE',
      message: `Field "${name}" is on page ${page + 1} of a ${document.pageCount}-page document`,
      path,
      fieldId: field.id,
      severity: 'error',
    })
  }

  const pageSize = document?.pageSizes?.[page]
  if (pageSize && !anchored) {
    if (x + width > pageSize.width + 1 || y + height > pageSize.height + 1) {
      issues.push({
        code: 'INVALID_ENVELOPE',
        message: `Field "${name}" extends past the edge of page ${page + 1}`,
        path,
        fieldId: field.id,
        severity: 'warning',
      })
    }
  }

  const minimum = describeField(field.type).minSize
  if (width < minimum.width || height < minimum.height) {
    issues.push({
      code: 'INVALID_ENVELOPE',
      message: `Field "${name}" is smaller than the ${minimum.width} by ${minimum.height} point minimum for a ${field.type} and may be hard to use`,
      path,
      fieldId: field.id,
      severity: 'warning',
    })
  }

  return issues
}

/**
 * Catches the two mistakes that produce an envelope nobody can finish: a
 * signer with nothing to do, and a required field nobody owns.
 */
function checkSigningWork(envelope: Envelope): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const fieldsByRecipient = new Map<RecipientId, number>()
  for (const field of envelope.fields) {
    if (field.recipientId === undefined) continue
    fieldsByRecipient.set(field.recipientId, (fieldsByRecipient.get(field.recipientId) ?? 0) + 1)
  }

  for (const recipient of envelope.recipients) {
    if (!isBlockingRole(recipient.role)) continue
    // These roles act on the envelope itself rather than on fields.
    if (
      recipient.role === 'editor' ||
      recipient.role === 'intermediary' ||
      recipient.role === 'agent' ||
      recipient.role === 'approver'
    ) {
      continue
    }
    if ((fieldsByRecipient.get(recipient.id) ?? 0) === 0) {
      issues.push({
        code: 'INVALID_ENVELOPE',
        message: `"${recipient.name}" is a ${recipient.role} but has no fields to fill in, so they have nothing to do`,
        path: `recipients.${recipient.id}`,
        severity: 'warning',
      })
    }
  }

  for (const field of envelope.fields) {
    if (!field.validation?.required) continue
    if (field.recipientId === undefined && !field.readOnly) {
      issues.push({
        code: 'FIELD_NOT_ASSIGNED',
        message: `Field "${field.label ?? field.id}" is required but is not assigned to anyone, so the envelope can never complete`,
        path: `fields.${field.id}.recipientId`,
        fieldId: field.id,
        severity: 'error',
      })
    }
  }

  return issues
}
