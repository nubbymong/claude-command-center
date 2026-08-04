/**
 * sign-in.ts — drive one account's claude.ai sign-in in the user's own browser (#216).
 *
 * The flow: launch the system browser with a dedicated profile and a loopback
 * debug port, let the human complete SSO (compliance plugin and MFA included),
 * poll over CDP until claude.ai reports an authenticated account, harvest ONLY
 * the claude.ai cookies, inject them into that account's Electron partition, and
 * destroy the browser profile.
 *
 * The pure decisions live next door in `browser-launch.ts` and
 * `cookie-harvest.ts`; this file is the side-effecting shell around them.
 *
 * SECURITY NOTES, since this is the file an attacker reads first:
 *   - The debug port is loopback-only and open only while a sign-in is running.
 *     Anything that reaches it can read the claude.ai cookies, so the browser is
 *     killed and the profile removed as soon as the harvest succeeds or fails.
 *   - Cookies are injected into `persist:claude-web-<profileId>` and nowhere
 *     else; one partition per account is the isolation boundary.
 *   - CCC never reads the user's normal browser profile.
 *
 * No default export (project convention).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { session as electronSession } from 'electron'
import { logError, logInfo } from '../debug-logger'
import { getBrowserPaths } from '../vision-manager'
import {
  webPartitionForProfile,
  type AccountWebSession,
} from '../../shared/account-web-session'
import { authProfileDir, buildAuthBrowserArgs, type AuthBrowser } from './browser-launch'
import { harvestClaudeCookies, type CdpCookie } from './cookie-harvest'

/** Lazy require so a missing optional dep never crashes boot (mirrors vision-manager). */
let CDP: any = null
let cdpOverride: any = null
function getCDP(): any {
  if (cdpOverride) return cdpOverride
  if (!CDP) CDP = require('chrome-remote-interface')
  return CDP
}
/** Test seam: inject a fake chrome-remote-interface. Pass null to restore. */
export function _setCdpForTest(fake: any): void { cdpOverride = fake }

export type SignInPhase = 'idle' | 'launching' | 'awaiting-user' | 'harvesting' | 'done' | 'failed'

export interface SignInState {
  phase: SignInPhase
  profileId: string | null
  /** Populated on 'failed'. Shown to the user verbatim. */
  error?: string
  session?: AccountWebSession
}

let current: SignInState = { phase: 'idle', profileId: null }
let child: ChildProcess | null = null
let cancelled = false

export function getSignInState(): SignInState {
  return current
}

/** Resolve the first system browser binary that exists. */
export function resolveBrowserBinary(preferred: AuthBrowser = 'chrome'): { browser: AuthBrowser; path: string } | null {
  for (const b of [preferred, preferred === 'chrome' ? 'edge' : 'chrome'] as AuthBrowser[]) {
    for (const p of getBrowserPaths(b)) {
      if (existsSync(p)) return { browser: b, path: p }
    }
  }
  return null
}

function cleanup(profileDir: string | null): void {
  if (child && !child.killed) {
    try { child.kill() } catch { /* already gone */ }
  }
  child = null
  // The profile dir holds a live claude.ai session until it is removed.
  if (profileDir && existsSync(profileDir)) {
    try { rmSync(profileDir, { recursive: true, force: true }) } catch (err) {
      logError(`[account-web] could not remove the sign-in profile dir: ${(err as Error)?.message}`)
    }
  }
}

/** Ask the page for the signed-in account, via claude.ai's own bootstrap. */
async function readAccountEmail(client: any): Promise<string | null> {
  try {
    const { result } = await client.Runtime.evaluate({
      expression: `fetch('/api/bootstrap',{credentials:'include'}).then(r=>r.json()).then(j=>j?.account?.email_address ?? null).catch(()=>null)`,
      awaitPromise: true,
      returnByValue: true,
    })
    return typeof result?.value === 'string' ? result.value : null
  } catch {
    return null
  }
}

export interface RunSignInOpts {
  profileId: string
  dataDir: string
  port: number
  /** How long to wait for the human, ms. SSO with MFA is not fast. */
  timeoutMs?: number
  pollMs?: number
}

