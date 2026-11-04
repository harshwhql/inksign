import type { InkSignature } from '@inksign/core'
import {
  SignaturePad as PadController,
  createTypedSignature,
  createUploadedSignature,
  scriptFontStack,
  type SignaturePadOptions,
} from '@inksign/ui'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react'

/**
 * Signature capture.
 *
 * The drawing itself is owned by the controller from `@inksign/ui`, not by
 * React. That is deliberate: a stroke produces pointer events at up to 240 Hz
 * on a stylus, and routing those through React state would mean a render per
 * sample. The controller writes to the canvas directly and React only hears
 * about meaningful changes, such as the pad becoming non-empty.
 */

export interface SignaturePadHandle {
  clear(): void
  undo(): void
  redo(): void
  isEmpty(): boolean
  toSignature(): InkSignature | undefined
  toDataUrl(type?: string): string | undefined
  toSvg(): string | undefined
}

export interface SignaturePadProps extends Omit<SignaturePadOptions, 'onChange'> {
  /** Called whenever the drawn content changes. */
  onChange?: ((state: { isEmpty: boolean; strokeCount: number }) => void) | undefined
  /** Called with the finished signature when a stroke ends. */
  onSignature?: ((signature: InkSignature | undefined) => void) | undefined
  /** Restores a previously captured signature. */
  initialSignature?: InkSignature | undefined
  className?: string | undefined
  style?: React.CSSProperties | undefined
  /** Accessible label for the drawing surface. */
  label?: string | undefined
  height?: number | string | undefined
}

export const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(
  function SignaturePad(props, ref) {
    const {
      onChange,
      onSignature,
      initialSignature,
      className,
      style,
      label = 'Signature drawing area',
      height = 180,
      ...padOptions
    } = props

    const canvasRef = useRef<HTMLCanvasElement>(null)
    const controllerRef = useRef<PadController | undefined>(undefined)
    const [isEmpty, setIsEmpty] = useState(true)

    // Callbacks live in a ref so a changing inline handler does not tear down
    // and rebuild the pad, which would wipe the drawing.
    const handlers = useRef({ onChange, onSignature })
    handlers.current = { onChange, onSignature }

    useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return

      const controller = new PadController(canvas, {
        ...padOptions,
        onChange: (state) => {
          setIsEmpty(state.isEmpty)
          handlers.current.onChange?.(state)
        },
        onStrokeEnd: () => {
          handlers.current.onSignature?.(controller.toSignature())
        },
      })
      controllerRef.current = controller

      if (initialSignature) controller.fromSignature(initialSignature)

      const ResizeObserverCtor = (globalThis as { ResizeObserver?: typeof ResizeObserver })
        .ResizeObserver
      const observer = ResizeObserverCtor
        ? new ResizeObserverCtor(() => controller.resize())
        : undefined
      if (observer) observer.observe(canvas)

      return () => {
        observer?.disconnect()
        controller.dispose()
        controllerRef.current = undefined
      }
      // Option changes are applied below rather than by remounting, so the
      // effect intentionally does not depend on them.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Apply option changes in place, keeping the drawing.
    const optionsKey = JSON.stringify(padOptions)
    useEffect(() => {
      controllerRef.current?.setOptions(padOptions)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [optionsKey])

    useImperativeHandle(
      ref,
      () => ({
        clear: () => controllerRef.current?.clear(),
        undo: () => controllerRef.current?.undo(),
        redo: () => controllerRef.current?.redo(),
        isEmpty: () => controllerRef.current?.isEmpty ?? true,
        toSignature: () => controllerRef.current?.toSignature(),
        toDataUrl: (type?: string) => controllerRef.current?.toDataUrl(type),
        toSvg: () => controllerRef.current?.toSvg(),
      }),
      [],
    )

    return (
      <div
        className={className}
        data-inksign-pad=""
        data-empty={isEmpty ? '' : undefined}
        style={{
          position: 'relative',
          height,
          background: 'var(--inksign-surface-raised, #fff)',
          border: `var(--inksign-border-width, 1px) ${isEmpty ? 'dashed' : 'solid'} var(--inksign-border-strong, #b9bdc9)`,
          borderRadius: 'var(--inksign-radius, 8px)',
          overflow: 'hidden',
          ...style,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: '28%',
            borderBottom: '1px solid var(--inksign-border, #dfe1e8)',
            pointerEvents: 'none',
          }}
        />
        {isEmpty ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 'calc(28% - 24px)',
              transform: 'translateX(-50%)',
              fontFamily: 'var(--inksign-font-family, system-ui, sans-serif)',
              fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
              color: 'var(--inksign-text-muted, #5c6070)',
              pointerEvents: 'none',
            }}
          >
            Draw your signature
          </span>
        ) : null}
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={label}
          tabIndex={0}
          style={{
            display: 'block',
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            cursor: 'crosshair',
          }}
        />
      </div>
    )
  },
)

