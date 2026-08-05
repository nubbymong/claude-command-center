/**
 * artifacts.ts — open claude.ai artifacts AS a given account (#216).
 *
 * An artifact is a claude.ai web page owned by the account that produced it, so
 * viewing one requires being signed in as that account. That is the whole reason
 * this needs a per-account web session: a session running as a secondary account
 * could publish an artifact and then have no way to look at it.
 *
 * The window opens on that account's partition, so it is already signed in and
 * asks for nothing. It is a plain viewer — sandboxed, no preload, no bridge —
 * and navigation is pinned to claude.ai. Unlike the sign-in browser this is NOT
 * an auth flow: no SSO hop is expected, so the allowlist stays tight.
 *
 * No default export (project convention).
 */

import { BrowserWindow, shell } from 'electron'
import { logError, logInfo } from '../debug-logger'
import { webPartitionForProfile } from '../../shared/account-web-session'
import { safeExternalHttpsHref } from '../../shared/safe-url'

/**
 * Hand a URL to the OS, but only if it survives the repo's existing control.
 *
 * The artifacts page renders user-authored HTML, so a link in it is web content,
 * not something CCC chose. `shell.openExternal` is an OS-handler sink:
 * `file:`, `ms-msdt:`, `shell:` and friends reach real handlers, and a
 * `file://attacker-share/...` is an NTLM leak. `safeExternalHttpsHref` already
 * exists for exactly this and is used elsewhere in the app; an inline copy of
 * the pattern that omits the check is how a guarded sink becomes an unguarded
 * one.
 */
function openExternalSafely(url: string): void {
  const href = safeExternalHttpsHref(url)
  if (!href) {
    logError('[account-web] refused to hand a non-https URL from the artifacts window to the OS')
    return
  }
  void shell.openExternal(href)
}

/** Where the account's artifacts live. */
export const ARTIFACTS_URL = 'https://claude.ai/artifacts'

/** Hosts this viewer may navigate to. No IdP hops — it should already be signed in. */
const ALLOWED = new Set(['claude.ai', 'www.claude.ai'])

function isAllowed(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && ALLOWED.has(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

const windows = new Map<string, BrowserWindow>()

/**
 * Open (or focus) the artifacts window for one account.
 *
 * Keyed by profile so two accounts get two windows rather than one window that
 * silently shows whichever account signed in last.
 */
export function openArtifacts(profileId: string, parent?: BrowserWindow): { ok: boolean; error?: string } {
  let partition: string
  try {
    partition = webPartitionForProfile(profileId)
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'invalid account' }
  }

  const existing = windows.get(profileId)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return { ok: true }
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    parent,
    title: 'Artifacts — claude.ai',
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  })

  const leaveForBrowser = (e: { preventDefault: () => void }, url: string): void => {
    if (isAllowed(url)) return
    e.preventDefault()
    // A link out of claude.ai belongs in the user's real browser, not in a
    // window holding their claude.ai session.
    openExternalSafely(url)
  }
  win.webContents.on('will-navigate', leaveForBrowser)
  // will-redirect too: a 302 off claude.ai would otherwise carry the
  // session-bearing window off the allowlist without a will-navigate event.
  win.webContents.on('will-redirect', leaveForBrowser)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url)) return { action: 'allow' }
    openExternalSafely(url)
    return { action: 'deny' }
  })

  // Deny every permission request. Electron grants by default, and a window
  // holding a live claude.ai session has no business reaching a camera, a
  // microphone, or the clipboard on a page's say-so.
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  win.on('closed', () => windows.delete(profileId))

  windows.set(profileId, win)
  void win.loadURL(ARTIFACTS_URL).catch((err) => {
    logError(`[account-web] artifacts window failed to load: ${(err as Error)?.message ?? err}`)
  })
  logInfo(`[account-web] opened artifacts for ${profileId}`)
  return { ok: true }
}

/** Close any artifacts window for an account — used when its session is cleared. */
export function closeArtifacts(profileId: string): void {
  const w = windows.get(profileId)
  if (w && !w.isDestroyed()) w.close()
  windows.delete(profileId)
}