/**
 * Run the whole sign-in. Resolves with the final state; never throws.
 *
 * Success requires BOTH an authenticated bootstrap and a real session cookie —
 * a jar without `sessionKey` would leave the partition looking signed in while
 * every request 401s.
 */
export async function runSignIn(opts: RunSignInOpts): Promise<SignInState> {
  const { profileId, dataDir, port } = opts
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000
  const pollMs = opts.pollMs ?? 1500

  cancelled = false

  // Resolve INSIDE the guarded path. Both of these validate the profile id and
  // throw on a bad one, and this function's contract is that it never throws —
  // a caller that got a state object for every other failure must not get an
  // exception for this one.
  let partition: string
  let profileDir: string
  try {
    partition = webPartitionForProfile(profileId)
    profileDir = authProfileDir(dataDir, profileId)
  } catch (err) {
    current = { phase: 'failed', profileId, error: (err as Error)?.message ?? String(err) }
    return current
  }

  current = { phase: 'launching', profileId }

  const bin = resolveBrowserBinary()
  if (!bin) {
    current = { phase: 'failed', profileId, error: 'No Chrome or Edge found. A system browser is required: the sign-in needs the extensions your policy installs, which an in-app window does not have.' }
    return current
  }

  try {
    const args = buildAuthBrowserArgs({ port, profileDir })
    logInfo(`[account-web] launching ${bin.browser} for ${profileId} on loopback port ${port}`)
    child = spawn(bin.path, args, { detached: false, stdio: 'ignore' })
    child.on('error', (err) => logError(`[account-web] browser spawn error: ${err.message}`))

    current = { phase: 'awaiting-user', profileId }

    const deadline = Date.now() + timeoutMs
    let client: any = null

    while (Date.now() < deadline && !cancelled) {
      await new Promise((r) => setTimeout(r, pollMs))
      if (!client) {
        try { client = await getCDP()({ port }) } catch { continue }
      }
      const email = await readAccountEmail(client)
      if (!email) continue

      // Authenticated. Harvest.
      current = { phase: 'harvesting', profileId }
      const all: CdpCookie[] = (await client.Network.getAllCookies())?.cookies ?? []
      const harvest = harvestClaudeCookies(all)

      if (!harvest.hasSessionCookie) {
        // Keep waiting rather than declaring success on a cookie-less jar.
        current = { phase: 'awaiting-user', profileId }
        continue
      }

      const store = electronSession.fromPartition(partition)
      for (const c of harvest.cookies) {
        try { await store.cookies.set(c) } catch (err) {
          logError(`[account-web] could not set cookie ${c.name}: ${(err as Error)?.message}`)
        }
      }

      try { await client.close() } catch { /* closing anyway */ }
      cleanup(profileDir)

      const acquired: AccountWebSession = {
        profileId,
        accountEmail: email,
        acquiredAt: Date.now(),
        expiresAt: harvest.expiresAt,
        origin: 'system-browser',
      }
      logInfo(`[account-web] ${profileId}: signed in as ${email}, ${harvest.cookies.length} cookie(s), ${harvest.dropped} dropped`)
      current = { phase: 'done', profileId, session: acquired }
      return current
    }

    try { await client?.close() } catch { /* ignore */ }
    cleanup(profileDir)
    current = {
      phase: 'failed',
      profileId,
      error: cancelled ? 'Sign-in cancelled.' : 'Timed out waiting for the sign-in to complete.',
    }
    return current
  } catch (err) {
    cleanup(profileDir)
    current = { phase: 'failed', profileId, error: (err as Error)?.message ?? String(err) }
    return current
  }
}

/** Cancel an in-flight sign-in and tear the browser down. */
export function cancelSignIn(): void {
  cancelled = true
}

/** Forget one account's web session — used on account delete and on sign-out. */
export async function clearWebSession(profileId: string): Promise<void> {
  const store = electronSession.fromPartition(webPartitionForProfile(profileId))
  await store.clearStorageData({ storages: ['cookies'] })
  logInfo(`[account-web] cleared the web session for ${profileId}`)
}
