import type { Envelope, InkSignature, RecipientId } from '@inksign/core'
import { type Adapters, type AuditTrail, InkSignError } from '@inksign/core'
import { announce, describeProgress, type Theme, trapFocus } from '@inksign/ui'
import {
  type CSSProperties,
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  type PropType,
  ref,
  shallowRef,
  type VNode,
  watch,
} from 'vue'
import { useCanFinish, useSessionProgress, useSessionStage } from './composables.js'
import { provideInkSign, useInkSign, useSigningSession, useThemeStyle } from './context.js'
import { SignaturePad, TypedSignature, UploadSignature } from './SignaturePad.js'

/**
 * Provider component, for applications that prefer a component to a setup call.
 *
 * The envelope is read once when this mounts. A signing ceremony is not a view
 * over mutable props: swapping the envelope underneath a half-filled form
 * would silently discard input, so changing document means remounting with a
 * new `key`.
 */
export const InkSignProvider = defineComponent({
  name: 'InkSignProvider',
  props: {
    envelope: { type: Object as PropType<Envelope>, required: true },
    recipientId: { type: String as PropType<RecipientId | undefined>, default: undefined },
    theme: { type: Object as PropType<Theme | undefined>, default: undefined },
    adapters: { type: Object as PropType<Adapters | undefined>, default: undefined },
    trail: { type: Object as PropType<AuditTrail | undefined>, default: undefined },
    ignoreRouting: { type: Boolean, default: undefined },
    locale: { type: String, default: undefined },
  },
  emits: {
    sessionError: (_error: InkSignError) => true,
  },
  setup(props, { emit, slots }) {
    provideInkSign({
      envelope: props.envelope,
      recipientId: props.recipientId,
      theme: props.theme,
      adapters: props.adapters,
      trail: props.trail,
      ignoreRouting: props.ignoreRouting,
      locale: props.locale,
      onSessionError: (error) => emit('sessionError', error),
    })

    return () => slots.default?.()
  },
})

/**
 * The signing ceremony.
 *
 * The component renders the steps but decides nothing: whether consent is
 * needed, whether the signer may finish, and what is blocking them all come
 * from the session. That separation is what stops a custom front end from
 * accidentally letting someone sign without consenting, and it means this
 * component can be replaced wholesale without weakening the rules.
 */
