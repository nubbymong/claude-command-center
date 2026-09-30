// P3.10 round 4 (P1): when the Codex hook folders are prepared. The
// preparation itself is the Codex provider's (prepareHookFolders): the
// folders made this user's and owner-only by one asynchronous call of the
// owner-only rule, never on the main thread's path. It runs only while Codex
// is on:
//  - once after the app's first paint (a delay, as the companion-folder pass
//    at start waits), when Codex is on then;
//  - again whenever Codex is switched on (a settings save, or a change the
//    accounts service announces); a no-op in the provider while ready;
//  - before a local Codex launch, which waits for it at most
//    CODEX_HOOK_FOLDERS_LAUNCH_WAIT_MS and otherwise starts without hooks,
//    said in the log (the provider says so again at the launch).
// The composition root (index.ts) wires it; with nothing wired every call is
// a no-op that resolves false.

/** How long after start the first preparation waits (past first paint). */
export const CODEX_HOOK_FOLDERS_START_DELAY_MS = 5000
/** How long a local Codex launch waits for its hook folders. */
export const CODEX_HOOK_FOLDERS_LAUNCH_WAIT_MS = 5000

export interface CodexHookFolderDeps {
  /** Whether Codex is on now (a fresh read of the saved setting). */
  providerOn: () => boolean
  /** The provider's preparation: resolves whether the hook folder is ready. */
  prepare: () => Promise<boolean>
  /** A change announced by the accounts service (a switch made there). */
  subscribe?: (listener: () => void) => () => void
  log?: (level: 'info' | 'warn', message: string) => void
}

let deps: CodexHookFolderDeps | null = null
let started = false
let startTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribe: (() => void) | null = null
/** Round 5 (G5): launches that came before the wiring, waiting for it. */
let wiringWaiters: Array<() => void> = []

function log(d: CodexHookFolderDeps, level: 'info' | 'warn', message: string): void {
  try { d.log?.(level, message) } catch { /* a log never breaks the app */ }
}

/** One preparation, as a promise that never rejects. */
function run(d: CodexHookFolderDeps): Promise<boolean> {
  let p: Promise<boolean>
  try {
    p = Promise.resolve(d.prepare())
  } catch (err) {
    log(d, 'warn', `[codex] hooks: preparing the hook folders failed (${(err as Error)?.message ?? err})`)
    return Promise.resolve(false)
  }
  return p.then((ok) => ok === true, (err) => {
    log(d, 'warn', `[codex] hooks: preparing the hook folders failed (${(err as Error)?.message ?? err})`)
    return false
  })
}

/** Wire the preparation (the composition root, at start). */
export function startCodexHookFolders(d: CodexHookFolderDeps): void {
  const waiting = wiringWaiters
  stopCodexHookFolders()
  deps = d
  for (const w of waiting) {
    try { w() } catch { /* one launch never stops another */ }
  }
  const t = setTimeout(() => {
    startTimer = null
    if (deps !== d) return
    started = true
    try { unsubscribe = d.subscribe?.(() => codexHookFoldersSettingsChanged()) ?? null } catch { unsubscribe = null }
    codexHookFoldersSettingsChanged()
  }, CODEX_HOOK_FOLDERS_START_DELAY_MS)
  ;(t as { unref?: () => void }).unref?.()
  startTimer = t
}

/** Unwire it (and a test's reset). */
export function stopCodexHookFolders(): void {
  if (startTimer) clearTimeout(startTimer)
  startTimer = null
  try { unsubscribe?.() } catch { /* already gone */ }
  unsubscribe = null
  deps = null
  started = false
  wiringWaiters = []
}

/** The saved settings changed, or the accounts service announced a change:
 *  when Codex is on now (and the start delay is over), prepare. */
export function codexHookFoldersSettingsChanged(): void {
  const d = deps
  if (!d || !started) return
  let on = false
  try { on = d.providerOn() === true } catch { on = false }
  if (on) void run(d)
}

/** A local Codex launch: prepare (a no-op while ready) and wait for it, at
 *  most `waitMs`. Round 5 (G5): one that comes before the wiring (a tab
 *  restored at start) waits for the wiring too, within the same bound.
 *  Resolves whether the hook folder is ready; false past the bound (said:
 *  the launch starts without hooks). Never throws. */
export function awaitCodexHookFolders(waitMs: number = CODEX_HOOK_FOLDERS_LAUNCH_WAIT_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      if (deps) log(deps, 'warn', `[codex] hooks: the hook folders were not ready within ${Math.round(waitMs / 1000)} s, so this launch starts without hooks`)
      resolve(false)
    }, waitMs)
    ;(timer as { unref?: () => void }).unref?.()
    const go = (d: CodexHookFolderDeps): void => {
      void run(d).then((ok) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      })
    }
    if (deps) go(deps)
    else wiringWaiters.push(() => { if (!settled && deps) go(deps) })
  })
}
