import type { FieldId, InkSignature } from '@inksign/core'
import { InkSignError } from '@inksign/core'
import { announce, describeProgress, trapFocus } from '@inksign/ui'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useInkSign, useSigningSession, useThemeStyle } from './context.js'
import { SignaturePad, TypedSignature, UploadSignature, type SignaturePadHandle } from './SignaturePad.jsx'
import { useCanFinish, useSessionProgress, useSessionStage } from './hooks.js'

/**
 * The signing ceremony.
 *
 * The component renders the steps but decides nothing: whether consent is
 * needed, whether the signer may finish, and what is blocking them all come
 * from the session. That separation is what stops a custom front end from
 * accidentally letting someone sign without consenting, and it means this
 * component can be replaced wholesale without weakening the rules.
 */

export interface SigningCeremonyProps {
  /** Rendered as the document area, between the header and the action bar. */
  children: ReactNode
  onCompleted?: (() => void) | undefined
  onDeclined?: ((reason: string) => void) | undefined
  onError?: ((error: InkSignError) => void) | undefined
  /** Field the signer is currently on, for highlighting. */
  activeField?: FieldId | undefined
  className?: string | undefined
}

export function SigningCeremony({
  children,
  onCompleted,
  onDeclined,
  onError,
  className,
}: SigningCeremonyProps): ReactNode {
  const session = useSigningSession()
  const { store, theme } = useInkSign()
  const themeStyle = useThemeStyle()
  const stage = useSessionStage()
  const progress = useSessionProgress()
  const { canFinish, reason } = useCanFinish()

  const [adoptOpen, setAdoptOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const meta = store.getMeta()

  const report = useCallback(
    (error: unknown) => {
      if (error instanceof InkSignError) onError?.(error)
      else throw error
    },
    [onError],
  )

  // Announce progress so a screen reader user is told what changed rather
  // than having to go looking for it.
  const lastAnnounced = useRef('')
  useEffect(() => {
    if (stage !== 'filling' && stage !== 'review') return
    const message = describeProgress(progress)
    if (message === lastAnnounced.current) return
    lastAnnounced.current = message
    announce(message)
  }, [progress, stage])

  const onAdopt = useCallback(
    async (signature: InkSignature) => {
      try {
        const applied = await session.adoptSignature(signature)
        setAdoptOpen(false)
        announce(
          applied.length === 1
            ? 'Signature applied to 1 field'
            : `Signature applied to ${applied.length} fields`,
        )
      } catch (error) {
        report(error)
      }
    },
    [session, report],
  )

  const onFinish = useCallback(async () => {
    setBusy(true)
    try {
      await session.finish()
      announce('Signing complete', 'assertive')
      onCompleted?.()
    } catch (error) {
      report(error)
    } finally {
      setBusy(false)
    }
  }, [session, onCompleted, report])

  const onDecline = useCallback(
    async (declineReason: string) => {
      setBusy(true)
      try {
        await session.decline(declineReason)
        onDeclined?.(declineReason)
      } catch (error) {
        report(error)
      } finally {
        setBusy(false)
      }
    },
    [session, onDeclined, report],
  )

  return (
    <div
      className={className}
      data-inksign-ceremony=""
      data-inksign-scheme={theme.scheme}
      style={{
        ...themeStyle,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        fontFamily: 'var(--inksign-font-family, system-ui, sans-serif)',
        fontSize: 'var(--inksign-font-size-base, 0.9375rem)',
        color: 'var(--inksign-text, #14161d)',
        background: 'var(--inksign-surface, #fff)',
      }}
    >
      <CeremonyHeader subject={meta.subject} />

      {stage === 'authenticating' ? (
        <AuthGate onError={report} />
      ) : stage === 'consent' ? (
        <ConsentGate onError={report} onDeclined={onDeclined} />
      ) : stage === 'completed' ? (
        <TerminalPanel
          title="Thank you"
          body="Your signature has been recorded. You will receive a copy of the completed document."
        />
      ) : stage === 'declined' ? (
        <TerminalPanel
          title="Declined"
          body="You declined to sign. The sender has been notified."
        />
      ) : stage === 'delegated' ? (
        <TerminalPanel
          title="Reassigned"
          body="You passed this document to someone else. No further action is needed from you."
        />
      ) : (
        <>
          <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
          <ActionBar
            progress={progress}
            canFinish={canFinish}
            blockingReason={reason}
            busy={busy}
            allowDecline={meta.settings.allowDecline}
            onAdoptClick={() => setAdoptOpen(true)}
            onFinish={onFinish}
            onDecline={onDecline}
            hasSignature={session.signature !== undefined}
          />
        </>
      )}

      {adoptOpen ? (
        <AdoptSignatureDialog
          name={session.recipient.name}
          onAdopt={onAdopt}
          onClose={() => setAdoptOpen(false)}
        />
      ) : null}
    </div>
  )
}

function CeremonyHeader({ subject }: { subject: string }): ReactNode {
  const { theme } = useInkSign()
  const { branding } = theme

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--inksign-space-3, 12px)',
        padding: 'var(--inksign-space-3, 12px) var(--inksign-space-4, 16px)',
        borderBottom: 'var(--inksign-border-width, 1px) solid var(--inksign-border, #dfe1e8)',
        background: 'var(--inksign-surface-raised, #fff)',
      }}
    >
      {branding.logoUrl ? (
        <img
          src={branding.logoUrl}
          alt={branding.logoAlt ?? branding.name ?? ''}
          style={{ height: 'var(--inksign-logo-height, 32px)', width: 'auto' }}
        />
      ) : branding.name ? (
        <strong style={{ fontWeight: 'var(--inksign-font-weight-bold, 650)' }}>
          {branding.name}
        </strong>
      ) : null}

      <h1
        style={{
          margin: 0,
          fontSize: 'var(--inksign-font-size-large, 1.0625rem)',
          fontWeight: 'var(--inksign-font-weight-medium, 500)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {subject}
      </h1>

      {branding.supportUrl || branding.supportEmail ? (
        <a
          href={branding.supportUrl ?? `mailto:${branding.supportEmail ?? ''}`}
          style={{
            marginLeft: 'auto',
            fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
            color: 'var(--inksign-text-muted, #5c6070)',
          }}
        >
          Need help?
        </a>
      ) : null}
    </header>
  )
}

