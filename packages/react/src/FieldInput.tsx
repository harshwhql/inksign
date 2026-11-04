import type { FieldId, FieldValue, InkSignature } from '@inksign/core'
import { formatValue, isEmpty, isInkField } from '@inksign/core'
import { describeField } from '@inksign/ui'
import { type CSSProperties, memo, type ReactNode, useCallback, useId } from 'react'
import { useInkSign } from './context.js'
import type { FieldBox } from './DocumentViewer.jsx'
import { useFieldState } from './hooks.js'

/**
 * Field overlays.
 *
 * Each field is its own component subscribed to its own value, so typing in
 * one re-renders one input. `memo` here is not decoration: without it, a
 * parent re-render would walk every field on the page.
 */

export interface FieldInputProps {
  fieldId: FieldId
  box: FieldBox
  /** Called when a signature field is activated, to open the adopt dialog. */
  onRequestSignature?: ((fieldId: FieldId) => void) | undefined
  /** The signature adopted in this session, applied to ink fields on click. */
  adoptedSignature?: InkSignature | undefined
  /** Marks this field as the one the signer is currently on. */
  active?: boolean | undefined
  onFocus?: ((fieldId: FieldId) => void) | undefined
}

export const FieldInput = memo(function FieldInput({
  fieldId,
  box,
  onRequestSignature,
  adoptedSignature,
  active,
  onFocus,
}: FieldInputProps): ReactNode {
  const { locale, session } = useInkSign()
  const { field, value, issues, setValue } = useFieldState(fieldId)
  const describedBy = useId()

  if (!field) return null

  const invalid = issues.some((issue) => issue.severity === 'error')
  const filled = !isEmpty(value)
  const required = field.validation?.required ?? false

  // A field belonging to another recipient is shown so the signer sees the
  // whole agreement, but it is not interactive.
  const isMine = session !== undefined && field.recipientId === session.recipientId
  const other = !isMine

  const position: CSSProperties = {
    position: 'absolute',
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    boxSizing: 'border-box',
  }

  const frame: CSSProperties = {
    ...position,
    display: 'flex',
    alignItems: 'center',
    padding: '0 4px',
    font: 'inherit',
    fontFamily: 'var(--inksign-font-family, system-ui, sans-serif)',
    // Scale the text with the zoom so it stays proportional to the page.
    fontSize: Math.max(8, (field.style?.fontSize ?? 11) * box.scale),
    color: 'var(--inksign-text, #14161d)',
    background: other
      ? 'var(--inksign-field-other, rgba(92, 96, 112, 0.14))'
      : filled
        ? 'var(--inksign-field-filled, rgba(29, 111, 66, 0.1))'
        : 'var(--inksign-field-idle, rgba(31, 42, 94, 0.08))',
    border: `${Math.max(1, box.scale)}px solid ${
      invalid
        ? 'var(--inksign-field-invalid, #b3261e)'
        : active
          ? 'var(--inksign-field-active, #1f2a5e)'
          : required && !filled
            ? 'var(--inksign-field-required, #1f2a5e)'
            : 'transparent'
    }`,
    borderRadius: 'var(--inksign-radius-small, 4px)',
    cursor: other ? 'default' : 'pointer',
  }

  const label = describeField(field, value, {
    ...(locale !== undefined ? { locale } : {}),
    isOther: other,
  })

  if (other) {
    return (
      <div style={frame} aria-label={label} role="img" data-inksign-field={fieldId}>
        <span style={{ opacity: 0.55, fontSize: '0.75em' }}>
          {filled ? formatValue(value, locale) : (field.label ?? '')}
        </span>
      </div>
    )
  }

  const commonProps = {
    'data-inksign-field': fieldId,
    'aria-describedby': field.tooltip ? describedBy : undefined,
    'aria-invalid': invalid || undefined,
    'aria-required': required || undefined,
    onFocus: () => onFocus?.(fieldId),
  }

  if (isInkField(field.type)) {
    return (
      <>
        <button
          type="button"
          style={{
            ...frame,
            justifyContent: 'center',
            overflow: 'hidden',
          }}
          aria-label={label}
          onClick={() => {
            // Reuse the adopted signature when there is one, which is what
            // makes signing a 40 page document one action rather than forty.
            if (adoptedSignature) setValue({ kind: 'ink', value: adoptedSignature })
            else onRequestSignature?.(fieldId)
          }}
          {...commonProps}
        >
          <InkPreview value={value} type={field.type} />
        </button>
        {field.tooltip ? <Tooltip id={describedBy} text={field.tooltip} /> : null}
      </>
    )
  }

  switch (field.type) {
    case 'checkbox':
    case 'approve':
    case 'decline':
      return (
        <input
          type="checkbox"
          checked={value.kind === 'boolean' ? value.value : false}
          onChange={(event) => setValue({ kind: 'boolean', value: event.target.checked })}
          style={{ ...position, cursor: 'pointer', accentColor: 'var(--inksign-primary, #1f2a5e)' }}
          aria-label={label}
          {...commonProps}
        />
      )

    case 'dropdown':
      return (
        <select
          value={value.kind === 'choice' ? value.value : ''}
          onChange={(event) => setValue({ kind: 'choice', value: event.target.value })}
          style={frame}
          aria-label={label}
          {...commonProps}
        >
          <option value="">{field.label ?? 'Select'}</option>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label ?? option.value}
            </option>
          ))}
        </select>
      )

    case 'radio_group':
      return (
        <div
          role="radiogroup"
          aria-label={label}
          style={{ ...position, display: 'flex', gap: 4 * box.scale, alignItems: 'center' }}
        >
          {field.options?.map((option) => (
            <label
              key={option.value}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2 * box.scale,
                fontSize: Math.max(8, 10 * box.scale),
              }}
            >
              <input
                type="radio"
                name={fieldId}
                value={option.value}
                checked={value.kind === 'choice' && value.value === option.value}
                onChange={() => setValue({ kind: 'choice', value: option.value })}
                style={{ accentColor: 'var(--inksign-primary, #1f2a5e)' }}
              />
              {option.label ?? option.value}
            </label>
          ))}
        </div>
      )

    case 'number':
      return (
        <NumberField
          frame={frame}
          label={label}
          value={value}
          onChange={setValue}
          commonProps={commonProps}
        />
      )

    case 'date_signed':
    case 'full_name':
    case 'email':
    case 'note':
    case 'formula':
      // Engine-filled or sender-supplied: shown, never edited.
      return (
        <div style={frame} aria-label={label} role="img" data-inksign-field={fieldId}>
          {formatValue(value, locale)}
        </div>
      )

    default:
      return (
        <>
          <input
            type="text"
            value={value.kind === 'text' ? value.value : ''}
            placeholder={field.label ?? ''}
            maxLength={field.validation?.maxLength}
            onChange={(event) => setValue({ kind: 'text', value: event.target.value })}
            style={{ ...frame, textAlign: field.style?.align ?? 'left' }}
            aria-label={label}
            {...commonProps}
          />
          {field.tooltip ? <Tooltip id={describedBy} text={field.tooltip} /> : null}
        </>
      )
  }
})

