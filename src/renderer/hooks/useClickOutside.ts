import { useEffect, RefObject } from 'react'

/**
 * Hook that calls `onClose` when a click outside the ref element occurs,
 * or when Escape is pressed (unless `onEscape` is provided for custom handling).
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  onEscape?: () => void
) {
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (onEscape) onEscape()
        else onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [ref, onClose, onEscape])
}
