import {
  type Adapters,
  type AuditTrail,
  type Envelope,
  EnvelopeStore,
  InkSignError,
  type RecipientId,
  SigningSession,
} from '@inksign/core'
import { createTheme, type Theme, themeToStyleString, themeToVariables } from '@inksign/ui'
import { getContext, hasContext, setContext } from 'svelte'

/**
 * Context.
 *
 * The store and session are created once and held as plain values, never in
 * reactive state. A signing session holds the recipient's progress, so
 * recreating it would lose their work, and making it reactive would wake every
 * consumer whenever anything inside it changed, which is exactly what the
 * keyed stores exist to avoid.
 */

const CONTEXT_KEY = Symbol.for('inksign')

export interface InkSignContext {
  store: EnvelopeStore
  session: SigningSession | undefined
  theme: Theme
  adapters: Adapters
  locale: string | undefined
}

export interface CreateContextOptions {
  /** The envelope to work with. Read once; later changes need a remount. */
  envelope: Envelope
  /**
   * Recipient signing in this session. Omit for a sender-side preview, which
   * renders the document and fields without opening a ceremony.
   */
  recipientId?: RecipientId | undefined
  theme?: Theme | undefined
  adapters?: Adapters | undefined
  trail?: AuditTrail | undefined
  /** Bypasses the routing check. For sender previews only. */
  ignoreRouting?: boolean | undefined
  locale?: string | undefined
  /** Called when the session cannot be opened, for example out of turn. */
  onSessionError?: ((error: InkSignError) => void) | undefined
}

/** Builds a context without touching Svelte's context, for tests and hosts. */
export function createInkSignContext(options: CreateContextOptions): InkSignContext {
  const store = new EnvelopeStore(options.envelope)
  const adapters = options.adapters ?? {}

  let session: SigningSession | undefined
  if (options.recipientId !== undefined) {
    try {
      session = new SigningSession(store, options.recipientId, {
        adapters,
        ...(options.trail !== undefined ? { trail: options.trail } : {}),
        ...(options.ignoreRouting !== undefined ? { ignoreRouting: options.ignoreRouting } : {}),
      })
    } catch (error) {
      // Opening out of turn is an expected condition, not a crash. The error
      // is reported and the tree renders without a session, so the host can
      // show its own message.
      if (error instanceof InkSignError) options.onSessionError?.(error)
      else throw error
    }
  }

  return {
    store,
    session,
    theme: options.theme ?? createTheme(),
    adapters,
    locale: options.locale,
  }
}

/**
 * Builds the context and puts it on Svelte's context.
 *
 * Call during component initialization. Returns the context so the calling
 * component can use it without reading back what it just set.
 */
export function setInkSignContext(options: CreateContextOptions): InkSignContext {
  const context = createInkSignContext(options)
  setContext(CONTEXT_KEY, context)
  return context
}

/** Puts an existing context on Svelte's context, for a host that built its own. */
export function provideInkSignContext(context: InkSignContext): InkSignContext {
  setContext(CONTEXT_KEY, context)
  return context
}

export function getInkSignContext(): InkSignContext {
  if (!hasContext(CONTEXT_KEY)) {
    throw new InkSignError(
      'UNSUPPORTED',
      'No InkSign context found. Call setInkSignContext in a parent component.',
    )
  }
  return getContext<InkSignContext>(CONTEXT_KEY)
}

/** The session, throwing when there is none, for ceremony-only components. */
export function getSigningSession(): SigningSession {
  const { session } = getInkSignContext()
  if (!session) {
    throw new InkSignError(
      'NOT_YOUR_TURN',
      'No signing session is open. Pass a recipientId when creating the context.',
    )
  }
  return session
}

/**
 * The theme as a `style` attribute string.
 *
 * Bind onto the element wrapping your signing UI with `style={themeStyle(...)}`.
 * Doing it this way rather than injecting a stylesheet means no global side
 * effects and no ordering problems with the host application's CSS.
 */
export function themeStyle(theme: Theme): string {
  return themeToStyleString(theme)
}

/** The theme's custom properties as a map, for hosts that prefer an object. */
export function themeVariables(theme: Theme): Readonly<Record<string, string>> {
  return themeToVariables(theme)
}