export const SigningCeremony = defineComponent({
  name: 'InkSignSigningCeremony',
  emits: {
    completed: () => true,
    declined: (_reason: string) => true,
    error: (_error: InkSignError) => true,
  },
  setup(_props, { emit, slots }) {
    const session = useSigningSession()
    const { store, theme } = useInkSign()
    const themeStyle = useThemeStyle()
    const stage = useSessionStage()
    const progress = useSessionProgress()
    const finish = useCanFinish()

    const adoptOpen = ref(false)
    const busy = ref(false)
    const declining = ref(false)
    const declineReason = ref('')
    const pending = shallowRef<InkSignature | undefined>(undefined)

    const report = (error: unknown): void => {
      if (error instanceof InkSignError) emit('error', error)
      else throw error
    }

    // Announce progress so a screen reader user is told what changed rather
    // than having to go looking for it.
    let lastAnnounced = ''
    watch(
      () => [progress.value, stage.value] as const,
      ([current, currentStage]) => {
        if (currentStage !== 'filling' && currentStage !== 'review') return
        const message = describeProgress(current)
        if (message === lastAnnounced) return
        lastAnnounced = message
        announce(message)
      },
      { immediate: true },
    )

    const onAdopt = async (signature: InkSignature): Promise<void> => {
      try {
        const applied = await session.adoptSignature(signature)
        adoptOpen.value = false
        pending.value = undefined
        announce(
          applied.length === 1
            ? 'Signature applied to 1 field'
            : `Signature applied to ${applied.length} fields`,
        )
      } catch (error) {
        report(error)
      }
    }

    const onFinish = async (): Promise<void> => {
      busy.value = true
      try {
        await session.finish()
        announce('Signing complete', 'assertive')
        emit('completed')
      } catch (error) {
        report(error)
      } finally {
        busy.value = false
      }
    }

    const onDecline = async (reason: string): Promise<void> => {
      busy.value = true
      try {
        await session.decline(reason)
        emit('declined', reason)
      } catch (error) {
        report(error)
      } finally {
        busy.value = false
      }
    }

    return () => {
      const meta = store.getMeta()
      const children: (VNode | null)[] = [header(theme, meta.subject)]

      if (stage.value === 'authenticating') {
        children.push(h(AuthGate, { onError: report }))
      } else if (stage.value === 'consent') {
        children.push(
          h(ConsentGate, {
            onError: report,
            onDeclined: (reason: string) => emit('declined', reason),
          }),
        )
      } else if (stage.value === 'completed') {
        children.push(
          terminal(
            'Thank you',
            'Your signature has been recorded. You will receive a copy of the completed document.',
          ),
        )
      } else if (stage.value === 'declined') {
        children.push(terminal('Declined', 'You declined to sign. The sender has been notified.'))
      } else if (stage.value === 'delegated') {
        children.push(
          terminal(
            'Reassigned',
            'You passed this document to someone else. No further action is needed from you.',
          ),
        )
      } else {
        children.push(
          h('div', { style: { flex: 1, minHeight: 0 } satisfies CSSProperties }, slots.default?.()),
          actionBar({
            progress: progress.value,
            finish: finish.value,
            busy: busy.value,
            allowDecline: meta.settings.allowDecline,
            hasSignature: session.signature !== undefined,
            onAdoptClick: () => {
              adoptOpen.value = true
            },
            onFinish,
            onDeclineClick: () => {
              declining.value = true
            },
          }),
        )
      }

      if (declining.value) {
        children.push(
          dialog({
            title: 'Decline to sign',
            onClose: () => {
              declining.value = false
            },
            body: [
              h(
                'p',
                { style: { marginTop: 0, color: 'var(--inksign-text-muted, #5c6070)' } },
                'The sender will be told you declined. Let them know why.',
              ),
              h('textarea', {
                value: declineReason.value,
                rows: 3,
                'aria-label': 'Reason for declining',
                'data-inksign-autofocus': '',
                onInput: (event: Event) => {
                  declineReason.value = (event.target as HTMLTextAreaElement).value
                },
                style: {
                  width: '100%',
                  padding: 'var(--inksign-space-2, 8px)',
                  font: 'inherit',
                  border: 'var(--inksign-border-width, 1px) solid var(--inksign-border, #dfe1e8)',
                  borderRadius: 'var(--inksign-radius, 8px)',
                  resize: 'vertical',
                } satisfies CSSProperties,
              }),
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    gap: 'var(--inksign-space-2, 8px)',
                    justifyContent: 'flex-end',
                    marginTop: 'var(--inksign-space-3, 12px)',
                  } satisfies CSSProperties,
                },
                [
                  button('secondary', 'Cancel', false, () => {
                    declining.value = false
                  }),
                  button(
                    'danger',
                    'Decline to sign',
                    declineReason.value.trim().length === 0,
                    () => {
                      const reason = declineReason.value.trim()
                      declining.value = false
                      void onDecline(reason)
                    },
                  ),
                ],
              ),
            ],
          }),
        )
      }

      if (adoptOpen.value) {
        children.push(
          h(AdoptSignatureDialog, {
            name: session.recipient.name,
            onAdopt,
            onClose: () => {
              adoptOpen.value = false
            },
          }),
        )
      }

      return h(
        'div',
        {
          'data-inksign-ceremony': '',
          'data-inksign-scheme': theme.scheme,
          style: {
            ...themeStyle.value,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            fontFamily: 'var(--inksign-font-family, system-ui, sans-serif)',
            fontSize: 'var(--inksign-font-size-base, 0.9375rem)',
            color: 'var(--inksign-text, #14161d)',
            background: 'var(--inksign-surface, #fff)',
          } as CSSProperties,
        },
        children,
      )
    }
  },
})

