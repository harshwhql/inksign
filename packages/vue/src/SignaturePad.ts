import type { InkSignature } from '@inksign/core'
import {
  createTypedSignature,
  createUploadedSignature,
  SignaturePad as PadController,
  type SignaturePadOptions,
  scriptFontStack,
} from '@inksign/ui'
import {
  type CSSProperties,
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  type PropType,
  ref,
  shallowRef,
  watch,
} from 'vue'

/**
 * Signature capture.
 *
 * The drawing itself is owned by the controller from `@inksign/ui`, not by
 * Vue. That is deliberate: a stroke produces pointer events at up to 240 Hz on
 * a stylus, and routing those through reactive state would mean a render per
 * sample. The controller writes to the canvas directly and Vue only hears
 * about meaningful changes, such as the pad becoming non-empty.
 */

export interface SignaturePadExposed {
  clear(): void
  undo(): void
  redo(): void
  isEmpty(): boolean
  toSignature(): InkSignature | undefined
  toDataUrl(type?: string): string | undefined
  toSvg(): string | undefined
}

export const SignaturePad = defineComponent({
  name: 'InkSignSignaturePad',
  props: {
    color: { type: String, default: undefined },
    background: { type: String, default: undefined },
    size: { type: Number, default: undefined },
    thinning: { type: Number, default: undefined },
    height: { type: [Number, String] as PropType<number | string>, default: 180 },
    label: { type: String, default: 'Signature drawing area' },
    initialSignature: { type: Object as PropType<InkSignature>, default: undefined },
  },
  emits: {
    change: (_state: { isEmpty: boolean; strokeCount: number }) => true,
    signature: (_signature: InkSignature | undefined) => true,
  },
  setup(props, { emit, expose }) {
    const canvasRef = ref<HTMLCanvasElement | null>(null)
    const controller = shallowRef<PadController | undefined>(undefined)
    const isEmpty = ref(true)
    let observer: ResizeObserver | undefined

    const padOptions = (): SignaturePadOptions => ({
      ...(props.color !== undefined ? { color: props.color } : {}),
      ...(props.background !== undefined ? { background: props.background } : {}),
      ...(props.size !== undefined ? { size: props.size } : {}),
      ...(props.thinning !== undefined ? { thinning: props.thinning } : {}),
    })

    onMounted(() => {
      const canvas = canvasRef.value
      if (!canvas) return

      const pad = new PadController(canvas, {
        ...padOptions(),
        onChange: (state) => {
          isEmpty.value = state.isEmpty
          emit('change', state)
        },
        onStrokeEnd: () => {
          emit('signature', pad.toSignature())
        },
      })
      controller.value = pad

      if (props.initialSignature) pad.fromSignature(props.initialSignature)

      const ResizeObserverCtor = (globalThis as { ResizeObserver?: typeof ResizeObserver })
        .ResizeObserver
      if (ResizeObserverCtor) {
        observer = new ResizeObserverCtor(() => pad.resize())
        observer.observe(canvas)
      }
    })

    onBeforeUnmount(() => {
      observer?.disconnect()
      controller.value?.dispose()
      controller.value = undefined
    })

    // Options are applied in place rather than by rebuilding the pad, which
    // would discard whatever the signer had already drawn.
    watch(
      () => [props.color, props.background, props.size, props.thinning],
      () => controller.value?.setOptions(padOptions()),
    )

    expose({
      clear: () => controller.value?.clear(),
      undo: () => controller.value?.undo(),
      redo: () => controller.value?.redo(),
      isEmpty: () => controller.value?.isEmpty ?? true,
      toSignature: () => controller.value?.toSignature(),
      toDataUrl: (type?: string) => controller.value?.toDataUrl(type),
      toSvg: () => controller.value?.toSvg(),
    } satisfies SignaturePadExposed)

    return () => {
      const frame: CSSProperties = {
        position: 'relative',
        height: typeof props.height === 'number' ? `${props.height}px` : props.height,
        background: 'var(--inksign-surface-raised, #fff)',
        border: `var(--inksign-border-width, 1px) ${isEmpty.value ? 'dashed' : 'solid'} var(--inksign-border-strong, #b9bdc9)`,
        borderRadius: 'var(--inksign-radius, 8px)',
        overflow: 'hidden',
      }

      return h('div', { 'data-inksign-pad': '', style: frame }, [
        h('div', {
          'aria-hidden': 'true',
          style: {
            position: 'absolute',
            left: '12px',
            right: '12px',
            bottom: '28%',
            borderBottom: '1px solid var(--inksign-border, #dfe1e8)',
            pointerEvents: 'none',
          } satisfies CSSProperties,
        }),
        isEmpty.value
          ? h(
              'span',
              {
                'aria-hidden': 'true',
                style: {
                  position: 'absolute',
                  left: '50%',
                  bottom: 'calc(28% - 24px)',
                  transform: 'translateX(-50%)',
                  fontFamily: 'var(--inksign-font-family, system-ui, sans-serif)',
                  fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
                  color: 'var(--inksign-text-muted, #5c6070)',
                  pointerEvents: 'none',
                } satisfies CSSProperties,
              },
              'Draw your signature',
            )
          : null,
        h('canvas', {
          ref: canvasRef,
          role: 'img',
          'aria-label': props.label,
          tabindex: 0,
          style: {
            display: 'block',
            position: 'absolute',
            inset: '0',
            width: '100%',
            height: '100%',
            cursor: 'crosshair',
          } satisfies CSSProperties,
        }),
      ])
    }
  },
})

