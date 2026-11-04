import {
  type Adapters,
  AuditTrail,
  createEnvelope,
  type Envelope,
  MemoryIdentityAdapter,
  type RecipientId,
} from '@inksign/core'
import { applyAnchors, configureWorker, loadDocument } from '@inksign/pdf'
import {
  DocumentViewer,
  FieldInput,
  InkSignProvider,
  SigningCeremony,
  useDocument,
  useInkSign,
} from '@inksign/react'
import { createTheme } from '@inksign/ui'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { createSampleAgreement } from './sample-agreement.js'

// pdf.js needs to be told where its worker lives, because only the
// application knows how its bundler serves assets. Without this it falls back
// to the main thread and blocks every interaction while a page rasterizes.
const workerUrl = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href

const ACCESS_CODE = '4821'

export function App(): ReactNode {
  const [envelope, setEnvelope] = useState<Envelope>()
  const [signerId, setSignerId] = useState<RecipientId>()
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<'completed' | 'declined'>()

  const trail = useMemo(() => new AuditTrail('env_example'), [])

  const theme = useMemo(
    () =>
      createTheme({
        brandColor: '#2f5d50',
        branding: {
          name: 'Northwind Legal',
          supportEmail: 'help@northwind.example',
        },
      }),
    [],
  )

  const adapters = useMemo<Adapters>(() => ({}), [])

  useEffect(() => {
    let cancelled = false

    const prepare = async (): Promise<void> => {
      await configureWorker(workerUrl)

      const bytes = await createSampleAgreement()
      const loaded = await loadDocument({ kind: 'bytes', bytes })

      // Place fields against the text rather than at guessed coordinates, so
      // the example keeps working if the agreement is reworded.
      const draft = createEnvelope({
        subject: 'Mutual nondisclosure agreement',
        message: 'Please review and sign at your convenience.',
      })
        .document('nda', {
          name: 'Mutual NDA.pdf',
          source: { kind: 'bytes', bytes },
          pageCount: loaded.pageCount,
          pageSizes: loaded.pageSizes,
        })
        .signer('alice', {
          name: 'Alice Chen',
          email: 'alice@example.com',
          auth: { kind: 'access_code', hint: 'The sender sent you a 4 digit code' },
        })
        .settings({ allowDecline: true, requireConsent: true })
        .field({
          recipient: 'alice',
          type: 'signature',
          anchor: { text: 'Authorized signature', occurrence: 0, from: 'top', offsetY: -4 },
          width: 200,
          height: 44,
          required: true,
          label: 'Your signature',
        })
        .field({
          recipient: 'alice',
          type: 'date_signed',
          anchor: { text: 'Date', occurrence: 0, from: 'top', offsetY: -4 },
          width: 120,
          height: 16,
        })
        .field({
          recipient: 'alice',
          type: 'full_name',
          anchor: { text: 'Printed name and title', occurrence: 0, from: 'top', offsetY: -20 },
          width: 200,
          height: 16,
        })
        .field({
          alias: 'title',
          recipient: 'alice',
          type: 'text',
          anchor: { text: 'Printed name and title', occurrence: 0, from: 'top', offsetY: -4 },
          width: 200,
          height: 16,
          label: 'Job title',
          required: true,
          validation: { maxLength: 60 },
        })
        .build({ validate: false })

      const { resolved, unmatched } = await applyAnchors(loaded, draft.fields)
      await loaded.destroy()

      if (unmatched.length > 0) {
        // Worth surfacing rather than silently dropping: an unresolved anchor
        // means a field the signer will never see.
        console.warn(
          'Anchors did not resolve:',
          unmatched.map((field) => field.anchor?.text),
        )
      }

      if (cancelled) return

      const ready: Envelope = {
        ...draft,
        fields: resolved,
        status: 'sent',
        sentAt: Date.now(),
      }

      await trail.append({ action: 'envelope_created' })
      await trail.append({ action: 'envelope_sent' })

      setEnvelope(ready)
      setSignerId(ready.recipients[0]?.id)
    }

    prepare().catch((cause: unknown) => {
      if (cancelled) return
      setError(cause instanceof Error ? cause.message : String(cause))
    })

    return () => {
      cancelled = true
    }
  }, [trail])

  const identity = useMemo(
    () => (signerId ? new MemoryIdentityAdapter(new Map([[signerId, ACCESS_CODE]])) : undefined),
    [signerId],
  )

  if (error) {
    return <Centered>Could not prepare the example: {error}</Centered>
  }
  if (!envelope || !signerId || !identity) {
    return <Centered>Generating a sample agreement</Centered>
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Banner />
      <div style={{ flex: 1, minHeight: 0 }}>
        <InkSignProvider
          envelope={envelope}
          recipientId={signerId}
          theme={theme}
          trail={trail}
          adapters={{ ...adapters, identity }}
          onSessionError={(sessionError) => setError(sessionError.message)}
        >
          <SigningCeremony
            onCompleted={() => setDone('completed')}
            onDeclined={() => setDone('declined')}
            onError={(ceremonyError) => console.error(ceremonyError.code, ceremonyError.message)}
          >
            <Document />
          </SigningCeremony>
        </InkSignProvider>
      </div>
      {done ? <TrailSummary trail={trail} outcome={done} /> : null}
    </div>
  )
}