function AuthGate({ onError }: { onError: (error: unknown) => void }): ReactNode {
  const session = useSigningSession()
  const [code, setCode] = useState('')
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      setBusy(true)
      setFailed(false)
      try {
        const ok = await session.authenticate(code)
        if (!ok) {
          setFailed(true)
          announce('That code was not correct', 'assertive')
        }
      } catch (error) {
        onError(error)
      } finally {
        setBusy(false)
      }
    },
    [session, code, onError],
  )

  return (
    <Panel title="Verify your identity">
      <p style={{ color: 'var(--inksign-text-muted, #5c6070)', marginTop: 0 }}>
        Enter the access code the sender gave you.
      </p>
      <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--inksign-space-3, 12px)' }}>
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="one-time-code"
          aria-invalid={failed || undefined}
          aria-label="Access code"
          style={{
            padding: 'var(--inksign-space-3, 12px)',
            font: 'inherit',
            letterSpacing: '0.2em',
            textAlign: 'center',
            border: `var(--inksign-border-width, 1px) solid ${
              failed ? 'var(--inksign-danger, #b3261e)' : 'var(--inksign-border, #dfe1e8)'
            }`,
            borderRadius: 'var(--inksign-radius, 8px)',
          }}
        />
        {failed ? (
          <p role="alert" style={{ margin: 0, color: 'var(--inksign-danger, #b3261e)' }}>
            That code was not correct. Check it and try again.
          </p>
        ) : null}
        <PrimaryButton type="submit" disabled={busy || code.length === 0}>
          {busy ? 'Checking' : 'Continue'}
        </PrimaryButton>
      </form>
    </Panel>
  )
}

function ConsentGate({
  onError,
  onDeclined,
}: {
  onError: (error: unknown) => void
  onDeclined?: ((reason: string) => void) | undefined
}): ReactNode {
  const session = useSigningSession()
  const { theme } = useInkSign()
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)

  const text =
    theme.branding.consentText ??
    'I agree to use an electronic record and an electronic signature for this transaction, and I understand that my electronic signature is legally binding, the same as a signature made with pen and paper.'

  return (
    <Panel title="Electronic record and signature disclosure">
      <p style={{ color: 'var(--inksign-text-muted, #5c6070)', lineHeight: 1.6 }}>{text}</p>

      {theme.branding.consentUrl ? (
        <p>
          <a href={theme.branding.consentUrl} target="_blank" rel="noreferrer">
            Read the full disclosure
          </a>
        </p>
      ) : null}

      <label
        style={{
          display: 'flex',
          gap: 'var(--inksign-space-2, 8px)',
          alignItems: 'flex-start',
          margin: 'var(--inksign-space-4, 16px) 0',
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
          style={{ marginTop: 3, accentColor: 'var(--inksign-primary, #1f2a5e)' }}
        />
        <span>I agree to sign electronically</span>
      </label>

      <div style={{ display: 'flex', gap: 'var(--inksign-space-2, 8px)' }}>
        <PrimaryButton
          disabled={!accepted || busy}
          onClick={async () => {
            setBusy(true)
            try {
              await session.acceptConsent()
            } catch (error) {
              onError(error)
            } finally {
              setBusy(false)
            }
          }}
        >
          Continue
        </PrimaryButton>
        <SecondaryButton
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await session.declineConsent()
              onDeclined?.('Declined the electronic record disclosure')
            } catch (error) {
              onError(error)
            } finally {
              setBusy(false)
            }
          }}
        >
          I do not agree
        </SecondaryButton>
      </div>
    </Panel>
  )
}

