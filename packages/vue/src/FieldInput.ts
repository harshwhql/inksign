import type { FieldId, FieldValue, InkSignature } from '@inksign/core'
import { formatValue, isEmpty, isInkField } from '@inksign/core'
import { describeField } from '@inksign/ui'
import { type CSSProperties, computed, defineComponent, h, type PropType, type VNode } from 'vue'
import { useFieldState } from './composables.js'
import { useInkSign } from './context.js'
import type { FieldBox } from './DocumentViewer.js'

/**
 * Field overlay.
 *
 * Each field is its own component subscribed to its own value, so typing in
 * one updates one input. That is the whole reason the store exposes keyed
 * subscriptions, and it is what a parent-level reactive object would undo.
 */
export const FieldInput = defineComponent({
  name: 'InkSignFieldInput',
  props: {
    fieldId: { type: String as PropType<FieldId>, required: true },
    box: { type: Object as PropType<FieldBox>, required: true },
    /** The signature adopted in this session, applied to ink fields on click. */
    adoptedSignature: { type: Object as PropType<InkSignature | undefined>, default: undefined },
    /** Marks this field as the one the signer is currently on. */
    active: { type: Boolean, default: false },
  },
  emits: {
    requestSignature: (_fieldId: FieldId) => true,
    focusField: (_fieldId: FieldId) => true,
  },
  setup(props, { emit }) {
    const { locale, session } = useInkSign()
    const state = useFieldState(props.fieldId)

    const isMine = computed(
      () => session !== undefined && state.field.value?.recipientId === session.recipientId,
    )

    return () => {
      const field = state.field.value
      if (!field) return null

      const value = state.value.value
      const invalid = state.issues.value.some((issue) => issue.severity === 'error')
      const filled = !isEmpty(value)
      const required = field.validation?.required ?? false
      const other = !isMine.value

      const position: CSSProperties = {
        position: 'absolute',
        left: `${props.box.left}px`,
        top: `${props.box.top}px`,
        width: `${props.box.width}px`,
        height: `${props.box.height}px`,
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
        fontSize: `${Math.max(8, (field.style?.fontSize ?? 11) * props.box.scale)}px`,
        color: 'var(--inksign-text, #14161d)',
        background: other
          ? 'var(--inksign-field-other, rgba(92, 96, 112, 0.14))'
          : filled
            ? 'var(--inksign-field-filled, rgba(29, 111, 66, 0.1))'
            : 'var(--inksign-field-idle, rgba(31, 42, 94, 0.08))',
        border: `${Math.max(1, props.box.scale)}px solid ${
          invalid
            ? 'var(--inksign-field-invalid, #b3261e)'
            : props.active
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

      // A field belonging to another recipient is shown so the signer sees the
      // whole agreement, but it is not interactive.
      if (other) {
        return h(
          'div',
          { style: frame, 'aria-label': label, role: 'img', 'data-inksign-field': props.fieldId },
          [
            h(
              'span',
              { style: { opacity: 0.55, fontSize: '0.75em' } satisfies CSSProperties },
              filled ? formatValue(value, locale) : (field.label ?? ''),
            ),
          ],
        )
      }

      const shared = {
        'data-inksign-field': props.fieldId,
        'aria-invalid': invalid || undefined,
        'aria-required': required || undefined,
        onFocus: () => emit('focusField', props.fieldId),
      }

      if (isInkField(field.type)) {
        return h(
          'button',
          {
            type: 'button',
            style: { ...frame, justifyContent: 'center', overflow: 'hidden' },
            'aria-label': label,
            onClick: () => {
              // Reuse the adopted signature when there is one, which is what
              // makes signing a 40 page document one action rather than forty.
              if (props.adoptedSignature) {
                state.setValue({ kind: 'ink', value: props.adoptedSignature })
              } else {
                emit('requestSignature', props.fieldId)
              }
            },
            ...shared,
          },
          [inkPreview(value, field.type)],
        )
      }

      switch (field.type) {
        case 'checkbox':
        case 'approve':
        case 'decline':
          return h('input', {
            type: 'checkbox',
            checked: value.kind === 'boolean' ? value.value : false,
            onChange: (event: Event) =>
              state.setValue({
                kind: 'boolean',
                value: (event.target as HTMLInputElement).checked,
              }),
            style: {
              ...position,
              cursor: 'pointer',
              accentColor: 'var(--inksign-primary, #1f2a5e)',
            } satisfies CSSProperties,
            'aria-label': label,
            ...shared,
          })

        case 'dropdown':
          return h(
            'select',
            {
              value: value.kind === 'choice' ? value.value : '',
              onChange: (event: Event) =>
                state.setValue({
                  kind: 'choice',
                  value: (event.target as HTMLSelectElement).value,
                }),
              style: frame,
              'aria-label': label,
              ...shared,
            },
            [
              h('option', { value: '' }, field.label ?? 'Select'),
              ...(field.options ?? []).map((option) =>
                h(
                  'option',
                  { key: option.value, value: option.value },
                  option.label ?? option.value,
                ),
              ),
            ],
          )

        case 'radio_group':
          return h(
            'div',
            {
              role: 'radiogroup',
              'aria-label': label,
              style: {
                ...position,
                display: 'flex',
                gap: `${4 * props.box.scale}px`,
                alignItems: 'center',
              } satisfies CSSProperties,
            },
            (field.options ?? []).map((option) =>
              h(
                'label',
                {
                  key: option.value,
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: `${2 * props.box.scale}px`,
                    fontSize: `${Math.max(8, 10 * props.box.scale)}px`,
                  } satisfies CSSProperties,
                },
                [
                  h('input', {
                    type: 'radio',
                    name: props.fieldId,
                    value: option.value,
                    checked: value.kind === 'choice' && value.value === option.value,
                    onChange: () => state.setValue({ kind: 'choice', value: option.value }),
                    style: {
                      accentColor: 'var(--inksign-primary, #1f2a5e)',
                    } satisfies CSSProperties,
                  }),
                  option.label ?? option.value,
                ],
              ),
            ),
          )

        case 'number':
          return h('input', {
            type: 'number',
            value: value.kind === 'number' ? String(value.value) : '',
            onInput: (event: Event) => {
              const raw = (event.target as HTMLInputElement).value
              // Stored as empty rather than zero when cleared, or a required
              // amount field would look satisfied when it is not.
              if (raw.trim() === '') {
                state.setValue({ kind: 'empty' })
                return
              }
              const parsed = Number(raw)
              if (Number.isFinite(parsed)) state.setValue({ kind: 'number', value: parsed })
            },
            style: frame,
            'aria-label': label,
            ...shared,
          })

        case 'date_signed':
        case 'full_name':
        case 'email':
        case 'note':
        case 'formula':
          // Engine-filled or sender-supplied: shown, never edited.
          return h(
            'div',
            { style: frame, 'aria-label': label, role: 'img', 'data-inksign-field': props.fieldId },
            formatValue(value, locale),
          )

        default:
          return h('input', {
            type: 'text',
            value: value.kind === 'text' ? value.value : '',
            placeholder: field.label ?? '',
            maxlength: field.validation?.maxLength,
            onInput: (event: Event) =>
              state.setValue({ kind: 'text', value: (event.target as HTMLInputElement).value }),
            style: { ...frame, textAlign: field.style?.align ?? 'left' } satisfies CSSProperties,
            'aria-label': label,
            ...shared,
          })
      }
    }
  },
})

/** Renders a captured signature inside its field. */
function inkPreview(value: FieldValue, type: string): VNode {
  if (value.kind !== 'ink') {
    return h(
      'span',
      {
        style: {
          fontSize: '0.75em',
          fontWeight: 600,
          color: 'var(--inksign-primary, #1f2a5e)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        } satisfies CSSProperties,
      },
      type === 'initials' ? 'Initial' : 'Sign',
    )
  }

  const ink = value.value

  // Vector paths first: they scale with the zoom without going soft.
  if (ink.paths && ink.paths.length > 0) {
    return h(
      'svg',
      {
        viewBox: `0 0 ${ink.width} ${ink.height}`,
        width: '100%',
        height: '100%',
        style: { display: 'block' } satisfies CSSProperties,
        'aria-hidden': 'true',
      },
      ink.paths.map((path, index) =>
        h('path', { key: index, d: path, fill: 'var(--inksign-ink, #14161d)' }),
      ),
    )
  }

  if (ink.png) {
    return h('img', {
      src: ink.png,
      alt: '',
      style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } satisfies CSSProperties,
    })
  }

  return h(
    'span',
    {
      style: {
        fontFamily: ink.typeface ?? 'var(--inksign-font-family-signature, cursive)',
        fontSize: '1.4em',
        lineHeight: 1,
        color: 'var(--inksign-ink, #14161d)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      } satisfies CSSProperties,
    },
    ink.text ?? '',
  )
}
