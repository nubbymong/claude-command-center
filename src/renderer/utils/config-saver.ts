/**
 * Debounced config saver for the renderer process.
 * Use saveConfigDebounced for frequent operations (DnD reorder, collapse toggles).
 * Use saveConfigNow for explicit user actions (add/remove/rename).
 *
 * Saves are NOT fire-and-forget: writeConfig in the main process returns false
 * (or the IPC rejects) on disk failure. Every dispatch retries once, and a
 * still-failing key is recorded in configHealthStore so the UI can warn that
 * on-screen state is not on disk. flushPendingConfigSaves() drains pending
 * debounced saves on the app close paths so the last 300 ms of edits survive.
 */

import { useConfigHealthStore } from '../stores/configHealthStore'
import { configWritesLocked } from '../stores/configWriteLockStore'

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingData = new Map<string, unknown>()
const lastFailedData = new Map<string, unknown>()
/** Keys already reported as refused, so a debounced storm logs once each. */
const refusedOnce = new Set<string>()

async function tryOnce(key: string, data: unknown): Promise<boolean> {
  try {
    return await window.electronAPI.config.save(key, data)
  } catch {
    return false
  }
}

async function dispatchSave(key: string, data: unknown): Promise<boolean> {
  // The config could not be READ this boot, so every store holds empty
  // defaults. Writing now would put that emptiness on top of a file that is
  // probably intact -- the read failed, the data did not. Refuse until the user
  // chooses "start fresh anyway". Deliberately NOT marked failed in
  // configHealthStore: that surface offers a Retry, and retrying is exactly
  // what must not happen here.
  const locked = configWritesLocked()
  if (locked) {
    if (!refusedOnce.has(key)) {
      refusedOnce.add(key)
      console.warn(`[config-saver] Refusing to save '${key}': ${locked}. Your config on disk is untouched.`)
    }
    return false
  }
  const ok = (await tryOnce(key, data)) || (await tryOnce(key, data))
  const health = useConfigHealthStore.getState()
  if (ok) {
    lastFailedData.delete(key)
    health.markSaved(key)
  } else {
    lastFailedData.set(key, data)
    health.markFailed(key)
    console.error(`[config-saver] Failed to save '${key}' after retry; change is NOT persisted`)
  }
  return ok
}

function cancelPending(key: string): void {
  const existing = timers.get(key)
  if (existing) clearTimeout(existing)
  timers.delete(key)
  pendingData.delete(key)
}

/**
 * Save config with debouncing. Multiple rapid calls with the same key
 * will only trigger one actual save after the delay.
 */
export function saveConfigDebounced(key: string, data: unknown, delay = 300): void {
  cancelPending(key)
  pendingData.set(key, data)
  timers.set(key, setTimeout(() => {
    timers.delete(key)
    pendingData.delete(key)
    void dispatchSave(key, data)
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
  cancelPending(key)
  return dispatchSave(key, data)
}

/**
 * Immediately dispatch every pending debounced save and await the results.
 * Called from the App close paths before allowClose()/installAndRestart so
 * edits made inside the debounce window are not silently dropped.
 */
export async function flushPendingConfigSaves(): Promise<void> {
  const entries = [...pendingData.entries()]
  for (const [key] of entries) cancelPending(key)
  await Promise.all(entries.map(([key, data]) => dispatchSave(key, data)))
}

/**
 * Re-dispatch the most recent payload of every failed key (BottomBar retry).
 */
export async function retryFailedConfigSaves(): Promise<void> {
  const entries = [...lastFailedData.entries()]
  await Promise.all(entries.map(([key, data]) => dispatchSave(key, data)))
}
