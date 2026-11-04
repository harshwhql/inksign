import type { AuditEntry, AuditContext } from '../audit/trail.js'
import type {
  AttachmentRef,
  AuthMethod,
  Envelope,
  EnvelopeId,
  Recipient,
  RecipientId,
} from '../types.js'

/**
 * Ports to the outside world.
 *
 * The engine is deliberately ignorant of where documents live, how recipients
 * are authenticated, and how mail is sent. Those are decisions that belong to
 * the integrating application, and they are also the parts that cannot be done
 * honestly in a browser: a client cannot verify its own identity, and a
 * client-side timestamp is not evidence of anything.
 *
 * Every adapter is optional. The engine reports a clear `ADAPTER_MISSING`
 * error when a flow needs one that was not supplied, rather than silently
 * degrading.
 */

/** Blob storage for documents, signature images and attachments. */
export interface StorageAdapter {
  /** Reads an object. Rejects when the key is absent. */
  get(key: string): Promise<Uint8Array>
  /** Writes an object and returns the key it can be read back with. */
  put(key: string, data: Uint8Array, contentType: string): Promise<{ key: string }>
  /** Removes an object. Resolves even when the key was already absent. */
  delete(key: string): Promise<void>
  /**
   * A time-limited URL the browser can fetch directly, which keeps large PDFs
   * out of the application server's request path.
   */
  signedUrl?(key: string, expiresInMs: number): Promise<string>
}

/**
 * Verifies that a recipient is who the envelope says they are.
 *
 * Nothing here runs in the browser in a trustworthy way. An access code
 * checked client-side is a formality, so implementations should call a server
 * that holds the expected value.
 */
export interface IdentityAdapter {
  /** Which methods this implementation can actually service. */
  supports(method: AuthMethod['kind']): boolean
  /**
   * Starts a challenge, for methods that need one (sending an SMS code, for
   * example). Returns a token the client passes back to `verify`.
   */
  challenge?(input: {
    envelopeId: EnvelopeId
    recipientId: RecipientId
    method: AuthMethod
  }): Promise<{ challengeId: string; expiresAt: number }>
  /** Checks a response. Resolving with `false` must not reveal why it failed. */
  verify(input: {
    envelopeId: EnvelopeId
    recipientId: RecipientId
    method: AuthMethod
    challengeId?: string
    response: string
  }): Promise<AuthResult>
}

export interface AuthResult {
  ok: boolean
  /** Attempts left before the recipient is locked out. */
  attemptsRemaining?: number
  /** Opaque evidence of the check, recorded in the audit trail. */
  evidence?: Readonly<Record<string, unknown>>
}

/** Delivers invitations, reminders and completion notices. */
export interface NotificationAdapter {
  send(message: OutboundMessage): Promise<{ messageId: string }>
}

export interface OutboundMessage {
  kind: 'invitation' | 'reminder' | 'completed' | 'declined' | 'voided' | 'delegated'
  channel: 'email' | 'sms'
  to: { name: string; email?: string; phone?: string }
  envelopeId: EnvelopeId
  recipientId: RecipientId
  subject: string
  body: string
  /** Link to the signing ceremony, produced by the host application. */
  signingUrl?: string
  locale?: string
}

/**
 * Persists envelopes and trails. Implement this to put the engine in front of
 * a database rather than keeping state in memory.
 */
export interface PersistenceAdapter {
  loadEnvelope(id: EnvelopeId): Promise<Envelope | undefined>
  saveEnvelope(envelope: Envelope): Promise<void>
  loadTrail(id: EnvelopeId): Promise<readonly AuditEntry[]>
  appendTrail(id: EnvelopeId, entries: readonly AuditEntry[]): Promise<void>
  listEnvelopes?(query: {
    status?: Envelope['status']
    recipientEmail?: string
    limit?: number
    cursor?: string
  }): Promise<{ envelopes: readonly Envelope[]; cursor?: string }>
}

/**
 * Supplies the current time.
 *
 * A trusted timestamp has to come from somewhere the signer does not control,
 * since a local clock can be set to anything. Implement `trustedNow` against
 * an RFC 3161 timestamp authority when the signatures need to stand up to a
 * challenge about when they were made.
 */
