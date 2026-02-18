/**
 * Keyboard shortcut utilities for customizable keybindings.
 */

/** Convert a KeyboardEvent to a normalized shortcut string like "Ctrl+Shift+T" */
export function eventToShortcutString(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  // Normalize key name
  let key = e.key
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  // Skip modifier-only keys
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return ''

  parts.push(key)
  return parts.join('+')
}

/** Check whether a KeyboardEvent matches a shortcut string */
export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false
  const parts = shortcut.split('+')
  const key = parts[parts.length - 1]
  const needsCtrl = parts.includes('Ctrl')
  const needsAlt = parts.includes('Alt')
  const needsShift = parts.includes('Shift')

  if (needsCtrl !== (e.ctrlKey || e.metaKey)) return false
  if (needsAlt !== e.altKey) return false
  if (needsShift !== e.shiftKey) return false

  // Normalize comparison
  let eventKey = e.key
  if (eventKey === ' ') eventKey = 'Space'
  else if (eventKey.length === 1) eventKey = eventKey.toUpperCase()

  return eventKey === key
}

/** Default keyboard shortcuts */
export const DEFAULT_SHORTCUTS: Record<string, string> = {
  newConfig: 'Ctrl+T',
  closeSession: 'Ctrl+W',
  nextSession: 'Ctrl+Tab',
  prevSession: 'Ctrl+Shift+Tab',
  toggleSidebar: 'Ctrl+B',
  pasteImage: 'Alt+V',
}

/** Human-readable labels for shortcut actions */
export const SHORTCUT_LABELS: Record<string, string> = {
  newConfig: 'New config',
  closeSession: 'Close session',
  nextSession: 'Next session',
  prevSession: 'Previous session',
  toggleSidebar: 'Toggle sidebar',
  pasteImage: 'Paste clipboard image',
}
