import { describe, expect, it } from 'vitest'
import type { Envelope, Field, Recipient } from '../src/index.js'
import { createEnvelope, defaultSettings, validateEnvelope, withDefaults } from '../src/index.js'

/**
 * Sender-side validation.
 *
 * This is the last point at which a structural mistake is cheap. Once
 * recipients have been notified, fixing a misassigned field means voiding and
 * reissuing, so every rule here is worth a test: a gap lets an envelope reach
 * a signer who then cannot complete it.
 */

const source = { kind: 'url' as const, url: 'https://example.com/a.pdf' }

/** A valid envelope, which each test then breaks in exactly one way. */
function base(): Envelope {
  return createEnvelope({ subject: 'Mutual NDA' })
    .document('d', { name: 'd.pdf', source, pageCount: 2 })
    .signer('alice', { name: 'Alice Chen', email: 'alice@example.com' })
    .field({ recipient: 'alice', type: 'signature', page: 0, x: 72, y: 600, required: true })
    .build()
}

const errors = (envelope: Envelope): readonly string[] =>
  validateEnvelope(envelope)
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message)

const warnings = (envelope: Envelope): readonly string[] =>
  validateEnvelope(envelope)
    .issues.filter((issue) => issue.severity === 'warning')
    .map((issue) => issue.message)

const codes = (envelope: Envelope): readonly string[] =>
  validateEnvelope(envelope).issues.map((issue) => issue.code)

