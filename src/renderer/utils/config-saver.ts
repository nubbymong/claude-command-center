/**
 * Debounced config saver for the renderer process.
 * Use saveConfigDebounced for frequent operations (DnD reorder, collapse toggles).
 * Use saveConfigNow for explicit user actions (add/remove/rename).
 */

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Save config with debouncing. Multiple rapid calls with the same key
 * will only trigger one actual save after the delay.
 */
export function saveConfigDebounced(key: string, data: unknown, delay = 300): void {
  const existing = timers.get(key)
  if (existing) clearTimeout(existing)

  timers.set(key, setTimeout(() => {
    timers.delete(key)
    window.electronAPI.config.save(key, data)
  }, delay))
}

/**
 * Save config immediately (no debouncing).
 * Use for explicit user actions like add/remove/rename.
 *
 * Returns a Promise that resolves when the IPC save has completed, so callers
 * that need to read-after-write can `await` it. Existing fire-and-forget call
 * sites can keep ignoring the return value.
 */
export function saveConfigNow(key: string, data: unknown): Promise<unknown> {
  // Cancel any pending debounced save for this key
  const existing = timers.get(key)
  if (existing) {
    clearTimeout(existing)
    timers.delete(key)
  }
  return window.electronAPI.config.save(key, data)
}