export interface TypedSignatureProps {
  /** The signer's name, used as the signature text. */
  name: string
  onChange?: ((signature: InkSignature) => void) | undefined
  /** Font stacks to offer. Defaults to a single script stack. */
  typefaces?: readonly { label: string; stack: string }[] | undefined
  className?: string | undefined
}

/**
 * Typed signature picker.
 *
 * Typing is the option most signers take, so it gets a real implementation
 * rather than a plain text input. No webfont is bundled: shipping a typeface
 * with a signature library means shipping its licence too, so the default
 * stack uses faces already present on the platform and falls back to the
 * generic `cursive`.
 */
export function TypedSignature({
  name,
  onChange,
  typefaces,
  className,
}: TypedSignatureProps): ReactNode {
  const options = typefaces ?? [{ label: 'Script', stack: scriptFontStack }]
  const [selected, setSelected] = useState(0)
  const [text, setText] = useState(name)

  const emit = useCallback(
    (value: string, index: number) => {
      const stack = options[index]?.stack ?? scriptFontStack
      onChange?.(createTypedSignature({ text: value, typeface: stack }))
    },
    [onChange, options],
  )

  useEffect(() => {
    setText(name)
  }, [name])

  return (
    <div className={className} data-inksign-typed="">
      <label
        style={{
          display: 'block',
          fontFamily: 'var(--inksign-font-family, system-ui, sans-serif)',
          fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
          color: 'var(--inksign-text-muted, #5c6070)',
          marginBottom: 'var(--inksign-space-2, 8px)',
        }}
      >
        Full name
        <input
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            emit(event.target.value, selected)
          }}
          style={{
            display: 'block',
            width: '100%',
            marginTop: 4,
            padding: 'var(--inksign-space-2, 8px)',
            font: 'inherit',
            fontSize: 'var(--inksign-font-size-base, 0.9375rem)',
            color: 'var(--inksign-text, #14161d)',
            background: 'var(--inksign-surface-raised, #fff)',
            border: 'var(--inksign-border-width, 1px) solid var(--inksign-border, #dfe1e8)',
            borderRadius: 'var(--inksign-radius-small, 4px)',
          }}
        />
      </label>

      <div role="radiogroup" aria-label="Signature style" style={{ display: 'grid', gap: 8 }}>
        {options.map((option, index) => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={selected === index}
            onClick={() => {
              setSelected(index)
              emit(text, index)
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: 'var(--inksign-space-3, 12px)',
              cursor: 'pointer',
              textAlign: 'left',
              background:
                selected === index
                  ? 'var(--inksign-field-idle, rgba(31, 42, 94, 0.08))'
                  : 'var(--inksign-surface-raised, #fff)',
              border: `var(--inksign-border-width, 1px) solid ${
                selected === index
                  ? 'var(--inksign-primary, #1f2a5e)'
                  : 'var(--inksign-border, #dfe1e8)'
              }`,
              borderRadius: 'var(--inksign-radius, 8px)',
            }}
          >
            <span
              style={{
                fontFamily: option.stack,
                fontSize: '1.75rem',
                lineHeight: 1.2,
                color: 'var(--inksign-ink, #14161d)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {text || name}
            </span>
            <span
              style={{
                fontFamily: 'var(--inksign-font-family, system-ui, sans-serif)',
                fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
                color: 'var(--inksign-text-muted, #5c6070)',
              }}
            >
              {option.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export interface UploadSignatureProps {
  onChange?: ((signature: InkSignature) => void) | undefined
  /** Maximum file size in bytes. Defaults to 2 MB. */
  maxBytes?: number | undefined
  onError?: ((message: string) => void) | undefined
  className?: string | undefined
}

/** Lets a signer upload an image of their signature. */
export function UploadSignature({
  onChange,
  maxBytes = 2 * 1024 * 1024,
  onError,
  className,
}: UploadSignatureProps): ReactNode {
  const onFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith('image/')) {
        onError?.('Choose an image file.')
        return
      }
      if (file.size > maxBytes) {
        onError?.(`That image is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`)
        return
      }

      const reader = new FileReader()
      reader.onerror = () => onError?.('That image could not be read.')
      reader.onload = () => {
        const dataUrl = String(reader.result)
        // The intrinsic size is needed so the signature is placed without
        // distortion, and only the decoded image knows it.
        const image = new Image()
        image.onerror = () => onError?.('That image could not be decoded.')
        image.onload = () => {
          onChange?.(
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
    },
    [maxBytes, onChange, onError],
  )

  return (
    <label
      className={className}
      style={{
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
      }}
    >
      Upload an image of your signature
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onFile(file)
        }}
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          border: 0,
        }}
      />
    </label>
  )
}