describe('baseline', () => {
  it('accepts a well-formed envelope with no issues at all', () => {
    const result = validateEnvelope(base())
    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('reports valid when only warnings are present', () => {
    const envelope = base()
    const withWarning: Envelope = {
      ...envelope,
      recipients: [
        ...envelope.recipients,
        {
          id: 'rcp_idle',
          role: 'signer',
          name: 'Idle Signer',
          email: 'idle@example.com',
          routingOrder: 2,
          status: 'created',
        },
      ],
    }
    const result = validateEnvelope(withWarning)
    expect(result.valid).toBe(true)
    expect(result.issues.some((issue) => issue.severity === 'warning')).toBe(true)
  })
})

describe('envelope shape', () => {
  it('requires a subject', () => {
    expect(errors({ ...base(), subject: '' })).toContain('The envelope needs a subject')
    expect(errors({ ...base(), subject: '   ' })).toContain('The envelope needs a subject')
  })

  it('requires a document', () => {
    expect(errors({ ...base(), documents: [], fields: [] })).toContain(
      'The envelope needs at least one document',
    )
  })

  it('requires a recipient', () => {
    expect(errors({ ...base(), recipients: [], fields: [] })).toContain(
      'The envelope needs at least one recipient',
    )
  })

  it('rejects duplicate ids in any collection', () => {
    const envelope = base()
    const field = envelope.fields[0] as Field

    expect(
      errors({ ...envelope, fields: [field, field] }).some((m) => m.includes('Duplicate field id')),
    ).toBe(true)

    const recipient = envelope.recipients[0] as Recipient
    expect(
      errors({ ...envelope, recipients: [recipient, recipient] }).some((m) =>
        m.includes('Duplicate recipient id'),
      ),
    ).toBe(true)
  })
})

describe('recipients', () => {
  const withRecipient = (over: Partial<Recipient>): Envelope => {
    const envelope = base()
    const recipient = envelope.recipients[0] as Recipient
    return { ...envelope, recipients: [{ ...recipient, ...over }] }
  }

  it('requires a name', () => {
    expect(errors(withRecipient({ name: '' }))).toContain('Every recipient needs a name')
  })

  it('requires an email or a phone number', () => {
    const noContact = withRecipient({ email: undefined })
    expect(errors(noContact).some((m) => m.includes('needs an email address or a phone'))).toBe(
      true,
    )
  })

  it('accepts a phone number instead of an email', () => {
    const byPhone = withRecipient({ email: undefined, phone: '+15555550123' })
    expect(errors(byPhone)).toEqual([])
  })

  it('does not require contact details for an in-person signer', () => {
    // Hosted on the sender's device, so they have no address of their own.
    const inPerson = withRecipient({ role: 'in_person_signer', email: undefined })
    expect(errors(inPerson)).toEqual([])
  })

  it('rejects a malformed email', () => {
    for (const bad of ['alice', 'alice@', 'alice@example', '@example.com']) {
      expect(
        errors(withRecipient({ email: bad })).some((m) => m.includes('not a valid email')),
      ).toBe(true)
    }
  })

  it('rejects a negative or fractional routing order', () => {
    expect(
      errors(withRecipient({ routingOrder: -1 })).some((m) => m.includes('non-negative')),
    ).toBe(true)
    expect(
      errors(withRecipient({ routingOrder: 1.5 })).some((m) => m.includes('non-negative')),
    ).toBe(true)
  })

  it('warns when the same address appears twice at one routing order', () => {
    const envelope = base()
    const recipient = envelope.recipients[0] as Recipient
    const twice: Envelope = {
      ...envelope,
      recipients: [recipient, { ...recipient, id: 'rcp_2', routingOrder: recipient.routingOrder }],
    }
    expect(warnings(twice).some((m) => m.includes('appears more than once'))).toBe(true)
  })

  it('allows the same person at different routing orders', () => {
    // Signing twice in sequence is legal, for example as signer then witness.
    const envelope = base()
    const recipient = envelope.recipients[0] as Recipient
    const twice: Envelope = {
      ...envelope,
      recipients: [recipient, { ...recipient, id: 'rcp_2', routingOrder: 2 }],
    }
    expect(warnings(twice).some((m) => m.includes('appears more than once'))).toBe(false)
  })

  describe('attestation', () => {
    it('rejects attesting for someone not on the envelope', () => {
      const envelope = base()
      const witness: Recipient = {
        id: 'rcp_w',
        role: 'witness',
        name: 'Wendy Witness',
        email: 'wendy@example.com',
        routingOrder: 2,
        status: 'created',
        attestsFor: 'rcp_ghost',
      }
      expect(codes({ ...envelope, recipients: [...envelope.recipients, witness] })).toContain(
        'UNKNOWN_RECIPIENT',
      )
    })

    it('rejects attesting for oneself', () => {
      const envelope = base()
      const witness: Recipient = {
        id: 'rcp_w',
        role: 'witness',
        name: 'Wendy Witness',
        email: 'wendy@example.com',
        routingOrder: 2,
        status: 'created',
        attestsFor: 'rcp_w',
      }
      expect(
        errors({ ...envelope, recipients: [...envelope.recipients, witness] }).some((m) =>
          m.includes('cannot attest for themselves'),
        ),
      ).toBe(true)
    })

    it('warns about a witness with nobody to attest for', () => {
      const envelope = base()
      const witness: Recipient = {
        id: 'rcp_w',
        role: 'witness',
        name: 'Wendy Witness',
        email: 'wendy@example.com',
        routingOrder: 2,
        status: 'created',
      }
      expect(
        warnings({ ...envelope, recipients: [...envelope.recipients, witness] }).some((m) =>
          m.includes('not linked to the recipient they attest for'),
        ),
      ).toBe(true)
    })

    it('accepts a properly linked witness', () => {
      const envelope = base()
      const signer = envelope.recipients[0] as Recipient
      const witness: Recipient = {
        id: 'rcp_w',
        role: 'witness',
        name: 'Wendy Witness',
        email: 'wendy@example.com',
        routingOrder: 2,
        status: 'created',
        attestsFor: signer.id,
      }
      const field: Field = {
        id: 'fld_w',
        documentId: envelope.documents[0]?.id ?? 'd',
        recipientId: 'rcp_w',
        type: 'signature',
        rect: { page: 0, x: 300, y: 600, width: 160, height: 40 },
      }
      const result = validateEnvelope({
        ...envelope,
        recipients: [...envelope.recipients, witness],
        fields: [...envelope.fields, field],
      })
      expect(result.valid).toBe(true)
    })
  })
})

describe('fields', () => {
  const withField = (over: Partial<Field>): Envelope => {
    const envelope = base()
    const field = envelope.fields[0] as Field
    return { ...envelope, fields: [{ ...field, ...over }] }
  }

  it('rejects a field on a document that is not in the envelope', () => {
    expect(codes(withField({ documentId: 'doc_ghost' }))).toContain('UNKNOWN_DOCUMENT')
  })

  it('rejects a field assigned to someone not on the envelope', () => {
    expect(codes(withField({ recipientId: 'rcp_ghost' }))).toContain('UNKNOWN_RECIPIENT')
  })

  describe('geometry', () => {
    it('rejects a negative page index', () => {
      expect(
        errors(withField({ rect: { page: -1, x: 0, y: 0, width: 100, height: 40 } })).some((m) =>
          m.includes('not a valid page index'),
        ),
      ).toBe(true)
    })

    it('rejects a fractional page index', () => {
      expect(
        errors(withField({ rect: { page: 1.5, x: 0, y: 0, width: 100, height: 40 } })).some((m) =>
          m.includes('not a valid page index'),
        ),
      ).toBe(true)
    })

    it('rejects a field with no area', () => {
      expect(
        errors(withField({ rect: { page: 0, x: 10, y: 10, width: 0, height: 40 } })).some((m) =>
          m.includes('has no area'),
        ),
      ).toBe(true)
      expect(
        errors(withField({ rect: { page: 0, x: 10, y: 10, width: 100, height: -5 } })).some((m) =>
          m.includes('has no area'),
        ),
      ).toBe(true)
    })

    it('rejects a field off the top or left edge', () => {
      expect(
        errors(withField({ rect: { page: 0, x: -10, y: 10, width: 100, height: 40 } })).some((m) =>
          m.includes('off the top or left edge'),
        ),
      ).toBe(true)
    })

    it('allows an anchored field to sit at a placeholder position', () => {
      // Anchored coordinates are resolved against the text layer later, so an
      // unresolved placeholder is expected rather than wrong.
      const anchored = withField({
        rect: { page: 0, x: -1, y: -1, width: 160, height: 40 },
        anchor: { text: 'Authorized signature' },
      })
      expect(errors(anchored).some((m) => m.includes('off the top or left edge'))).toBe(false)
    })

    it('rejects a field past the last page', () => {
      expect(
        errors(withField({ rect: { page: 5, x: 10, y: 10, width: 100, height: 40 } })).some((m) =>
          m.includes('page 6 of a 2-page document'),
        ),
      ).toBe(true)
    })

    it('warns when a field extends past the page edge', () => {
      const envelope = base()
      const sized: Envelope = {
        ...envelope,
        documents: [
          {
            ...(envelope.documents[0] as Envelope['documents'][number]),
            pageSizes: [
              { width: 612, height: 792 },
              { width: 612, height: 792 },
            ],
          },
        ],
        fields: [
          {
            ...(envelope.fields[0] as Field),
            rect: { page: 0, x: 580, y: 10, width: 160, height: 40 },
          },
        ],
      }
      expect(warnings(sized).some((m) => m.includes('past the edge of page 1'))).toBe(true)
    })

    it('warns about a field below the usable minimum size', () => {
      expect(
        warnings(withField({ rect: { page: 0, x: 10, y: 10, width: 20, height: 6 } })).some((m) =>
          m.includes('smaller than'),
        ),
      ).toBe(true)
    })
  })

  describe('options', () => {
    const optioned = (options: Field['options']): Envelope => {
      const envelope = base()
      const extra: Field = {
        id: 'fld_opt',
        documentId: envelope.documents[0]?.id ?? 'd',
        recipientId: envelope.recipients[0]?.id,
        type: 'dropdown',
        rect: { page: 0, x: 72, y: 400, width: 160, height: 18 },
        label: 'State',
        ...(options !== undefined ? { options } : {}),
      }
      return { ...envelope, fields: [...envelope.fields, extra] }
    }

    it('rejects a dropdown with no options', () => {
      expect(errors(optioned(undefined)).some((m) => m.includes('with no options'))).toBe(true)
      expect(errors(optioned([])).some((m) => m.includes('with no options'))).toBe(true)
    })

    it('rejects duplicate option values', () => {
      expect(
        errors(optioned([{ value: 'de' }, { value: 'de' }])).some((m) =>
          m.includes('duplicate option value'),
        ),
      ).toBe(true)
    })

    it('accepts a well-formed option list', () => {
      expect(errors(optioned([{ value: 'de' }, { value: 'ny' }]))).toEqual([])
    })

    it('rejects a radio group with more than one default', () => {
      const envelope = base()
      const radio: Field = {
        id: 'fld_radio',
        documentId: envelope.documents[0]?.id ?? 'd',
        recipientId: envelope.recipients[0]?.id,
        type: 'radio_group',
        rect: { page: 0, x: 72, y: 400, width: 160, height: 18 },
        options: [
          { value: 'a', default: true },
          { value: 'b', default: true },
        ],
      }
      expect(
        errors({ ...envelope, fields: [...envelope.fields, radio] }).some((m) =>
          m.includes('default options but a radio group allows one'),
        ),
      ).toBe(true)
    })
  })

  describe('validation rules', () => {
    it('rejects an unparseable pattern', () => {
      expect(
        errors(withField({ validation: { pattern: '([unclosed' } })).some((m) =>
          m.includes('invalid validation pattern'),
        ),
      ).toBe(true)
    })

    it('accepts a valid pattern', () => {
      expect(errors(withField({ validation: { pattern: '^[0-9]{5}$' } }))).toEqual([])
    })

    it('rejects a minimum length above the maximum', () => {
      expect(
        errors(withField({ validation: { minLength: 10, maxLength: 5 } })).some((m) =>
          m.includes('minimum length above its maximum'),
        ),
      ).toBe(true)
    })

    it('rejects a minimum above the maximum', () => {
      expect(
        errors(withField({ validation: { min: 100, max: 10 } })).some((m) =>
          m.includes('minimum above its maximum'),
        ),
      ).toBe(true)
    })

    it('accepts equal bounds', () => {
      expect(errors(withField({ validation: { min: 10, max: 10 } }))).toEqual([])
    })
  })
})

describe('completability', () => {
  it('rejects a required field nobody owns', () => {
    const envelope = base()
    const orphan: Field = {
      id: 'fld_orphan',
      documentId: envelope.documents[0]?.id ?? 'd',
      type: 'text',
      rect: { page: 0, x: 72, y: 400, width: 160, height: 18 },
      label: 'Counterparty reference',
      validation: { required: true },
    }
    expect(
      errors({ ...envelope, fields: [...envelope.fields, orphan] }).some((m) =>
        m.includes('never complete'),
      ),
    ).toBe(true)
  })

  it('allows a required read-only field the sender fills in', () => {
    const envelope = base()
    const senderFilled: Field = {
      id: 'fld_ro',
      documentId: envelope.documents[0]?.id ?? 'd',
      type: 'text',
      rect: { page: 0, x: 72, y: 400, width: 160, height: 18 },
      readOnly: true,
      validation: { required: true },
    }
    expect(
      errors({ ...envelope, fields: [...envelope.fields, senderFilled] }).some((m) =>
        m.includes('never complete'),
      ),
    ).toBe(false)
  })

  it('warns about a signer with no fields', () => {
    const envelope = base()
    const idle: Recipient = {
      id: 'rcp_idle',
      role: 'signer',
      name: 'Idle Signer',
      email: 'idle@example.com',
      routingOrder: 2,
      status: 'created',
    }
    expect(
      warnings({ ...envelope, recipients: [...envelope.recipients, idle] }).some((m) =>
        m.includes('nothing to do'),
      ),
    ).toBe(true)
  })

  it('does not warn about roles that act on the envelope rather than on fields', () => {
    const envelope = base()
    for (const role of ['approver', 'editor', 'intermediary', 'agent'] as const) {
      const actor: Recipient = {
        id: `rcp_${role}`,
        role,
        name: `The ${role}`,
        email: `${role}@example.com`,
        routingOrder: 2,
        status: 'created',
      }
      expect(
        warnings({ ...envelope, recipients: [...envelope.recipients, actor] }).some((m) =>
          m.includes('nothing to do'),
        ),
      ).toBe(false)
    }
  })

  it('does not warn about a carbon copy with no fields', () => {
    const envelope = base()
    const cc: Recipient = {
      id: 'rcp_cc',
      role: 'carbon_copy',
      name: 'Legal Team',
      email: 'legal@example.com',
      routingOrder: 2,
      status: 'created',
    }
    expect(
      warnings({ ...envelope, recipients: [...envelope.recipients, cc] }).some((m) =>
        m.includes('nothing to do'),
      ),
    ).toBe(false)
  })

  it('rejects an unassigned ink field', () => {
    const envelope = base()
    // Built without a recipientId rather than by deleting one, so the field
    // genuinely lacks the key instead of carrying an explicit undefined.
    const { recipientId: _assigned, ...rest } = envelope.fields[0] as Field
    const unassigned: Field = { ...rest, id: 'fld_unassigned' }

    expect(codes({ ...envelope, fields: [unassigned] })).toContain('FIELD_NOT_ASSIGNED')
  })
})

describe('settings helpers', () => {
  it('fills in defaults for a partially specified envelope', () => {
    const envelope = withDefaults({ ...base(), settings: { requireConsent: false } })
    expect(envelope.settings.requireConsent).toBe(false)
    expect(envelope.settings.enforceRequiredFields).toBe(defaultSettings.enforceRequiredFields)
    expect(envelope.settings.attachCertificate).toBe(defaultSettings.attachCertificate)
  })

  it('defaults to requiring consent and enforcing required fields', () => {
    expect(defaultSettings.requireConsent).toBe(true)
    expect(defaultSettings.enforceRequiredFields).toBe(true)
    // Delegation is off by default: passing a signature to someone else is a
    // decision the sender should make deliberately.
    expect(defaultSettings.allowDelegation).toBe(false)
  })
})
