import type { Field, FieldType, FieldValue } from '../types.js'

/** The `FieldValue` discriminants a field type accepts. */
export type ValueKind = FieldValue['kind']

export interface FieldDescriptor {
  type: FieldType
  /** Value kinds this field accepts, excluding `empty`. */
  accepts: readonly ValueKind[]
  /** The recipient supplies this value during the ceremony. */
  interactive: boolean
  /** The engine fills this in rather than the recipient. */
  autoFilled: boolean
  /** Counts toward signature adoption, so the signature prompt applies. */
  ink: boolean
  /** Default minimum size in points, used when auto-placing fields. */
  minSize: { width: number; height: number }
}

function descriptor(
  type: FieldType,
  accepts: readonly ValueKind[],
  options: Partial<Omit<FieldDescriptor, 'type' | 'accepts'>> = {},
): FieldDescriptor {
  return Object.freeze({
    type,
    accepts,
    interactive: options.interactive ?? true,
    autoFilled: options.autoFilled ?? false,
    ink: options.ink ?? false,
    minSize: options.minSize ?? { width: 60, height: 14 },
  })
}

const DESCRIPTORS: Readonly<Record<FieldType, FieldDescriptor>> = Object.freeze({
  signature: descriptor('signature', ['ink'], { ink: true, minSize: { width: 120, height: 36 } }),
  initials: descriptor('initials', ['ink'], { ink: true, minSize: { width: 44, height: 28 } }),
  stamp: descriptor('stamp', ['ink'], { ink: true, minSize: { width: 72, height: 72 } }),
  date_signed: descriptor('date_signed', ['date'], {
    interactive: false,
    autoFilled: true,
    minSize: { width: 72, height: 14 },
  }),
  full_name: descriptor('full_name', ['text'], { interactive: false, autoFilled: true }),
  email: descriptor('email', ['text'], { interactive: false, autoFilled: true }),
  company: descriptor('company', ['text']),
  title: descriptor('title', ['text']),
  text: descriptor('text', ['text']),
  number: descriptor('number', ['number']),
  checkbox: descriptor('checkbox', ['boolean'], { minSize: { width: 14, height: 14 } }),
  radio_group: descriptor('radio_group', ['choice']),
  dropdown: descriptor('dropdown', ['choice']),
  attachment: descriptor('attachment', ['file'], { minSize: { width: 120, height: 48 } }),
  approve: descriptor('approve', ['boolean'], { minSize: { width: 72, height: 24 } }),
  decline: descriptor('decline', ['boolean'], { minSize: { width: 72, height: 24 } }),
  note: descriptor('note', ['text'], { interactive: false }),
  formula: descriptor('formula', ['text', 'number'], {
    interactive: false,
    autoFilled: true,
  }),
  payment: descriptor('payment', ['number'], { minSize: { width: 96, height: 24 } }),
})

export function describeField(type: FieldType): FieldDescriptor {
  return DESCRIPTORS[type]
}

export function acceptsValue(type: FieldType, value: FieldValue): boolean {
  if (value.kind === 'empty') return true
  return DESCRIPTORS[type].accepts.includes(value.kind)
}

/** True when the recipient has to supply this value themselves. */
export function isInteractive(field: Field): boolean {
  if (field.readOnly) return false
  return DESCRIPTORS[field.type].interactive
}

/** True when the field holds a signature, initials or a stamp. */
export function isInkField(type: FieldType): boolean {
  return DESCRIPTORS[type].ink
}

/** True when the engine populates the field from recipient or clock data. */
export function isAutoFilled(type: FieldType): boolean {
  return DESCRIPTORS[type].autoFilled
}

export function isEmpty(value: FieldValue): boolean {
  switch (value.kind) {
    case 'empty':
      return true
    case 'text':
    case 'choice':
      return value.value.trim().length === 0
    case 'boolean':
      return value.value === false
    case 'file':
      return value.value.length === 0
    case 'ink':
      return (value.value.paths?.length ?? 0) === 0 && !value.value.png && !value.value.text
    default:
      return false
  }
}

/**
 * The value a field starts with, before the recipient touches it. Dropdowns
 * and radio groups honour a default option; everything else starts empty.
 */
export function defaultValue(field: Field): FieldValue {
  if (field.type === 'checkbox' || field.type === 'approve' || field.type === 'decline') {
    return { kind: 'boolean', value: false }
  }
  if (field.type === 'dropdown' || field.type === 'radio_group') {
    const preset = field.options?.find((option) => option.default)
    if (preset) return { kind: 'choice', value: preset.value }
  }
  return { kind: 'empty' }
}

/** Renders a value as display text, for field previews and the audit trail. */
export function formatValue(value: FieldValue, locale?: string): string {
  switch (value.kind) {
    case 'empty':
      return ''
    case 'text':
    case 'choice':
      return value.value
    case 'number':
      return new Intl.NumberFormat(locale).format(value.value)
    case 'boolean':
      return value.value ? 'true' : 'false'
    case 'date':
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(value.value)
    case 'ink':
      return value.value.text ?? `[${value.value.source} signature]`
    case 'file':
      return value.value.map((ref) => ref.name).join(', ')
  }
}