interface ActionBarProps {
  progress: { requiredRemaining: number; ratio: number; filled: number; total: number }
  canFinish: boolean
  blockingReason: string | undefined
  busy: boolean
  allowDecline: boolean
  hasSignature: boolean
  onAdoptClick: () => void
  onFinish: () => void
  onDecline: (reason: string) => void
}

function ActionBar({
  progress,
  canFinish,
  blockingReason,
  busy,
  allowDecline,
  hasSignature,
  onAdoptClick,
  onFinish,
  onDecline,
}: ActionBarProps): ReactNode {
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--inksign-space-3, 12px)',
        padding: 'var(--inksign-space-3, 12px) var(--inksign-space-4, 16px)',
        borderTop: 'var(--inksign-border-width, 1px) solid var(--inksign-border, #dfe1e8)',
        background: 'var(--inksign-surface-raised, #fff)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress.ratio * 100)}
          aria-label="Signing progress"
          style={{
            height: 6,
            borderRadius: 'var(--inksign-radius-pill, 999px)',
            background: 'var(--inksign-surface-sunken, #f1f2f6)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${progress.ratio * 100}%`,
              height: '100%',
              background: 'var(--inksign-primary, #1f2a5e)',
              transition: 'width var(--inksign-duration, 200ms) var(--inksign-easing, ease)',
            }}
          />
        </div>
        <p
          style={{
            margin: '4px 0 0',
            fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
            color: 'var(--inksign-text-muted, #5c6070)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {canFinish ? 'Ready to finish' : blockingReason}
        </p>
      </div>

      {!hasSignature ? (
        <SecondaryButton onClick={onAdoptClick}>Adopt a signature</SecondaryButton>
      ) : null}

      {allowDecline ? (
        <SecondaryButton onClick={() => setDeclining(true)} disabled={busy}>
          Decline
        </SecondaryButton>
      ) : null}

      <PrimaryButton
        onClick={onFinish}
        disabled={!canFinish || busy}
        // The reason is on the button itself, so a disabled control still
        // explains itself to a screen reader.
        title={canFinish ? undefined : blockingReason}
      >
        {busy ? 'Finishing' : 'Finish'}
      </PrimaryButton>

      {declining ? (
        <Dialog title="Decline to sign" onClose={() => setDeclining(false)}>
          <p style={{ marginTop: 0, color: 'var(--inksign-text-muted, #5c6070)' }}>
            The sender will be told you declined. Let them know why.
          </p>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            aria-label="Reason for declining"
            data-inksign-autofocus=""
            style={{
              width: '100%',
              padding: 'var(--inksign-space-2, 8px)',
              font: 'inherit',
              border: 'var(--inksign-border-width, 1px) solid var(--inksign-border, #dfe1e8)',
              borderRadius: 'var(--inksign-radius, 8px)',
              resize: 'vertical',
            }}
          />
          <div
            style={{
              display: 'flex',
              gap: 'var(--inksign-space-2, 8px)',
              justifyContent: 'flex-end',
              marginTop: 'var(--inksign-space-3, 12px)',
            }}
          >
            <SecondaryButton onClick={() => setDeclining(false)}>Cancel</SecondaryButton>
            <DangerButton
              disabled={reason.trim().length === 0}
              onClick={() => {
                setDeclining(false)
                onDecline(reason.trim())
              }}
            >
              Decline to sign
            </DangerButton>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

export interface AdoptSignatureDialogProps {
  name: string
  onAdopt: (signature: InkSignature) => void
  onClose: () => void
}

/** Lets the signer draw, type or upload a signature, then adopt it. */
export function AdoptSignatureDialog({
  name,
  onAdopt,
  onClose,
}: AdoptSignatureDialogProps): ReactNode {
  const [tab, setTab] = useState<'draw' | 'type' | 'upload'>('draw')
  const [pending, setPending] = useState<InkSignature | undefined>()
  const [error, setError] = useState<string | undefined>()
  const padRef = useRef<SignaturePadHandle | null>(null)

  const tabs: readonly { id: typeof tab; label: string }[] = [
    { id: 'draw', label: 'Draw' },
    { id: 'type', label: 'Type' },
    { id: 'upload', label: 'Upload' },
  ]

  return (
    <Dialog title="Adopt your signature" onClose={onClose} width={520}>
      <div role="tablist" style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => {
              setTab(entry.id)
              setPending(undefined)
              setError(undefined)
            }}
            style={{
              padding: '6px 12px',
              cursor: 'pointer',
              font: 'inherit',
              color: tab === entry.id ? 'var(--inksign-primary, #1f2a5e)' : 'inherit',
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${
                tab === entry.id ? 'var(--inksign-primary, #1f2a5e)' : 'transparent'
              }`,
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'draw' ? (
        <>
          <SignaturePad ref={padRef} onSignature={setPending} height={180} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <SecondaryButton
              onClick={() => {
                padRef.current?.clear()
                setPending(undefined)
              }}
            >
              Clear
            </SecondaryButton>
            <SecondaryButton onClick={() => padRef.current?.undo()}>Undo</SecondaryButton>
          </div>
        </>
      ) : tab === 'type' ? (
        <TypedSignature name={name} onChange={setPending} />
      ) : (
        <UploadSignature onChange={setPending} onError={setError} />
      )}

      {error ? (
        <p role="alert" style={{ color: 'var(--inksign-danger, #b3261e)' }}>
          {error}
        </p>
      ) : null}

      <p
        style={{
          fontSize: 'var(--inksign-font-size-small, 0.8125rem)',
          color: 'var(--inksign-text-muted, #5c6070)',
          lineHeight: 1.5,
        }}
      >
        By adopting this signature you agree that it is the electronic
        representation of your signature, and that it will be used on this
        document and anywhere else you apply it.
      </p>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton
          disabled={!pending}
          onClick={() => {
            if (pending) onAdopt(pending)
          }}
        >
          Adopt and sign
        </PrimaryButton>
      </div>
    </Dialog>
  )
}

/**
 * Modal dialog with a focus trap.
 *
 * Trapping focus is not optional for a dialog: without it a keyboard user
 * tabs straight out into the document behind, with no way to tell they have
 * left the dialog.
 */
function Dialog({
  title,
  children,
  onClose,
  width = 440,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  width?: number
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const release = trapFocus(element)

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    element.ownerDocument.addEventListener('keydown', onKeyDown)

    return () => {
      element.ownerDocument.removeEventListener('keydown', onKeyDown)
      release()
    }
  }, [onClose])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        background: 'rgba(10, 12, 18, 0.5)',
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width: '100%',
          maxWidth: width,
          maxHeight: '90vh',
          overflow: 'auto',
          padding: 'var(--inksign-space-5, 24px)',
          background: 'var(--inksign-surface-raised, #fff)',
          borderRadius: 'var(--inksign-radius-large, 14px)',
          boxShadow: 'var(--inksign-shadow-high, 0 12px 32px rgba(20, 22, 29, 0.16))',
        }}
      >
        <h2
          style={{
            margin: '0 0 var(--inksign-space-4, 16px)',
            fontSize: 'var(--inksign-font-size-heading, 1.375rem)',
          }}
        >
          {title}
        </h2>
        {children}
      </div>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24, minHeight: 0 }}>
      <div style={{ width: '100%', maxWidth: 520 }}>
        <h2 style={{ marginTop: 0, fontSize: 'var(--inksign-font-size-heading, 1.375rem)' }}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  )
}

function TerminalPanel({ title, body }: { title: string; body: string }): ReactNode {
  return (
    <Panel title={title}>
      <p style={{ color: 'var(--inksign-text-muted, #5c6070)', lineHeight: 1.6 }}>{body}</p>
    </Panel>
  )
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>

const buttonBase: React.CSSProperties = {
  padding: '9px 16px',
  font: 'inherit',
  fontWeight: 'var(--inksign-font-weight-medium, 500)',
  cursor: 'pointer',
  borderRadius: 'var(--inksign-radius, 8px)',
  border: 'var(--inksign-border-width, 1px) solid transparent',
  transition: 'background var(--inksign-duration-fast, 120ms) ease',
}

export function PrimaryButton({ style, ...props }: ButtonProps): ReactNode {
  return (
    <button
      type="button"
      {...props}
      style={{
        ...buttonBase,
        color: 'var(--inksign-primary-contrast, #fff)',
        background: 'var(--inksign-primary, #1f2a5e)',
        opacity: props.disabled ? 0.5 : 1,
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
    />
  )
}

export function SecondaryButton({ style, ...props }: ButtonProps): ReactNode {
  return (
    <button
      type="button"
      {...props}
      style={{
        ...buttonBase,
        color: 'var(--inksign-text, #14161d)',
        background: 'var(--inksign-surface-raised, #fff)',
        borderColor: 'var(--inksign-border, #dfe1e8)',
        opacity: props.disabled ? 0.5 : 1,
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
    />
  )
}

export function DangerButton({ style, ...props }: ButtonProps): ReactNode {
  return (
    <button
      type="button"
      {...props}
      style={{
        ...buttonBase,
        color: 'var(--inksign-danger-contrast, #fff)',
        background: 'var(--inksign-danger, #b3261e)',
        opacity: props.disabled ? 0.5 : 1,
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
    />
  )
}