function header(theme: Theme, subject: string): VNode {
  const { branding } = theme
  const items: (VNode | null)[] = []

  if (branding.logoUrl) {
    items.push(
      h('img', {
        src: branding.logoUrl,
        alt: branding.logoAlt ?? branding.name ?? '',
        style: {
          height: 'var(--inksign-logo-height, 32px)',
          width: 'auto',
        } satisfies CSSProperties,
      }),
    )
  } else if (branding.name) {
    items.push(
      h(
        'strong',
        { style: { fontWeight: 'var(--inksign-font-weight-bold, 650)' } satisfies CSSProperties },
        branding.name,
      ),
    )
  }

  items.push(
    h(
      'h1',
      {
        style: {
          margin: 0,
          fontSize: 'var(--inksign-font-size-large, 1.0625rem)',
          fontWeight: 'var(--inksign-font-weight-medium, 500)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        } satisfies CSSProperties,
      },
      subject,
    ),
  )

  if (branding.supportUrl || branding.supportEmail) {
    items.push(
      h(
        'a',
        {
          href: branding.supportUrl ?? `mailto:${branding.supportEmail ?? ''}`,
          style: {
            marginLeft: 'auto',
            fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
            color: 'var(--inksign-text-muted, #5c6070)',
          } satisfies CSSProperties,
        },
        'Need help?',
      ),
    )
  }

  return h(
    'header',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--inksign-space-3, 12px)',
        padding: 'var(--inksign-space-3, 12px) var(--inksign-space-4, 16px)',
        borderBottom: 'var(--inksign-border-width, 1px) solid var(--inksign-border, #dfe1e8)',
        background: 'var(--inksign-surface-raised, #fff)',
      } satisfies CSSProperties,
    },
    items,
  )
}

const AuthGate = defineComponent({
  name: 'InkSignAuthGate',
  props: { onError: { type: Function as PropType<(error: unknown) => void>, required: true } },
  setup(props) {
    const session = useSigningSession()
    const code = ref('')
    const failed = ref(false)
    const busy = ref(false)

    const submit = async (event: Event): Promise<void> => {
      event.preventDefault()
      busy.value = true
      failed.value = false
      try {
        const ok = await session.authenticate(code.value)
        if (!ok) {
          failed.value = true
          announce('That code was not correct', 'assertive')
        }
      } catch (error) {
        props.onError(error)
      } finally {
        busy.value = false
      }
    }

    return () =>
      panel('Verify your identity', [
        h(
          'p',
          { style: { color: 'var(--inksign-text-muted, #5c6070)', marginTop: 0 } },
          'Enter the access code the sender gave you.',
        ),
        h(
          'form',
          {
            onSubmit: submit,
            style: { display: 'grid', gap: 'var(--inksign-space-3, 12px)' } satisfies CSSProperties,
          },
          [
            h('input', {
              value: code.value,
              autocomplete: 'one-time-code',
              'aria-label': 'Access code',
              'aria-invalid': failed.value || undefined,
              onInput: (event: Event) => {
                code.value = (event.target as HTMLInputElement).value
              },
              style: {
                padding: 'var(--inksign-space-3, 12px)',
                font: 'inherit',
                letterSpacing: '0.2em',
                textAlign: 'center',
                border: `var(--inksign-border-width, 1px) solid ${
                  failed.value ? 'var(--inksign-danger, #b3261e)' : 'var(--inksign-border, #dfe1e8)'
                }`,
                borderRadius: 'var(--inksign-radius, 8px)',
              } satisfies CSSProperties,
            }),
            failed.value
              ? h(
                  'p',
                  { role: 'alert', style: { margin: 0, color: 'var(--inksign-danger, #b3261e)' } },
                  'That code was not correct. Check it and try again.',
                )
              : null,
            h(
              'button',
              {
                type: 'submit',
                disabled: busy.value || code.value.length === 0,
                style: primaryStyle(busy.value || code.value.length === 0),
              },
              busy.value ? 'Checking' : 'Continue',
            ),
          ],
        ),
      ])
  },
})

