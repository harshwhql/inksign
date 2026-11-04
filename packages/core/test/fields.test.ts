import { beforeEach, describe, expect, it } from 'vitest'
import type { Field, FieldId, FieldValue } from '../src/index.js'
import {
  acceptsValue,
  buildReverseIndex,
  clearPatternCache,
  defaultValue,
  dependentFields,
  describeField,
  evaluateCondition,
  formatValue,
  isAutoFilled,
  isEmpty,
  isFieldVisible,
  isInkField,
  isInteractive,
  isValueValid,
  validateConditions,
  validateValue,
} from '../src/index.js'

function field(over: Partial<Field> = {}): Field {
  return {
    id: 'fld_1',
    documentId: 'doc_1',
    recipientId: 'rcp_1',
    type: 'text',
    rect: { page: 0, x: 0, y: 0, width: 160, height: 18 },
    ...over,
  }
}

const errorsOf = (issues: readonly { severity: string; message: string }[]): string[] =>
  issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message)

beforeEach(() => {
  clearPatternCache()
})

describe('field registry', () => {
  it('reports which value kinds a type accepts', () => {
    expect(
      acceptsValue('signature', { kind: 'ink', value: { source: 'drawn', width: 1, height: 1 } }),
    ).toBe(true)
    expect(acceptsValue('signature', { kind: 'text', value: 'Alice' })).toBe(false)
    expect(acceptsValue('checkbox', { kind: 'boolean', value: true })).toBe(true)
    expect(acceptsValue('number', { kind: 'text', value: '5' })).toBe(false)
  })

  it('accepts an empty value for any type', () => {
    expect(acceptsValue('signature', { kind: 'empty' })).toBe(true)
    expect(acceptsValue('number', { kind: 'empty' })).toBe(true)
  })

  it('classifies ink and auto-filled types', () => {
    expect(isInkField('signature')).toBe(true)
    expect(isInkField('initials')).toBe(true)
    expect(isInkField('stamp')).toBe(true)
    expect(isInkField('text')).toBe(false)

    expect(isAutoFilled('date_signed')).toBe(true)
    expect(isAutoFilled('full_name')).toBe(true)
    expect(isAutoFilled('text')).toBe(false)
  })

  it('treats a read-only field as non-interactive whatever its type', () => {
    expect(isInteractive(field({ type: 'text' }))).toBe(true)
    expect(isInteractive(field({ type: 'text', readOnly: true }))).toBe(false)
    // Engine-filled types are not interactive either.
    expect(isInteractive(field({ type: 'date_signed' }))).toBe(false)
  })

  it('gives every type a minimum size', () => {
    expect(describeField('signature').minSize.width).toBeGreaterThan(
      describeField('checkbox').minSize.width,
    )
    expect(describeField('checkbox').minSize).toEqual({ width: 14, height: 14 })
  })

  describe('emptiness', () => {
    const cases: readonly (readonly [string, FieldValue, boolean])[] = [
      ['empty', { kind: 'empty' }, true],
      ['blank text', { kind: 'text', value: '' }, true],
      ['whitespace text', { kind: 'text', value: '   ' }, true],
      ['real text', { kind: 'text', value: 'x' }, false],
      ['false boolean', { kind: 'boolean', value: false }, true],
      ['true boolean', { kind: 'boolean', value: true }, false],
      ['zero', { kind: 'number', value: 0 }, false],
      ['no files', { kind: 'file', value: [] }, true],
      ['blank ink', { kind: 'ink', value: { source: 'drawn', width: 1, height: 1 } }, true],
      [
        'drawn ink',
        { kind: 'ink', value: { source: 'drawn', width: 1, height: 1, paths: ['M 0 0'] } },
        false,
      ],
      [
        'typed ink',
        { kind: 'ink', value: { source: 'typed', width: 1, height: 1, text: 'Alice' } },
        false,
      ],
    ]

    for (const [label, value, expected] of cases) {
      it(`treats ${label} as ${expected ? 'empty' : 'filled'}`, () => {
        expect(isEmpty(value)).toBe(expected)
      })
    }

    it('treats zero as filled, so a required amount of 0 counts', () => {
      // A number field holding 0 is answered, not blank. Treating it as empty
      // would block a signer who legitimately entered zero.
      expect(isEmpty({ kind: 'number', value: 0 })).toBe(false)
    })
  })

  describe('default values', () => {
    it('starts a checkbox unticked rather than empty', () => {
      expect(defaultValue(field({ type: 'checkbox' }))).toEqual({ kind: 'boolean', value: false })
    })

    it('honours a default option on a dropdown', () => {
      const withDefault = field({
        type: 'dropdown',
        options: [{ value: 'de' }, { value: 'ny', default: true }],
      })
      expect(defaultValue(withDefault)).toEqual({ kind: 'choice', value: 'ny' })
    })

    it('leaves a dropdown empty when no option is marked default', () => {
      const plain = field({ type: 'dropdown', options: [{ value: 'de' }, { value: 'ny' }] })
      expect(defaultValue(plain)).toEqual({ kind: 'empty' })
    })

    it('leaves a text field empty', () => {
      expect(defaultValue(field({ type: 'text' }))).toEqual({ kind: 'empty' })
    })
  })

  describe('formatting', () => {
    it('formats each kind for display', () => {
      expect(formatValue({ kind: 'empty' })).toBe('')
      expect(formatValue({ kind: 'text', value: 'Alice' })).toBe('Alice')
      expect(formatValue({ kind: 'boolean', value: true })).toBe('true')
      expect(formatValue({ kind: 'number', value: 1234.5 }, 'en-US')).toBe('1,234.5')
      expect(formatValue({ kind: 'date', value: Date.UTC(2026, 10, 4) }, 'en-US')).toContain('2026')
    })

    it('describes ink without leaking image data', () => {
      const drawn = formatValue({
        kind: 'ink',
        value: { source: 'drawn', width: 1, height: 1, png: 'data:image/png;base64,AAAA' },
      })
      expect(drawn).toBe('[drawn signature]')
      expect(drawn).not.toContain('base64')
    })

    it('prefers the typed text when there is one', () => {
      expect(
        formatValue({
          kind: 'ink',
          value: { source: 'typed', width: 1, height: 1, text: 'Alice' },
        }),
      ).toBe('Alice')
    })

    it('lists attachment names', () => {
      expect(
        formatValue({
          kind: 'file',
          value: [
            { key: 'a', name: 'id.png', contentType: 'image/png', byteSize: 1 },
            { key: 'b', name: 'proof.pdf', contentType: 'application/pdf', byteSize: 2 },
          ],
        }),
      ).toBe('id.png, proof.pdf')
    })
  })
})

