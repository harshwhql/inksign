/**
 * Error taxonomy. Every failure the engine raises carries a stable `code` so
 * callers can branch on the cause without matching message text, and so copy
 * can be localized at the boundary.
 */

export type InkSignErrorCode =
  | 'INVALID_ENVELOPE'
  | 'INVALID_TRANSITION'
  | 'UNKNOWN_FIELD'
  | 'UNKNOWN_RECIPIENT'
  | 'UNKNOWN_DOCUMENT'
  | 'FIELD_READ_ONLY'
  | 'FIELD_NOT_ASSIGNED'
  | 'FIELD_HIDDEN'
  | 'VALUE_TYPE_MISMATCH'
  | 'VALIDATION_FAILED'
  | 'REQUIRED_FIELDS_INCOMPLETE'
  | 'CONSENT_REQUIRED'
  | 'NOT_YOUR_TURN'
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'DECLINE_NOT_ALLOWED'
  | 'DELEGATION_NOT_ALLOWED'
  | 'ENVELOPE_EXPIRED'
  | 'ENVELOPE_CLOSED'
  | 'CONDITION_CYCLE'
  | 'ADAPTER_MISSING'
  | 'ADAPTER_FAILED'
  | 'DIGEST_MISMATCH'
  | 'SEAL_INVALID'
  | 'RENDER_FAILED'
  | 'UNSUPPORTED'

export class InkSignError extends Error {
  readonly code: InkSignErrorCode
  /** Structured context for logging. Never contains captured signature data. */
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: InkSignErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions)
    this.name = 'InkSignError'
    this.code = code
    this.details = Object.freeze({ ...details })
    // Keeps `instanceof` working when the output is transpiled down to ES5.
    Object.setPrototypeOf(this, InkSignError.prototype)
  }

  override toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`
  }
}

export function isInkSignError(value: unknown): value is InkSignError {
  return value instanceof InkSignError
}

/** Narrow an unknown error to a specific code. */
export function hasErrorCode(value: unknown, code: InkSignErrorCode): value is InkSignError {
  return isInkSignError(value) && value.code === code
}

/** A single problem found during validation. */
export interface ValidationIssue {
  code: InkSignErrorCode
  message: string
  /** Dotted path to the offending part of the envelope, for form binding. */
  path: string
  /** Field the issue belongs to, when the issue is field-scoped. */
  fieldId?: string
  severity: 'error' | 'warning'
}

export interface ValidationResult {
  valid: boolean
  issues: readonly ValidationIssue[]
}

export function validationError(result: ValidationResult): InkSignError {
  const first = result.issues[0]
  const summary = first ? first.message : 'Validation failed'
  const count = result.issues.length
  return new InkSignError(
    'VALIDATION_FAILED',
    count > 1 ? `${summary} (and ${count - 1} more)` : summary,
    { issues: result.issues },
  )
}