const ConsentGate = defineComponent({
  name: 'InkSignConsentGate',
  props: {
    onError: { type: Function as PropType<(error: unknown) => void>, required: true },
    onDeclined: { type: Function as PropType<(reason: string) => void>, required: true },
  },
  setup(props) {
    const session = useSigningSession()
    const { theme } = useInkSign()
    const accepted = ref(false)
    const busy = ref(false)

    const text =
      theme.branding.consentText ??
      'I agree to use an electronic record and an electronic signature for this transaction, and I understand that my electronic signature is legally binding, the same as a signature made with pen and paper.'

    return () =>
      panel('Electronic record and signature disclosure', [
        h('p', { style: { color: 'var(--inksign-text-muted, #5c6070)', lineHeight: 1.6 } }, text),
        theme.branding.consentUrl
          ? h('p', {}, [
              h(
                'a',
                { href: theme.branding.consentUrl, target: '_blank', rel: 'noreferrer' },
                'Read the full disclosure',
              ),
            ])
          : null,
        h(
          'label',
          {
            style: {
              display: 'flex',
              gap: 'var(--inksign-space-2, 8px)',
              alignItems: 'flex-start',
              margin: 'var(--inksign-space-4, 16px) 0',
              cursor: 'pointer',
            } satisfies CSSProperties,
          },
          [
            h('input', {
              type: 'checkbox',
              checked: accepted.value,
              onChange: (event: Event) => {
                accepted.value = (event.target as HTMLInputElement).checked
              },
              style: {
                marginTop: '3px',
                accentColor: 'var(--inksign-primary, #1f2a5e)',
              } satisfies CSSProperties,
            }),
            h('span', {}, 'I agree to sign electronically'),
          ],
        ),
        h('div', { style: { display: 'flex', gap: 'var(--inksign-space-2, 8px)' } }, [
          button('primary', 'Continue', !accepted.value || busy.value, async () => {
            busy.value = true
            try {
              await session.acceptConsent()
            } catch (error) {
              props.onError(error)
            } finally {
              busy.value = false
            }
          }),
          button('secondary', 'I do not agree', busy.value, async () => {
            busy.value = true
            try {
              await session.declineConsent()
              props.onDeclined('Declined the electronic record disclosure')
            } catch (error) {
              props.onError(error)
            } finally {
              busy.value = false
            }
          }),
        ]),
      ])
  },
})

/** Lets the signer draw, type or upload a signature, then adopt it. */
export const AdoptSignatureDialog = defineComponent({
  name: 'InkSignAdoptSignatureDialog',
  props: {
    name: { type: String, required: true },
    onAdopt: { type: Function as PropType<(signature: InkSignature) => void>, required: true },
    onClose: { type: Function as PropType<() => void>, required: true },
  },
  setup(props) {
    const tab = ref<'draw' | 'type' | 'upload'>('draw')
    const pending = shallowRef<InkSignature | undefined>(undefined)
    const error = ref<string | undefined>(undefined)
    const padRef = ref<{ clear(): void; undo(): void } | null>(null)

    const tabs = [
      { id: 'draw' as const, label: 'Draw' },
      { id: 'type' as const, label: 'Type' },
      { id: 'upload' as const, label: 'Upload' },
    ]

    return () =>
      dialog({
        title: 'Adopt your signature',
        width: 520,
        onClose: props.onClose,
        body: [
          h(
            'div',
            { role: 'tablist', style: { display: 'flex', gap: '4px', marginBottom: '16px' } },
            tabs.map((entry) =>
              h(
                'button',
                {
                  key: entry.id,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': tab.value === entry.id,
                  onClick: () => {
                    tab.value = entry.id
                    pending.value = undefined
                    error.value = undefined
                  },
                  style: {
                    padding: '6px 12px',
                    cursor: 'pointer',
                    font: 'inherit',
                    color: tab.value === entry.id ? 'var(--inksign-primary, #1f2a5e)' : 'inherit',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: `2px solid ${
                      tab.value === entry.id ? 'var(--inksign-primary, #1f2a5e)' : 'transparent'
                    }`,
                  } satisfies CSSProperties,
                },
                entry.label,
              ),
            ),
          ),
          tab.value === 'draw'
            ? h('div', {}, [
                h(SignaturePad, {
                  ref: padRef,
                  height: 180,
                  onSignature: (signature: InkSignature | undefined) => {
                    pending.value = signature
                  },
                }),
                h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } }, [
                  button('secondary', 'Clear', false, () => {
                    padRef.value?.clear()
                    pending.value = undefined
                  }),
                  button('secondary', 'Undo', false, () => padRef.value?.undo()),
                ]),
              ])
            : tab.value === 'type'
              ? h(TypedSignature, {
                  name: props.name,
                  onSignature: (signature: InkSignature) => {
                    pending.value = signature
                  },
                })
              : h(UploadSignature, {
                  onSignature: (signature: InkSignature) => {
                    pending.value = signature
                  },
                  onError: (message: string) => {
                    error.value = message
                  },
                }),
          error.value
            ? h(
                'p',
                { role: 'alert', style: { color: 'var(--inksign-danger, #b3261e)' } },
                error.value,
              )
            : null,
          h(
            'p',
            {
              style: {
                fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
                color: 'var(--inksign-text-muted, #5c6070)',
                lineHeight: 1.5,
              } satisfies CSSProperties,
            },
            'By adopting this signature you agree that it is the electronic representation of your signature, and that it will be used on this document and anywhere else you apply it.',
          ),
          h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } }, [
            button('secondary', 'Cancel', false, props.onClose),
            button('primary', 'Adopt and sign', !pending.value, () => {
              if (pending.value) props.onAdopt(pending.value)
            }),
          ]),
        ],
      })
  },
})