describe('value validation', () => {
  it('passes a value with no rules', () => {
    expect(isValueValid(field(), { kind: 'text', value: 'anything' })).toBe(true)
  })

  it('rejects a value of the wrong kind and stops there', () => {
    const issues = validateValue(field({ type: 'number' }), { kind: 'text', value: '5' })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('VALUE_TYPE_MISMATCH')
  })

  describe('required', () => {
    const required = field({ validation: { required: true }, label: 'Job title' })

    it('rejects an empty required value', () => {
      expect(errorsOf(validateValue(required, { kind: 'empty' }))).toEqual([
        '"Job title" is required',
      ])
    })

    it('rejects whitespace for a required field', () => {
      expect(validateValue(required, { kind: 'text', value: '   ' })).toHaveLength(1)
    })

    it('can skip the required check while the signer is still typing', () => {
      expect(validateValue(required, { kind: 'empty' }, { enforceRequired: false })).toHaveLength(0)
    })

    it('falls back to the field type when there is no label', () => {
      const unlabelled = field({ type: 'date_signed', validation: { required: true } })
      expect(errorsOf(validateValue(unlabelled, { kind: 'empty' }))[0]).toContain('date signed')
    })
  })

  describe('length', () => {
    const bounded = field({ label: 'Note', validation: { minLength: 3, maxLength: 8 } })

    it('rejects a value that is too short', () => {
      expect(errorsOf(validateValue(bounded, { kind: 'text', value: 'ab' }))[0]).toContain(
        'at least 3',
      )
    })

    it('rejects a value that is too long', () => {
      expect(errorsOf(validateValue(bounded, { kind: 'text', value: 'abcdefghi' }))[0]).toContain(
        'at most 8',
      )
    })

    it('accepts a value at each boundary', () => {
      expect(validateValue(bounded, { kind: 'text', value: 'abc' })).toHaveLength(0)
      expect(validateValue(bounded, { kind: 'text', value: 'abcdefgh' })).toHaveLength(0)
    })

    it('does not apply length rules to an empty value', () => {
      expect(validateValue(bounded, { kind: 'empty' })).toHaveLength(0)
    })
  })

  describe('numeric range', () => {
    const bounded = field({ type: 'number', label: 'Amount', validation: { min: 10, max: 100 } })

    it('rejects a value below the minimum', () => {
      expect(errorsOf(validateValue(bounded, { kind: 'number', value: 9 }))[0]).toContain(
        '10 or more',
      )
    })

    it('rejects a value above the maximum', () => {
      expect(errorsOf(validateValue(bounded, { kind: 'number', value: 101 }))[0]).toContain(
        '100 or less',
      )
    })

    it('accepts the boundaries', () => {
      expect(validateValue(bounded, { kind: 'number', value: 10 })).toHaveLength(0)
      expect(validateValue(bounded, { kind: 'number', value: 100 })).toHaveLength(0)
    })

    it('rejects a non-finite number', () => {
      expect(errorsOf(validateValue(bounded, { kind: 'number', value: Number.NaN }))[0]).toContain(
        'must be a number',
      )
    })
  })

  describe('pattern', () => {
    const patterned = field({
      label: 'Postcode',
      validation: { pattern: '^[0-9]{5}$', patternMessage: 'Enter a 5 digit postcode' },
    })

    it('accepts a matching value', () => {
      expect(validateValue(patterned, { kind: 'text', value: '94107' })).toHaveLength(0)
    })

    it('uses the custom message when it does not match', () => {
      expect(errorsOf(validateValue(patterned, { kind: 'text', value: 'abc' }))).toEqual([
        'Enter a 5 digit postcode',
      ])
    })

    it('falls back to a generic message with no custom one', () => {
      const plain = field({ label: 'Code', validation: { pattern: '^[0-9]+$' } })
      expect(errorsOf(validateValue(plain, { kind: 'text', value: 'x' }))[0]).toContain(
        'not in the expected format',
      )
    })

    it('ignores an invalid pattern rather than blocking the signer', () => {
      // An unparseable pattern is the sender's mistake, caught by envelope
      // validation. It must not stop someone from signing.
      const broken = field({ validation: { pattern: '([unclosed' } })
      expect(validateValue(broken, { kind: 'text', value: 'anything' })).toHaveLength(0)
    })

    it('reuses the compiled pattern across calls', () => {
      const shared = field({ validation: { pattern: '^[a-z]+$' } })
      for (let i = 0; i < 50; i += 1) {
        expect(validateValue(shared, { kind: 'text', value: 'abc' })).toHaveLength(0)
      }
    })
  })

  describe('email', () => {
    const email = field({ type: 'email', label: 'Email' })

    it('accepts a plausible address', () => {
      expect(validateValue(email, { kind: 'text', value: 'alice@example.com' })).toHaveLength(0)
      expect(validateValue(email, { kind: 'text', value: 'a.b+c@sub.example.co.uk' })).toHaveLength(
        0,
      )
    })

    for (const bad of ['alice', 'alice@', '@example.com', 'alice@example', 'a b@example.com']) {
      it(`rejects ${JSON.stringify(bad)}`, () => {
        expect(errorsOf(validateValue(email, { kind: 'text', value: bad }))[0]).toContain(
          'valid email address',
        )
      })
    }
  })

  describe('options', () => {
    const dropdown = field({
      type: 'dropdown',
      label: 'State',
      options: [{ value: 'de' }, { value: 'ny' }],
    })

    it('accepts a listed option', () => {
      expect(validateValue(dropdown, { kind: 'choice', value: 'ny' })).toHaveLength(0)
    })

    it('rejects an option that is not on the list', () => {
      expect(errorsOf(validateValue(dropdown, { kind: 'choice', value: 'ca' }))[0]).toContain(
        'not an option',
      )
    })

    it('accepts anything when no options are declared', () => {
      const open = field({ type: 'dropdown' })
      expect(validateValue(open, { kind: 'choice', value: 'whatever' })).toHaveLength(0)
    })
  })

  it('reports several problems at once', () => {
    const strict = field({
      label: 'Code',
      validation: { minLength: 10, pattern: '^[0-9]+$', patternMessage: 'Digits only' },
    })
    const issues = validateValue(strict, { kind: 'text', value: 'ab' })
    expect(issues.length).toBeGreaterThan(1)
  })
})

