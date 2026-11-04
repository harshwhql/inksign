import type { Field, FieldValue, SessionProgress } from '@inksign/core'
import { formatValue, isEmpty } from '@inksign/core'

/**
 * Accessibility helpers.
 *
 * A signing ceremony is a legal act, so it has to be completable without
 * sight and without a mouse. Three things are needed beyond ordinary markup,
 * and none of them come free:
 *
 * - A live region, so a screen reader hears that a signature was applied to
 *   four fields rather than being left to discover it.
 * - A focus trap for the adopt-signature dialog, so Tab cannot wander into
 *   the document behind it.
 * - Field descriptions that say what a field is, who it belongs to, and
 *   whether it is required, since a bare box on a page conveys none of that.
 */

type Politeness = 'polite' | 'assertive'

const REGION_ID = 'inksign-live-region'

/**
 * Returns the shared live region, creating it on first use.
 *
 * One region is reused rather than one per component, because several live
 * regions compete and a screen reader may read them in an unpredictable
 * order or drop announcements entirely.
 */
function liveRegion(politeness: Politeness): HTMLElement | undefined {
  const doc = (globalThis as { document?: Document }).document
  if (!doc) return undefined

  const id = `${REGION_ID}-${politeness}`
  let region = doc.getElementById(id)
  if (region) return region

  region = doc.createElement('div')
  region.id = id
  region.setAttribute('role', 'status')
  region.setAttribute('aria-live', politeness)
  region.setAttribute('aria-atomic', 'true')

  // Visually hidden but still read. `display: none` and `visibility: hidden`
  // both remove the element from the accessibility tree, so neither works.
  Object.assign(region.style, {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    padding: '0',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: '0',
  })

  doc.body.appendChild(region)
  return region
}

let lastMessage = ''

/**
 * Announces a message to screen readers.
 *
 * Use `polite` for progress and `assertive` only for errors that block
 * progress: an assertive announcement interrupts whatever is being read,
 * which is hostile if used for routine updates.
 */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  const region = liveRegion(politeness)
  if (!region) return

  // An identical consecutive message is not re-announced by most screen
  // readers, so a zero-width space forces it to be treated as new text.
  const text = message === lastMessage ? `${message}​` : message
  lastMessage = message
  region.textContent = text
}

/** Removes the live regions, for teardown in tests and single-page apps. */
export function clearAnnouncer(): void {
  const doc = (globalThis as { document?: Document }).document
  if (!doc) return
  for (const politeness of ['polite', 'assertive'] as const) {
    doc.getElementById(`${REGION_ID}-${politeness}`)?.remove()
  }
  lastMessage = ''
}

/**
 * Builds the accessible name for a field.
 *
 * Without this a signer hears "edit text", which says nothing about what
 * is being agreed to.
 */
export function describeField(
  field: Field,
  value: FieldValue,
  options: { recipientName?: string; locale?: string; isOther?: boolean } = {},
): string {
  const kind = fieldTypeLabel(field.type)
  const name = field.label ?? kind

  const parts: string[] = [name]

  if (field.label && field.label !== kind) parts.push(kind)
  if (options.isOther && options.recipientName) {
    parts.push(`for ${options.recipientName}`)
  }
  if (field.validation?.required) parts.push('required')
  if (field.readOnly) parts.push('read only')

  if (isEmpty(value)) {
    parts.push('empty')
  } else {
    const formatted = formatValue(value, options.locale)
    parts.push(field.type === 'signature' || field.type === 'initials' ? 'signed' : formatted)
  }

  return parts.join(', ')
}

function fieldTypeLabel(type: Field['type']): string {
  const labels: Record<Field['type'], string> = {
    signature: 'signature',
    initials: 'initials',
    stamp: 'stamp',
    date_signed: 'date signed',
    text: 'text field',
    number: 'number field',
    checkbox: 'checkbox',
    radio_group: 'option group',
    dropdown: 'dropdown',
    full_name: 'full name',
    email: 'email address',
    company: 'company',
    title: 'job title',
    attachment: 'attachment',
    approve: 'approve button',
    decline: 'decline button',
    note: 'note',
    formula: 'calculated field',
    payment: 'payment amount',
  }
  return labels[type]
}

/** A progress sentence suitable for a live region. */
export function describeProgress(progress: SessionProgress): string {
  if (progress.requiredRemaining === 0) {
    return 'All required fields are complete. You can finish signing.'
  }
  return progress.requiredRemaining === 1
    ? '1 required field remaining'
    : `${progress.requiredRemaining} required fields remaining`
}

/**
 * Traps focus inside an element.
 *
 * Returns a function that releases the trap and restores focus to wherever it
 * was, which is the part usually forgotten: returning focus to the button that
 * opened a dialog is what keeps keyboard navigation coherent.
 */
export function trapFocus(container: HTMLElement): () => void {
  const doc = container.ownerDocument
  const previouslyFocused = doc.activeElement as HTMLElement | null

  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'canvas[tabindex]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ')

  const focusable = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
      (element) => element.offsetParent !== null || element === doc.activeElement,
    )

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return

    const elements = focusable()
    const first = elements[0]
    const last = elements[elements.length - 1]
    if (!first || !last) {
      event.preventDefault()
      return
    }

    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  container.addEventListener('keydown', onKeyDown)

  // Move focus in. Prefer an element marked for it, so a dialog can direct
  // focus at its signature pad rather than its close button.
  const initial = container.querySelector<HTMLElement>('[data-inksign-autofocus]') ?? focusable()[0]
  initial?.focus()

  return () => {
    container.removeEventListener('keydown', onKeyDown)
    previouslyFocused?.focus?.()
  }
}

/**
 * Whether the user asked for reduced motion.
 *
 * Respected for page transitions and the signature replay animation.
 */
export function prefersReducedMotion(): boolean {
  const matchMedia = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia
  if (!matchMedia) return false
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Keyboard shortcuts for moving between fields during a ceremony. */
export interface FieldNavigation {
  next(): void
  previous(): void
  first(): void
  last(): void
}

/**
 * Binds field navigation keys.
 *
 * Enter and the arrow keys move between fields, which is how a signer who
 * cannot use a pointer gets through a long document without tabbing past
 * every link in the page.
 */
export function bindFieldNavigation(target: HTMLElement, navigation: FieldNavigation): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    // Never hijack keys while someone is typing into a field.
    const active = target.ownerDocument.activeElement
    const isTyping =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active as HTMLElement | null)?.isContentEditable === true

    if (isTyping && event.key !== 'Escape') return

    switch (event.key) {
      case 'Enter':
      case 'ArrowDown':
        navigation.next()
        event.preventDefault()
        break
      case 'ArrowUp':
        navigation.previous()
        event.preventDefault()
        break
      case 'Home':
        navigation.first()
        event.preventDefault()
        break
      case 'End':
        navigation.last()
        event.preventDefault()
        break
      default:
        break
    }
  }

  target.addEventListener('keydown', onKeyDown)
  return () => target.removeEventListener('keydown', onKeyDown)
}