interface ActionBarArgs {
  progress: { requiredRemaining: number; ratio: number; filled: number; total: number }
  finish: { canFinish: boolean; reason: string | undefined }
  busy: boolean
  allowDecline: boolean
  hasSignature: boolean
  onAdoptClick: () => void
  onFinish: () => void
  onDeclineClick: () => void
}

function actionBar(args: ActionBarArgs): VNode {
  const controls: (VNode | null)[] = [
    h('div', { style: { flex: 1, minWidth: 0 } satisfies CSSProperties }, [
      h(
        'div',
        {
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': Math.round(args.progress.ratio * 100),
          'aria-label': 'Signing progress',
          style: {
            height: '6px',
            borderRadius: 'var(--inksign-radius-pill, 999px)',
            background: 'var(--inksign-surface-sunken, #f1f2f6)',
            overflow: 'hidden',
          } satisfies CSSProperties,
        },
        [
          h('div', {
            style: {
              width: `${args.progress.ratio * 100}%`,
              height: '100%',
              background: 'var(--inksign-primary, #1f2a5e)',
              transition: 'width var(--inksign-duration, 200ms) var(--inksign-easing, ease)',
            } satisfies CSSProperties,
          }),
        ],
      ),
      h(
        'p',
        {
          style: {
            margin: '4px 0 0',
            fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
            color: 'var(--inksign-text-muted, #5c6070)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          } satisfies CSSProperties,
        },
        args.finish.canFinish ? 'Ready to finish' : (args.finish.reason ?? ''),
      ),
    ]),
  ]

  if (!args.hasSignature) {
    controls.push(button('secondary', 'Adopt a signature', false, args.onAdoptClick))
  }
  if (args.allowDecline) {
    controls.push(button('secondary', 'Decline', args.busy, args.onDeclineClick))
  }
  controls.push(
    h(
      'button',
      {
        type: 'button',
        disabled: !args.finish.canFinish || args.busy,
        // The reason is on the button itself, so a disabled control still
        // explains itself.
        title: args.finish.canFinish ? undefined : args.finish.reason,
        onClick: args.onFinish,
        style: primaryStyle(!args.finish.canFinish || args.busy),
      },
      args.busy ? 'Finishing' : 'Finish',
    ),
  )

  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--inksign-space-3, 12px)',
        padding: 'var(--inksign-space-3, 12px) var(--inksign-space-4, 16px)',
        borderTop: 'var(--inksign-border-width, 1px) solid var(--inksign-border, #dfe1e8)',
        background: 'var(--inksign-surface-raised, #fff)',
      } satisfies CSSProperties,
    },
    controls,
  )
}

/**
 * Modal dialog with a focus trap.
 *
 * Trapping focus is not optional for a dialog: without it a keyboard user tabs
 * straight out into the document behind, with no way to tell they have left.
 */