export interface ClockAdapter {
  now(): number
  trustedNow?(): Promise<{ at: number; token?: string; authority?: string }>
}

/** Collects the request context that the engine cannot observe itself. */
export interface ContextAdapter {
  capture(): Promise<AuditContext> | AuditContext
}

/** Emits lifecycle changes so a host can run webhooks or background work. */
export interface WebhookAdapter {
  dispatch(event: {
    type: string
    envelopeId: EnvelopeId
    at: number
    payload: Readonly<Record<string, unknown>>
  }): Promise<void>
}

/** Uploads an attachment captured during the ceremony. */
export interface AttachmentAdapter {
  upload(input: {
    envelopeId: EnvelopeId
    recipientId: RecipientId
    file: { name: string; contentType: string; bytes: Uint8Array }
  }): Promise<AttachmentRef>
}

export interface Adapters {
  storage?: StorageAdapter
  identity?: IdentityAdapter
  notify?: NotificationAdapter
  persistence?: PersistenceAdapter
  clock?: ClockAdapter
  context?: ContextAdapter
  webhook?: WebhookAdapter
  attachments?: AttachmentAdapter
}

/** The default clock, reading the local system time. */
export const systemClock: ClockAdapter = { now: () => Date.now() }

/**
 * Stores objects in memory. Useful for tests, previews and single-page demos.
 * Not for production: nothing survives a reload.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private readonly objects = new Map<string, { data: Uint8Array; contentType: string }>()

  async get(key: string): Promise<Uint8Array> {
    const found = this.objects.get(key)
    if (!found) throw new Error(`No object stored under key ${key}`)
    return found.data
  }

  async put(key: string, data: Uint8Array, contentType: string): Promise<{ key: string }> {
    this.objects.set(key, { data, contentType })
    return { key }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  get size(): number {
    return this.objects.size
  }
}

/**
 * Captures what a browser can see about itself. The user agent is readable;
 * the IP address is not, so it is left for the server to attach.
 */
export const browserContext: ContextAdapter = {
  capture(): AuditContext {
    const nav = (globalThis as { navigator?: Navigator }).navigator
    const context: AuditContext = {}
    if (nav?.userAgent) context.userAgent = nav.userAgent
    try {
      context.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      // Intl is available everywhere the library is supported, but a locked
      // down runtime can still throw. The field is optional, so skip it.
    }
    return context
  },
}

/** Records recipients that would have been notified, without sending anything. */
export class MemoryNotificationAdapter implements NotificationAdapter {
  readonly sent: OutboundMessage[] = []

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    this.sent.push(message)
    return { messageId: `mem_${this.sent.length}` }
  }
}

/**
 * Checks an access code held in memory. Suitable for local development only:
 * the expected codes are present on the client, so anyone can read them.
 */
export class MemoryIdentityAdapter implements IdentityAdapter {
  private readonly attempts = new Map<string, number>()

  constructor(
    private readonly codes: ReadonlyMap<RecipientId, string>,
    private readonly maxAttempts = 3,
  ) {}

  supports(method: AuthMethod['kind']): boolean {
    return method === 'none' || method === 'access_code'
  }

  async verify(input: {
    recipientId: RecipientId
    method: AuthMethod
    response: string
  }): Promise<AuthResult> {
    if (input.method.kind === 'none') return { ok: true }

    const used = this.attempts.get(input.recipientId) ?? 0
    if (used >= this.maxAttempts) return { ok: false, attemptsRemaining: 0 }

    const expected = this.codes.get(input.recipientId)
    const ok = expected !== undefined && expected === input.response
    if (ok) {
      this.attempts.delete(input.recipientId)
      return { ok: true, evidence: { method: 'access_code' } }
    }
    this.attempts.set(input.recipientId, used + 1)
    return { ok: false, attemptsRemaining: this.maxAttempts - used - 1 }
  }
}

/** Fills in the recipient-derived values for auto-filled field types. */
export function recipientFacts(recipient: Recipient): Readonly<Record<string, string>> {
  return Object.freeze({
    full_name: recipient.name,
    email: recipient.email ?? '',
    company: String(recipient.metadata?.company ?? ''),
    title: String(recipient.metadata?.title ?? ''),
  })
}