/**
 * Typed signature picker.
 *
 * Typing is the option most signers take, so it gets a real implementation
 * rather than a plain text input. No webfont is bundled: shipping a typeface
 * with a signature library means shipping its licence too, so the default
 * stack uses faces already present on the platform.
 */
export const TypedSignature = defineComponent({
  name: 'InkSignTypedSignature',
  props: {
    name: { type: String, required: true },
    typefaces: {
      type: Array as PropType<readonly { label: string; stack: string }[]>,
      default: undefined,
    },
  },
  emits: {
    signature: (_signature: InkSignature) => true,
  },
  setup(props, { emit }) {
    const text = ref(props.name)
    const selected = ref(0)

    watch(
      () => props.name,
      (next) => {
        text.value = next
      },
    )

    const options = (): readonly { label: string; stack: string }[] =>
      props.typefaces ?? [{ label: 'Script', stack: scriptFontStack }]

    const emitSignature = (): void => {
      const stack = options()[selected.value]?.stack ?? scriptFontStack
      emit('signature', createTypedSignature({ text: text.value, typeface: stack }))
    }

    return () =>
      h('div', { 'data-inksign-typed': '' }, [
        h(
          'label',
          {
            style: {
              display: 'block',
              fontFamily: 'var(--inksign-font-family, system-ui, sans-serif)',
              fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
              color: 'var(--inksign-text-muted, #5c6070)',
              marginBottom: 'var(--inksign-space-2, 8px)',
            } satisfies CSSProperties,
          },
          [
            'Full name',
            h('input', {
              value: text.value,
              onInput: (event: Event) => {
                text.value = (event.target as HTMLInputElement).value
                emitSignature()
              },
              style: {
                display: 'block',
                width: '100%',
                marginTop: '4px',
                padding: 'var(--inksign-space-2, 8px)',
                font: 'inherit',
                fontSize: 'var(--inksign-font-size-base, 0.9375rem)',
                color: 'var(--inksign-text, #14161d)',
                background: 'var(--inksign-surface-raised, #fff)',
                border: 'var(--inksign-border-width, 1px) solid var(--inksign-border, #dfe1e8)',
                borderRadius: 'var(--inksign-radius-small, 4px)',
              } satisfies CSSProperties,
            }),
          ],
        ),
        // A real fieldset with real radio inputs rather than buttons with
        // role="radio": arrow-key navigation and grouping semantics come for
        // free, and neither has to be reimplemented.
        h(
          'fieldset',
          {
            style: {
              display: 'grid',
              gap: '8px',
              margin: '0',
              padding: '0',
              border: 'none',
            } satisfies CSSProperties,
          },
          [
            h(
              'legend',
              {
                style: {
                  fontFamily: 'var(--inksign-font-family, system-ui, sans-serif)',
                  fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
                  color: 'var(--inksign-text-muted, #5c6070)',
                  padding: '0',
                  marginBottom: 'var(--inksign-space-2, 8px)',
                } satisfies CSSProperties,
              },
              'Signature style',
            ),
            ...options().map((option, index) =>
              h(
                'label',
                {
                  key: option.label,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    padding: 'var(--inksign-space-3, 12px)',
                    cursor: 'pointer',
                    background:
                      selected.value === index
                        ? 'var(--inksign-field-idle, rgba(31, 42, 94, 0.08))'
                        : 'var(--inksign-surface-raised, #fff)',
                    border: `var(--inksign-border-width, 1px) solid ${
                      selected.value === index
                        ? 'var(--inksign-primary, #1f2a5e)'
                        : 'var(--inksign-border, #dfe1e8)'
                    }`,
                    borderRadius: 'var(--inksign-radius, 8px)',
                  } satisfies CSSProperties,
                },
                [
                  h('input', {
                    type: 'radio',
                    name: 'inksign-typeface',
                    checked: selected.value === index,
                    onChange: () => {
                      selected.value = index
                      emitSignature()
                    },
                    style: {
                      position: 'absolute',
                      width: '1px',
                      height: '1px',
                      opacity: 0,
                      pointerEvents: 'none',
                    } satisfies CSSProperties,
                  }),
                  h(
                    'span',
                    {
                      style: {
                        fontFamily: option.stack,
                        fontSize: '1.75rem',
                        lineHeight: 1.2,
                        color: 'var(--inksign-ink, #14161d)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      } satisfies CSSProperties,
                    },
                    text.value || props.name,
                  ),
                  h(
                    'span',
                    {
                      style: {
                        fontFamily: 'var(--inksign-font-family, system-ui, sans-serif)',
                        fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
                        color: 'var(--inksign-text-muted, #5c6070)',
                      } satisfies CSSProperties,
                    },
                    option.label,
                  ),
                ],
              ),
            ),
          ],
        ),
      ])
  },
})