const Dialog = defineComponent({
  name: 'InkSignDialog',
  props: {
    title: { type: String, required: true },
    width: { type: Number, default: 440 },
    onClose: { type: Function as PropType<() => void>, required: true },
  },
  setup(props, { slots }) {
    const panelRef = ref<HTMLElement | null>(null)
    let release: (() => void) | undefined

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }

    onMounted(() => {
      const element = panelRef.value
      if (!element) return
      release = trapFocus(element)
      element.ownerDocument.addEventListener('keydown', onKeyDown)
    })

    onBeforeUnmount(() => {
      panelRef.value?.ownerDocument.removeEventListener('keydown', onKeyDown)
      release?.()
    })

    return () =>
      h(
        'div',
        {
          // Clicking the backdrop is a convenience, not the only way out:
          // Escape is handled above and every dialog carries a Cancel control.
          onClick: (event: MouseEvent) => {
            if (event.target === event.currentTarget) props.onClose()
          },
          style: {
            position: 'fixed',
            inset: '0',
            zIndex: 1000,
            display: 'grid',
            placeItems: 'center',
            padding: '16px',
            background: 'rgba(10, 12, 18, 0.5)',
          } satisfies CSSProperties,
        },
        [
          h(
            'div',
            {
              ref: panelRef,
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': props.title,
              style: {
                width: '100%',
                maxWidth: `${props.width}px`,
                maxHeight: '90vh',
                overflow: 'auto',
                padding: 'var(--inksign-space-5, 24px)',
                background: 'var(--inksign-surface-raised, #fff)',
                borderRadius: 'var(--inksign-radius-large, 14px)',
                boxShadow: 'var(--inksign-shadow-high, 0 12px 32px rgba(20, 22, 29, 0.16))',
              } satisfies CSSProperties,
            },
            [
              h(
                'h2',
                {
                  style: {
                    margin: '0 0 var(--inksign-space-4, 16px)',
                    fontSize: 'var(--inksign-font-size-heading, 1.375rem)',
                  } satisfies CSSProperties,
                },
                props.title,
              ),
              slots.default?.(),
            ],
          ),
        ],
      )
  },
})

function dialog(args: {
  title: string
  body: (VNode | null)[]
  onClose: () => void
  width?: number
}): VNode {
  return h(
    Dialog,
    { title: args.title, onClose: args.onClose, ...(args.width ? { width: args.width } : {}) },
    { default: () => args.body },
  )
}

function panel(title: string, body: (VNode | null)[]): VNode {
  return h(
    'div',
    {
      style: {
        flex: 1,
        display: 'grid',
        placeItems: 'center',
        padding: '24px',
        minHeight: 0,
      } satisfies CSSProperties,
    },
    [
      h('div', { style: { width: '100%', maxWidth: '520px' } satisfies CSSProperties }, [
        h(
          'h2',
          {
            style: {
              marginTop: 0,
              fontSize: 'var(--inksign-font-size-heading, 1.375rem)',
            } satisfies CSSProperties,
          },
          title,
        ),
        ...body,
      ]),
    ],
  )
}

function terminal(title: string, body: string): VNode {
  return panel(title, [
    h('p', { style: { color: 'var(--inksign-text-muted, #5c6070)', lineHeight: 1.6 } }, body),
  ])
}

const buttonBase: CSSProperties = {
  padding: '9px 16px',
  font: 'inherit',
  fontWeight: 'var(--inksign-font-weight-medium, 500)',
  borderRadius: 'var(--inksign-radius, 8px)',
  border: 'var(--inksign-border-width, 1px) solid transparent',
  transition: 'background var(--inksign-duration-fast, 120ms) ease',
}

function primaryStyle(disabled: boolean): CSSProperties {
  return {
    ...buttonBase,
    color: 'var(--inksign-primary-contrast, #fff)',
    background: 'var(--inksign-primary, #1f2a5e)',
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
  }
}

function button(
  variant: 'primary' | 'secondary' | 'danger',
  label: string,
  disabled: boolean,
  onClick: () => void,
): VNode {
  const style: CSSProperties =
    variant === 'primary'
      ? primaryStyle(disabled)
      : {
          ...buttonBase,
          color:
            variant === 'danger'
              ? 'var(--inksign-danger-contrast, #fff)'
              : 'var(--inksign-text, #14161d)',
          background:
            variant === 'danger'
              ? 'var(--inksign-danger, #b3261e)'
              : 'var(--inksign-surface-raised, #fff)',
          borderColor: variant === 'danger' ? 'transparent' : 'var(--inksign-border, #dfe1e8)',
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }

  return h('button', { type: 'button', disabled, onClick, style }, label)
}
