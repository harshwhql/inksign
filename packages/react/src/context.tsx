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
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react'

/**
 * Context and provider.
 *
 * The store and session are created once and kept in refs, never in state. A
 * signing session holds the recipient's progress, so recreating it on a
 * re-render would lose their work. Keeping them out of state also means
 * subscribing components re-render from the store's keyed notifications rather
 * than from a context value change, which would re-render every consumer.
 */

export interface InkSignContextValue {
  store: EnvelopeStore
  session: SigningSession | undefined
  theme: Theme
  adapters: Adapters
  locale: string | undefined
}

const InkSignContext = createContext<InkSignContextValue | undefined>(undefined)

export interface InkSignProviderProps {
  /** The envelope to work with. Read once; later changes need a new key. */
  envelope: Envelope
  /**
   * Recipient signing in this session. Omit for a sender-side preview, which
   * renders the document and fields without opening a ceremony.
   */
  recipientId?: RecipientId | undefined
  /** Theme, or theme options. Defaults to the light theme. */
  theme?: Theme | undefined
  adapters?: Adapters | undefined
  /** Audit trail to append to. One is created when omitted. */
  trail?: AuditTrail | undefined
  /** Bypasses the routing check. For sender previews only. */
  ignoreRouting?: boolean | undefined
  locale?: string | undefined
  /** Called when the session cannot be opened, for example out of turn. */
  onSessionError?: ((error: InkSignError) => void) | undefined
  children: ReactNode
}

export function InkSignProvider({
  envelope,
  recipientId,
  theme,
  adapters,
  trail,
  ignoreRouting,
  locale,
  onSessionError,
  children,
}: InkSignProviderProps): ReactNode {
  // The envelope is read once. A signing ceremony is not a view over mutable
  // props: swapping the envelope underneath a half-filled form would silently
  // discard input, so changing document requires remounting with a new key.
  const storeRef = useRef<EnvelopeStore | undefined>(undefined)
  if (!storeRef.current) storeRef.current = new EnvelopeStore(envelope)
  const store = storeRef.current

  const adaptersValue = useMemo(() => adapters ?? {}, [adapters])
  const resolvedTheme = useMemo(() => theme ?? createTheme(), [theme])

  const sessionRef = useRef<SigningSession | undefined>(undefined)
  const errorRef = useRef(onSessionError)
  errorRef.current = onSessionError

  if (recipientId !== undefined && !sessionRef.current) {
    try {
      sessionRef.current = new SigningSession(store, recipientId, {
        adapters: adaptersValue,
        ...(trail !== undefined ? { trail } : {}),
        ...(ignoreRouting !== undefined ? { ignoreRouting } : {}),
      })
    } catch (error) {
      // Opening out of turn is an expected condition, not a crash. The error
      // is surfaced through the callback and the tree renders without a
      // session so the host can show its own message.
      if (error instanceof InkSignError) errorRef.current?.(error)
      else throw error
    }
  }

  const value = useMemo<InkSignContextValue>(
    () => ({
      store,
      session: sessionRef.current,
      theme: resolvedTheme,
      adapters: adaptersValue,
      locale,
    }),
    [store, resolvedTheme, adaptersValue, locale],
  )

  return <InkSignContext.Provider value={value}>{children}</InkSignContext.Provider>
}

export function useInkSign(): InkSignContextValue {
  const value = useContext(InkSignContext)
  if (!value) {
    throw new InkSignError('UNSUPPORTED', 'This hook must be used inside an <InkSignProvider>')
  }
  return value
}

/** The session, throwing when there is none, for ceremony-only components. */
export function useSigningSession(): SigningSession {
  const { session } = useInkSign()
  if (!session) {
    throw new InkSignError(
      'NOT_YOUR_TURN',
      'No signing session is open. Pass a recipientId to <InkSignProvider>.',
    )
  }
  return session
}

/**
 * The theme as a style object of custom properties.
 *
 * Spread onto the element that wraps your signing UI. Doing it this way rather
 * than injecting a stylesheet means no global side effects and no ordering
 * problems with the host application's CSS.
 */
export function useThemeStyle(): CSSProperties {
  const { theme } = useInkSign()
  return useMemo(() => themeToVariables(theme) as CSSProperties, [theme])
}

/** Applies the theme to an element, for a wrapper you do not control. */
export function useThemeOnElement(element: HTMLElement | null): void {
  const { theme } = useInkSign()

  useEffect(() => {
    if (!element) return
    const variables = themeToVariables(theme)
    for (const [name, value] of Object.entries(variables)) {
      element.style.setProperty(name, value)
    }
    element.dataset.inksignScheme = theme.scheme

    return () => {
      for (const name of Object.keys(variables)) element.style.removeProperty(name)
      delete element.dataset.inksignScheme
    }
  }, [element, theme])
}
