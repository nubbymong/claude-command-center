import { useEffect } from 'react'

/**
 * Hide cursor layer for Claude terminals, toggle for shell-only.
 */
export function useCursorLayerVisibility(
  containerRef: React.RefObject<HTMLDivElement | null>,
  isActive: boolean,
  shellOnly?: boolean
) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const cursorLayer = container.querySelector('.xterm-cursor-layer') as HTMLElement
    if (cursorLayer) {
      cursorLayer.style.display = shellOnly && isActive ? '' : 'none'
    }
  }, [isActive, shellOnly])
}
