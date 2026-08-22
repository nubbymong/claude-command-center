/**
 * Pointer gestures the bar's transient surfaces (menus, popovers) must treat
 * alike. A "context-menu gesture" is the right button everywhere and, on
 * macOS, Ctrl + the left button: Blink delivers that mousedown as button 0 +
 * ctrlKey and fires the context menu straight after it, so a backdrop that
 * dismissed on the mousedown would be gone before the contextmenu event and
 * the gesture would land on whatever sits under the pointer -- the terminal,
 * whose right-click pastes. The backdrops ignore this gesture on mousedown
 * and swallow the contextmenu instead (an inert dismiss).
 */
export interface PointerGestureLike { button: number; ctrlKey: boolean }

export function isContextMenuGesture(e: PointerGestureLike, platform: string | undefined = currentPlatform()): boolean {
  if (e.button === 2) return true
  return platform === 'darwin' && e.button === 0 && e.ctrlKey
}

function currentPlatform(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { electronPlatform?: string }).electronPlatform
}