describe('conditions', () => {
  const lookup = (values: Record<string, FieldValue>) => (id: FieldId) =>
    values[id] ?? { kind: 'empty' }

  it('evaluates filled and empty', () => {
    const filled = lookup({ a: { kind: 'text', value: 'x' } })
    expect(evaluateCondition({ whenField: 'a', operator: 'filled' }, filled)).toBe(true)
    expect(evaluateCondition({ whenField: 'a', operator: 'empty' }, filled)).toBe(false)
    expect(evaluateCondition({ whenField: 'b', operator: 'empty' }, filled)).toBe(true)
  })

  it('evaluates equality against each value kind', () => {
    const values = lookup({
      text: { kind: 'text', value: 'yes' },
      flag: { kind: 'boolean', value: true },
      count: { kind: 'number', value: 5 },
    })

    expect(evaluateCondition({ whenField: 'text', operator: 'equals', value: 'yes' }, values)).toBe(
      true,
    )
    expect(evaluateCondition({ whenField: 'flag', operator: 'equals', value: true }, values)).toBe(
      true,
    )
    expect(evaluateCondition({ whenField: 'flag', operator: 'equals', value: false }, values)).toBe(
      false,
    )
    expect(evaluateCondition({ whenField: 'count', operator: 'equals', value: 5 }, values)).toBe(
      true,
    )
    expect(
      evaluateCondition({ whenField: 'text', operator: 'not_equals', value: 'no' }, values),
    ).toBe(true)
  })

  it('compares numerically, including a number typed into a text field', () => {
    const values = lookup({
      n: { kind: 'number', value: 10 },
      t: { kind: 'text', value: '42' },
    })

    expect(evaluateCondition({ whenField: 'n', operator: 'greater_than', value: 5 }, values)).toBe(
      true,
    )
    expect(evaluateCondition({ whenField: 'n', operator: 'less_than', value: 5 }, values)).toBe(
      false,
    )
    expect(evaluateCondition({ whenField: 't', operator: 'greater_than', value: 40 }, values)).toBe(
      true,
    )
  })

  it('evaluates substring matching', () => {
    const values = lookup({ a: { kind: 'text', value: 'Northwind Legal' } })
    expect(evaluateCondition({ whenField: 'a', operator: 'includes', value: 'wind' }, values)).toBe(
      true,
    )
    expect(evaluateCondition({ whenField: 'a', operator: 'includes', value: 'zzz' }, values)).toBe(
      false,
    )
  })

  it('returns false rather than throwing when kinds are not comparable', () => {
    const values = lookup({ a: { kind: 'ink', value: { source: 'drawn', width: 1, height: 1 } } })
    expect(evaluateCondition({ whenField: 'a', operator: 'greater_than', value: 1 }, values)).toBe(
      false,
    )
  })

  describe('visibility', () => {
    const parent = field({ id: 'parent', type: 'checkbox' })
    const child = field({
      id: 'child',
      conditions: [{ whenField: 'parent', operator: 'equals', value: true }],
    })
    const grandchild = field({
      id: 'grandchild',
      conditions: [{ whenField: 'child', operator: 'filled' }],
    })
    const fields = new Map([
      ['parent', parent],
      ['child', child],
      ['grandchild', grandchild],
    ])

    it('shows a field with no conditions', () => {
      expect(isFieldVisible(parent, fields, lookup({}))).toBe(true)
    })

    it('hides a field whose condition is unmet', () => {
      expect(isFieldVisible(child, fields, lookup({}))).toBe(false)
    })

    it('shows a field once its condition is met', () => {
      const values = lookup({ parent: { kind: 'boolean', value: true } })
      expect(isFieldVisible(child, fields, values)).toBe(true)
    })

    it('hides a grandchild when the grandparent hides the parent', () => {
      // The child is filled, so its own condition passes, but it is itself
      // hidden. A branch must not become required through a hidden parent.
      const values = lookup({
        parent: { kind: 'boolean', value: false },
        child: { kind: 'text', value: 'x' },
      })
      expect(isFieldVisible(grandchild, fields, values)).toBe(false)
    })

    it('shows the whole chain when every link passes', () => {
      const values = lookup({
        parent: { kind: 'boolean', value: true },
        child: { kind: 'text', value: 'x' },
      })
      expect(isFieldVisible(grandchild, fields, values)).toBe(true)
    })

    it('requires every condition on a field to pass', () => {
      const both = field({
        id: 'both',
        conditions: [
          { whenField: 'parent', operator: 'equals', value: true },
          { whenField: 'child', operator: 'filled' },
        ],
      })
      const map = new Map([...fields, ['both', both]])

      const onlyOne = lookup({ parent: { kind: 'boolean', value: true } })
      expect(isFieldVisible(both, map, onlyOne)).toBe(false)

      const bothMet = lookup({
        parent: { kind: 'boolean', value: true },
        child: { kind: 'text', value: 'x' },
      })
      expect(isFieldVisible(both, map, bothMet)).toBe(true)
    })
  })

  describe('dependency graph', () => {
    const a = field({ id: 'a', type: 'checkbox' })
    const b = field({ id: 'b', conditions: [{ whenField: 'a', operator: 'filled' }] })
    const c = field({ id: 'c', conditions: [{ whenField: 'b', operator: 'filled' }] })
    const fields = new Map([
      ['a', a],
      ['b', b],
      ['c', c],
    ])

    it('maps each gate to its dependents', () => {
      const index = buildReverseIndex(fields)
      expect(index.get('a')).toEqual(['b'])
      expect(index.get('b')).toEqual(['c'])
    })

    it('finds transitive dependents', () => {
      expect(dependentFields('a', fields)).toEqual(['b', 'c'])
    })

    it('returns nothing for a field nobody depends on', () => {
      expect(dependentFields('c', fields)).toEqual([])
    })
  })

  describe('authoring checks', () => {
    it('accepts a sound graph', () => {
      const fields = new Map([
        ['a', field({ id: 'a', type: 'checkbox' })],
        ['b', field({ id: 'b', conditions: [{ whenField: 'a', operator: 'filled' }] })],
      ])
      expect(validateConditions(fields)).toEqual([])
    })

    it('reports a reference to a field that does not exist', () => {
      const fields = new Map([
        ['b', field({ id: 'b', conditions: [{ whenField: 'ghost', operator: 'filled' }] })],
      ])
      const issues = validateConditions(fields)
      expect(issues.some((issue) => issue.code === 'UNKNOWN_FIELD')).toBe(true)
    })

    it('reports a field conditional on itself', () => {
      const fields = new Map([
        ['a', field({ id: 'a', conditions: [{ whenField: 'a', operator: 'filled' }] })],
      ])
      expect(validateConditions(fields).some((issue) => issue.code === 'CONDITION_CYCLE')).toBe(
        true,
      )
    })

    it('reports a two-field cycle', () => {
      const fields = new Map([
        ['a', field({ id: 'a', conditions: [{ whenField: 'b', operator: 'filled' }] })],
        ['b', field({ id: 'b', conditions: [{ whenField: 'a', operator: 'filled' }] })],
      ])
      expect(validateConditions(fields).some((issue) => issue.code === 'CONDITION_CYCLE')).toBe(
        true,
      )
    })

    it('reports a longer cycle', () => {
      const fields = new Map([
        ['a', field({ id: 'a', conditions: [{ whenField: 'b', operator: 'filled' }] })],
        ['b', field({ id: 'b', conditions: [{ whenField: 'c', operator: 'filled' }] })],
        ['c', field({ id: 'c', conditions: [{ whenField: 'a', operator: 'filled' }] })],
      ])
      expect(validateConditions(fields).some((issue) => issue.code === 'CONDITION_CYCLE')).toBe(
        true,
      )
    })

    it('does not mistake a diamond for a cycle', () => {
      // Two independent paths converging is legal, not circular.
      const fields = new Map([
        ['root', field({ id: 'root', type: 'checkbox' })],
        ['left', field({ id: 'left', conditions: [{ whenField: 'root', operator: 'filled' }] })],
        ['right', field({ id: 'right', conditions: [{ whenField: 'root', operator: 'filled' }] })],
        [
          'join',
          field({
            id: 'join',
            conditions: [
              { whenField: 'left', operator: 'filled' },
              { whenField: 'right', operator: 'filled' },
            ],
          }),
        ],
      ])
      expect(
        validateConditions(fields).filter((issue) => issue.code === 'CONDITION_CYCLE'),
      ).toEqual([])
    })

    it('handles a deep chain without overflowing the stack', () => {
      const fields = new Map<string, Field>()
      fields.set('f0', field({ id: 'f0', type: 'checkbox' }))
      for (let i = 1; i < 2000; i += 1) {
        fields.set(
          `f${i}`,
          field({ id: `f${i}`, conditions: [{ whenField: `f${i - 1}`, operator: 'filled' }] }),
        )
      }
      // Quadratic cycle detection turns this into a hang, so the timing is
      // part of the assertion.
      const started = Date.now()
      expect(validateConditions(fields)).toEqual([])
      expect(Date.now() - started).toBeLessThan(1000)
    })
  })
})