/** Lets a signer upload an image of their signature. */
export const UploadSignature = defineComponent({
  name: 'InkSignUploadSignature',
  props: {
    maxBytes: { type: Number, default: 2 * 1024 * 1024 },
  },
  emits: {
    signature: (_signature: InkSignature) => true,
    error: (_message: string) => true,
  },
  setup(props, { emit }) {
    const onFile = (file: File): void => {
      if (!file.type.startsWith('image/')) {
        emit('error', 'Choose an image file.')
        return
      }
      if (file.size > props.maxBytes) {
        emit('error', `That image is larger than ${Math.round(props.maxBytes / 1024 / 1024)} MB.`)
        return
      }

      const reader = new FileReader()
      reader.onerror = () => emit('error', 'That image could not be read.')
      reader.onload = () => {
        const dataUrl = String(reader.result)
        // The intrinsic size is needed so the signature is placed without
        // distortion, and only the decoded image knows it.
        const image = new Image()
        image.onerror = () => emit('error', 'That image could not be decoded.')
        image.onload = () => {
          emit(
            'signature',
            createUploadedSignature({
              dataUrl,
              width: image.naturalWidth,
              height: image.naturalHeight,
            }),
          )
        }
        image.src = dataUrl
      }
      reader.readAsDataURL(file)
    }

    return () =>
      h(
        'label',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--inksign-space-2, 8px)',
            padding: 'var(--inksign-space-5, 24px)',
            cursor: 'pointer',
            fontFamily: 'var(--inksign-font-family, system-ui, sans-serif)',
            fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
            color: 'var(--inksign-text-muted, #5c6070)',
            background: 'var(--inksign-surface-raised, #fff)',
            border: 'var(--inksign-border-width, 1px) dashed var(--inksign-border-strong, #b9bdc9)',
            borderRadius: 'var(--inksign-radius, 8px)',
          } satisfies CSSProperties,
        },
        [
          'Upload an image of your signature',
          h('input', {
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp',
            onChange: (event: Event) => {
              const file = (event.target as HTMLInputElement).files?.[0]
              if (file) onFile(file)
            },
            style: {
              position: 'absolute',
              width: '1px',
              height: '1px',
              padding: '0',
              margin: '-1px',
              overflow: 'hidden',
              clip: 'rect(0, 0, 0, 0)',
              border: '0',
            } satisfies CSSProperties,
          }),
        ],
      )
  },
})