interface NumberFieldProps {
  frame: CSSProperties
  label: string
  value: FieldValue
  onChange: (value: FieldValue) => void
  commonProps: Record<string, unknown>
}

/**
 * Number input.
 *
 * Stored as empty rather than as zero when cleared. Writing 0 for an empty
 * box would make a required amount field look satisfied when it is not.
 */
function NumberField({ frame, label, value, onChange, commonProps }: NumberFieldProps): ReactNode {
  const handle = useCallback(
    (raw: string) => {
      if (raw.trim() === '') {
        onChange({ kind: 'empty' })
        return
      }
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) onChange({ kind: 'number', value: parsed })
    },
    [onChange],
  )

  return (
    <input
      type="number"
      value={value.kind === 'number' ? String(value.value) : ''}
      onChange={(event) => handle(event.target.value)}
      style={frame}
      aria-label={label}
      {...commonProps}
    />
  )
}

/** Renders a captured signature inside its field. */
function InkPreview({ value, type }: { value: FieldValue; type: string }): ReactNode {
  if (value.kind !== 'ink') {
    return (
      <span
        style={{
          fontSize: '0.75em',
          fontWeight: 600,
          color: 'var(--inksign-primary, #1f2a5e)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {type === 'initials' ? 'Initial' : 'Sign'}
      </span>
    )
  }

  const ink = value.value

  // Vector paths first: they scale with the zoom without going soft.
  if (ink.paths && ink.paths.length > 0) {
    return (
      <svg
        viewBox={`0 0 ${ink.width} ${ink.height}`}
        width="100%"
        height="100%"
        style={{ display: 'block' }}
        aria-hidden="true"
      >
        {ink.paths.map((path, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a captured signature's stroke list is fixed and never reordered, so the index is a stable identity
          <path key={index} d={path} fill="var(--inksign-ink, #14161d)" />
        ))}
      </svg>
    )
  }

  if (ink.png) {
    return (
      <img
        src={ink.png}
        alt=""
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
      />
    )
  }

  if (ink.text) {
    return (
      <span
        style={{
          fontFamily: ink.typeface ?? 'var(--inksign-font-family-signature, cursive)',
          fontSize: '1.4em',
          lineHeight: 1,
          color: 'var(--inksign-ink, #14161d)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}
      >
        {ink.text}
      </span>
    )
  }

  return null
}

/** Visually hidden description, referenced by aria-describedby. */
function Tooltip({ id, text }: { id: string; text: string }): ReactNode {
  return (
    <span
      id={id}
      style={{
        position: 'absolute',
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)',
        whiteSpace: 'nowrap',
        border: 0,
      }}
    >
      {text}
    </span>
  )
}
