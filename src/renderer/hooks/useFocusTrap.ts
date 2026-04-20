import { useEffect, useRef } from 'react'

/**
 * Traps Tab / Shift+Tab focus inside `containerRef` while `active` is true,
 * auto-focuses the first focusable element on mount, and restores focus to
 * the previously-focused element when the trap releases. Optional
 * `onEscape` fires on Escape keypress — callers typically use it to close
 * their dialog.
 *
 * Only focusable elements inside the container are considered
 * (button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])).
 * If the container has no focusable children the hook is a no-op.
 *
 * Use on any modal-style surface (role="dialog" aria-modal="true") so
 * keyboard users can't tab out of the overlay while it's visible.
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
): void {
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return
    previouslyFocused.current = document.activeElement as HTMLElement | null
    const container = containerRef.current
    if (!container) return

    const firstFocusable = container.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    firstFocusable?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (onEscape) {
          e.preventDefault()
          onEscape()
        }
        return
      }
      if (e.key !== 'Tab') return
      const focusables = container.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // Restore focus only when the trap element is actually going away.
      // Guard against focusing a node that was removed from the DOM by
      // the owning modal's own teardown.
      const prev = previouslyFocused.current
      if (prev && document.contains(prev)) {
        try {
          prev.focus()
        } catch {
          /* element may no longer be focusable — silent no-op */
        }
      }
    }
  }, [active, containerRef, onEscape])
}
