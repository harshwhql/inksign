import {
  type Adapters,
  type AuditTrail,
  type Envelope,
  EnvelopeStore,
  InkSignError,
  type RecipientId,
  SigningSession,
} from '@inksign/core'
import { createTheme, type Theme, themeToVariables } from '@inksign/ui'
import {
  type App,
  computed,
  getCurrentScope,
  type InjectionKey,
  inject,
  onScopeDispose,
  provide,
  type ShallowRef,
  shallowRef,
} from 'vue'

/**
 * Context and provider.
 *
 * The store and session are created once and held in plain variables rather
 * than in reactive state. A signing session holds the recipient's progress, so
 * recreating it would lose their work, and making it reactive would mean every
 * consumer of the context re-renders whenever anything inside it changed,
 * which is exactly what the keyed subscriptions exist to avoid.
 */

export interface InkSignContext {
  store: EnvelopeStore
  session: SigningSession | undefined
  theme: Theme
  adapters: Adapters
  locale: string | undefined
}

export const inkSignKey: InjectionKey<InkSignContext> = Symbol('inksign')

export interface ProvideInkSignOptions {
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

/**
 * Builds the context and provides it to descendants.
 *
 * Call from `setup`. Returns the context so the calling component can use it
 * directly without injecting what it just provided.
 */
export function provideInkSign(options: ProvideInkSignOptions): InkSignContext {
  const context = createInkSignContext(options)
  provide(inkSignKey, context)
  return context
}

/** Builds a context without providing it, for an app-level plugin or a test. */
export function createInkSignContext(options: ProvideInkSignOptions): InkSignContext {
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

/** Installs a context for a whole app, as an alternative to a provider component. */
export function createInkSignPlugin(options: ProvideInkSignOptions) {
  const context = createInkSignContext(options)
  return {
    install(app: App) {
      app.provide(inkSignKey, context)
    },
    context,
  }
}

export function useInkSign(): InkSignContext {
  const context = inject(inkSignKey, undefined)
  if (!context) {
    throw new InkSignError(
      'UNSUPPORTED',
      'This composable must be used under provideInkSign or the InkSignProvider component',
    )
  }
  return context
}

/** The session, throwing when there is none, for ceremony-only components. */
export function useSigningSession(): SigningSession {
  const { session } = useInkSign()
  if (!session) {
    throw new InkSignError(
      'NOT_YOUR_TURN',
      'No signing session is open. Pass a recipientId when providing the context.',
    )
  }
  return session
}

/**
 * The theme as a style object of custom properties.
 *
 * Bind onto the element wrapping your signing UI. Doing it this way rather
 * than injecting a stylesheet means no global side effects and no ordering
 * problems with the host application's CSS.
 */
export function useThemeStyle() {
  const { theme } = useInkSign()
  return computed(() => themeToVariables(theme) as Record<string, string>)
}

/**
 * Bridges one of the store's keyed subscriptions into a Vue ref.
 *
 * `shallowRef` rather than `ref` is deliberate: entities from the store are
 * frozen and replaced wholesale on change, so a deep reactive proxy would cost
 * a traversal per read and buy nothing. Identity is already a valid change
 * check, which is what keeps a 400 field document cheap.
 *
 * Cleanup is tied to the active effect scope, so a component that unmounts
 * takes its subscription with it. Outside a scope the returned unsubscribe is
 * the caller's to run.
 */
export function useStoreBinding<T>(
  subscribe: (onChange: () => void) => () => void,
  read: () => T,
): ShallowRef<T> {
  const value = shallowRef(read()) as ShallowRef<T>

  const stop = subscribe(() => {
    value.value = read()
  })

  if (getCurrentScope()) onScopeDispose(stop)

  return value
}
