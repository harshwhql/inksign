import type { ValidationIssue } from '../errors.js'
import type { Field, FieldValue } from '../types.js'
import { acceptsValue, formatValue, isEmpty } from './registry.js'

/**
 * Compiled regular expressions, cached by source string. Field patterns repeat
 * across a document (every phone number field shares one pattern), so
 * compiling once per pattern rather than once per keystroke matters on long
 * forms.
 */
const patternCache = new Map<string, RegExp | null>()
const PATTERN_CACHE_LIMIT = 256

function compilePattern(source: string): RegExp | null {
  const cached = patternCache.get(source)
  if (cached !== undefined) return cached
  let compiled: RegExp | null
  try {
    compiled = new RegExp(source, 'u')
  } catch {
    // An invalid pattern is reported by envelope validation, not here; treat it
    // as absent so a bad pattern cannot block a recipient from signing.
    compiled = null
  }
  if (patternCache.size >= PATTERN_CACHE_LIMIT) patternCache.clear()
  patternCache.set(source, compiled)
  return compiled
}

/** Loose email shape check. Deliverability is a server concern. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/u

export interface ValidateValueOptions {
  /** Treat a required field with no value as an error. */
  enforceRequired?: boolean
  locale?: string
}

/**
 * Validates one value against its field. Pure and synchronous, so it is safe
 * to call on every keystroke.
 */
export function validateValue(
  field: Field,
  value: FieldValue,
  options: ValidateValueOptions = {},
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const path = `fields.${field.id}.value`
  const name = field.label ?? field.type.replace(/_/gu, ' ')
  const enforceRequired = options.enforceRequired ?? true

  if (!acceptsValue(field.type, value)) {
    issues.push({
      code: 'VALUE_TYPE_MISMATCH',
      message: `"${name}" cannot hold a ${value.kind} value`,
      path,
      fieldId: field.id,
      severity: 'error',
    })
    // Further checks would read the wrong shape, so stop here.
    return issues
  }

  const blank = isEmpty(value)
  const validation = field.validation

  if (blank) {
    if (enforceRequired && validation?.required) {
      issues.push({
        code: 'VALIDATION_FAILED',
        message: `"${name}" is required`,
        path,
        fieldId: field.id,
        severity: 'error',
      })
    }
    // Nothing else applies to an empty value.
    return issues
  }

  if (value.kind === 'text' || value.kind === 'choice') {
    const text = value.value

    if (validation?.minLength !== undefined && text.length < validation.minLength) {
      issues.push({
        code: 'VALIDATION_FAILED',
        message: `"${name}" must be at least ${validation.minLength} characters`,
        path,
        fieldId: field.id,
        severity: 'error',
      })
    }
    if (validation?.maxLength !== undefined && text.length > validation.maxLength) {
      issues.push({
        code: 'VALIDATION_FAILED',
        message: `"${name}" must be at most ${validation.maxLength} characters`,
        path,
        fieldId: field.id,
        severity: 'error',
      })
    }
    if (validation?.pattern) {
      const pattern = compilePattern(validation.pattern)
      if (pattern && !pattern.test(text)) {
        issues.push({
          code: 'VALIDATION_FAILED',
          message: validation.patternMessage ?? `"${name}" is not in the expected format`,
          path,
          fieldId: field.id,
          severity: 'error',
        })
      }
    }
    if (field.type === 'email' && !EMAIL_PATTERN.test(text)) {
      issues.push({
        code: 'VALIDATION_FAILED',
        message: `"${name}" must be a valid email address`,
        path,
        fieldId: field.id,
        severity: 'error',
      })
    }
  }

  if (value.kind === 'number') {
    if (!Number.isFinite(value.value)) {
      issues.push({
        code: 'VALIDATION_FAILED',
        message: `"${name}" must be a number`,
        path,
        fieldId: field.id,
        severity: 'error',
      })
    } else {
      if (validation?.min !== undefined && value.value < validation.min) {
        issues.push({
          code: 'VALIDATION_FAILED',
          message: `"${name}" must be ${validation.min} or more`,
          path,
          fieldId: field.id,
          severity: 'error',
        })
      }
      if (validation?.max !== undefined && value.value > validation.max) {
        issues.push({
          code: 'VALIDATION_FAILED',
          message: `"${name}" must be ${validation.max} or less`,
          path,
          fieldId: field.id,
          severity: 'error',
        })
      }
    }
  }

  if (value.kind === 'choice' && field.options && field.options.length > 0) {
    const allowed = field.options.some((option) => option.value === value.value)
    if (!allowed) {
      issues.push({
        code: 'VALIDATION_FAILED',
        message: `"${formatValue(value, options.locale)}" is not an option for "${name}"`,
        path,
        fieldId: field.id,
        severity: 'error',
      })
    }
  }

  return issues
}

/** True when the value satisfies every rule on the field. */
export function isValueValid(
  field: Field,
  value: FieldValue,
  options?: ValidateValueOptions,
): boolean {
  return validateValue(field, value, options).length === 0
}

/** Clears the compiled-pattern cache. Exposed for tests and long-lived workers. */
export function clearPatternCache(): void {
  patternCache.clear()
}