function Document(): ReactNode {
  const { store, session } = useInkSign()
  const documentId = store.documentIds()[0]
  const source = documentId ? store.getDocument(documentId)?.source : undefined
  const { renderer, document, loading, error } = useDocument(source)

  if (error) return <Centered>Could not open the document: {error.message}</Centered>
  if (loading || !documentId) return <Centered>Loading document</Centered>

  return (
    <DocumentViewer
      documentId={documentId}
      renderer={renderer}
      pageSizes={document?.pageSizes ?? []}
      scale="fit-width"
      renderField={(fieldId, box) => (
        <FieldInput
          key={fieldId}
          fieldId={fieldId}
          box={box}
          adoptedSignature={session?.signature}
        />
      )}
    />
  )
}

function Banner(): ReactNode {
  return (
    <div
      style={{
        padding: '10px 16px',
        fontSize: 13,
        color: '#44485a',
        background: '#fff8e1',
        borderBottom: '1px solid #f0e2b0',
      }}
    >
      <strong>Demo.</strong> The access code is <code>{ACCESS_CODE}</code>. Everything runs in this
      tab: the agreement is generated with pdf-lib, fields are placed by anchor text, and nothing is
      sent anywhere.
    </div>
  )
}

function TrailSummary({
  trail,
  outcome,
}: {
  trail: AuditTrail
  outcome: 'completed' | 'declined'
}): ReactNode {
  const [verified, setVerified] = useState<boolean>()

  useEffect(() => {
    trail.verify().then((result) => setVerified(result.valid))
  }, [trail])

  return (
    <div
      style={{
        maxHeight: '38vh',
        overflow: 'auto',
        padding: 16,
        fontSize: 12,
        background: '#15171f',
        color: '#eef0f6',
      }}
    >
      <p style={{ margin: '0 0 10px' }}>
        <strong>{outcome === 'completed' ? 'Signed' : 'Declined'}.</strong> Audit chain{' '}
        {verified === undefined ? 'verifying' : verified ? 'verified' : 'FAILED verification'}
        {verified ? `, head ${trail.head.slice(0, 16)}...` : ''}
      </p>
      <table
        style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'ui-monospace, monospace' }}
      >
        <tbody>
          {trail.list().map((entry) => (
            <tr key={entry.id}>
              <td style={{ padding: '3px 12px 3px 0', color: '#a0a5b8', whiteSpace: 'nowrap' }}>
                {new Date(entry.at).toLocaleTimeString()}
              </td>
              <td style={{ padding: '3px 12px 3px 0' }}>{entry.action}</td>
              <td style={{ padding: '3px 0', color: '#7f8396' }}>{entry.hash.slice(0, 12)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Centered({ children }: { children: ReactNode }): ReactNode {
  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        textAlign: 'center',
        color: '#5c6070',
      }}
    >
      {children}
    </div>
  )
}
