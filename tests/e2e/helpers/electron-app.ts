/**
 * Shared Electron launch helper for E2E tests.
 *
 * Launches the packaged app against a FRESH, ISOLATED temp data dir so e2e:
 *   - never touches the user's real config / registry,
 *   - starts from a deterministic clean state (no profiles, no sessions),
 *   - skips first-run boot gates (consent / what's-new / machine-name) via a
 *     pre-seeded CONFIG, so the main UI is reached without modal interaction,
 *   - gets its OWN Electron --user-data-dir, so its single-instance lock does
 *     not collide with a running CCC instance (tests can run alongside a live
 *     app locally instead of needing a separate machine).
 *
 * Isolation hook: src/main/data-paths.ts honours CCC_E2E_DATA_DIR.
 */
import { _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { execFileSync } from 'child_process'
import { emptyGitHubConfig } from '../../../src/shared/github-constants'
import { currentTrainingVersion } from '../../../src/renderer/training-steps'
import { STEPS, ONBOARDING_VERSION } from '../../../src/renderer/onboarding/steps'

const APP_PATH = path.resolve(__dirname, '../../../out/main/index.js')

// A leaked dir survives at most one run instead of forever: best-effort sweep
// of stale ccc-e2e-* dirs (this helper's own prefix, and desktop-import's
// ccc-e2e-import-* / the probe spec's ccc-e2e-probe-*) left behind by a run
// whose teardown couldn't fully clean up (a PTY-owned handle on Windows -- see
// closeIsolatedApp below). Runs once per process, at first launch.
const STALE_DIR_MAX_AGE_MS = 60 * 60 * 1000 // 1h
let staleSweepDone = false
function sweepStaleTempDirs(): void {
  if (staleSweepDone) return
  staleSweepDone = true
  let entries: string[]
  try {
    entries = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  const now = Date.now()
  for (const name of entries) {
    if (!name.startsWith('ccc-e2e-')) continue
    const full = path.join(os.tmpdir(), name)
    try {
      const stat = fs.statSync(full)
      if (now - stat.mtimeMs < STALE_DIR_MAX_AGE_MS) continue
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    } catch {
      /* best effort -- a dir still in active use by another worker is fine to skip */
    }
  }
}

/** Tree-kill the whole Electron process group. On Windows, `.process().kill()`
 *  terminates only the root process -- a node-pty child (shell + conhost)
 *  reparents and survives, keeping open handles inside dataDir (including the
 *  debug log the app writes there), which is exactly what made the dataDir
 *  rmSync below fail silently and leak multi-GB temp dirs (#487 audit). */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    /* already gone, or never had children -- either way, nothing left to kill */
  }
}

export interface IsolatedApp {
  app: ElectronApplication
  page: Page
  dataDir: string
}

// Pre-seed a clean, setup-complete CONFIG so the first-run boot gates
// (pickBootGate priority chain in src/renderer/utils/bootGates.ts) don't block.
function seedCleanConfig(dataDir: string): void {
  const resources = path.join(dataDir, 'resources')
  // Resources subdirs the app expects (mirrors setResourcesDirectory()).
  for (const sub of ['CONFIG', 'insights', 'screenshots', 'skills', 'scripts', 'status']) {
    fs.mkdirSync(path.join(resources, sub), { recursive: true })
  }
  const config = path.join(resources, 'CONFIG')
  // loggingConsent: seen; machineName: set.
  fs.writeFileSync(
    path.join(config, 'settings.json'),
    JSON.stringify({ loggingConsentSeen: true, localMachineName: 'e2e-host' }, null, 2),
  )
  // setupVersion MUST exactly equal the build's __APP_VERSION__ (= package
  // version): App.tsx gates the Claude CLI-setup wizard on
  // `setupVersion !== __APP_VERSION__`, and a fresh dir would otherwise spawn a
  // real `claude` to set up.
  //
  // lastSeenVersion is now compared against __APP_VERSION__ TOO (2026-08-21 —
  // it used to be compared against changelog[0].version, which is exactly the
  // bug that shipped a wall-of-text modal on every unreleased build; see
  // onboarding/whats-new-gate.ts). So it must be seeded from the package
  // version, not the changelog: the changelog head is AHEAD of the running
  // version on any build between two releases, which would read as an upgrade,
  // open the harness in what's-new-only mode, and block every test behind a
  // full-screen page. lastTrainingVersion suppresses the first-run tour.
  const appVersion = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf-8'),
  ).version as string
  fs.writeFileSync(
    path.join(config, 'app-meta.json'),
    JSON.stringify(
      {
        setupVersion: appVersion,
        lastSeenVersion: appVersion,
        lastTrainingVersion: currentTrainingVersion(),
        hasCreatedFirstConfig: true,
        accountGateDecided: true,
        // The v2 onboarding harness (bootGates priority 1.5) outranks every gate
        // seeded above, so without these three keys it blocked EVERY e2e run and
        // the suite became vacuous. Mark the flow finished: all steps completed,
        // at the current ONBOARDING_VERSION, stamped with this app version so
        // shouldReonboardForVersion() doesn't re-fire it on the beta channel.
        // Derived from STEPS so a new step can't silently re-break the suite.
        completedSteps: Object.fromEntries(STEPS.map((s) => [s.id, '2026-01-01T00:00:00.000Z'])),
        onboardingCompletedVersion: ONBOARDING_VERSION,
        onboardingAppVersion: appVersion,
      },
      null,
      2,
    ),
  )
  // Suppress the GitHub first-run onboarding modal (the last boot gate):
  // seenOnboardingVersion='permanent', with authProfiles empty so the
  // "No auth profiles yet" empty-state still surfaces.
  fs.writeFileSync(
    path.join(config, 'github-config.json'),
    JSON.stringify({ ...emptyGitHubConfig(), seenOnboardingVersion: 'permanent' }, null, 2),
  )
}

export async function launchIsolatedApp(): Promise<IsolatedApp> {
  sweepStaleTempDirs()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-e2e-'))
  seedCleanConfig(dataDir)
  const app = await electron.launch({
    args: [APP_PATH, `--user-data-dir=${path.join(dataDir, 'electron-userdata')}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      E2E_HEADLESS: '1',
      CCC_E2E_DATA_DIR: dataDir,
      // Pin off: the splash is gated out for e2e (first window must be the
      // main window). A CCC_FORCE_SPLASH=1 left exported in the dev shell —
      // e.g. after running the splash probe — would otherwise flow through
      // the ...process.env spread and make the splash the first window,
      // timing out every spec with no obvious cause.
      CCC_FORCE_SPLASH: '0',
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Deterministic readiness: the sidebar's Saved TAB (which carries the
  // data-tour="new-config" tour anchor since the two-mode panel) renders once
  // the shell has hydrated and setup is complete (env hook → isSetupComplete).
  // NOT button[title="Settings"] — that title no longer exists on the nav item,
  // so the wait could only ever time out.
  await page.waitForSelector('[data-tour="new-config"]', { timeout: 20000 })
  // Belt-and-suspenders: dismiss any first-run boot-gate modal (what's-new /
  // training) the seed didn't fully suppress, so its backdrop can't intercept
  // clicks in tests.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(150)
  }
  return { app, page, dataDir }
}

export async function closeIsolatedApp(a: IsolatedApp | undefined): Promise<void> {
  if (!a) return
  // A graceful close can hang indefinitely when the test left a live PTY session
  // running (the shell keeps the app alive), which blows the afterAll hook
  // timeout and fails an otherwise-passing run. Race it, then kill.
  let pid: number | undefined
  try {
    pid = a.app.process().pid
  } catch {
    /* process already gone */
  }
  try {
    await Promise.race([
      a.app.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ])
  } catch {
    /* ignore */
  }
  // Tree-kill: a plain root-process kill leaves node-pty's shell (+ conhost on
  // Windows) alive, still holding handles inside dataDir (#487 audit).
  killProcessTree(pid)
  try {
    a.app.process().kill()
  } catch {
    /* already gone */
  }
  // Remove ONLY the unique mkdtemp dir we created — never a parent/shared path.
  // Retry across the brief window where a just-killed shell's handle (or
  // Windows' own conhost teardown) hasn't released the directory yet; on final
  // failure, warn with the leaked path and its size instead of swallowing it --
  // a silent catch here is exactly what let a leaked dir go unnoticed and
  // accumulate forever (#487 audit).
  try {
    fs.rmSync(a.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  } catch (err) {
    const size = dirSizeBestEffort(a.dataDir)
    console.warn(
      `[e2e] failed to remove isolated data dir ${a.dataDir}` +
        `${size != null ? ` (~${(size / (1024 * 1024)).toFixed(1)} MB leaked)` : ''}: ${(err as Error).message}`,
    )
  }
}

/** Best-effort recursive size of a directory, for the leak warning above. Never
 *  throws -- an inaccessible file just doesn't count toward the total. */
function dirSizeBestEffort(dir: string): number | null {
  let total = 0
  const stack = [dir]
  try {
    while (stack.length) {
      const cur = stack.pop() as string
      for (const name of fs.readdirSync(cur)) {
        const full = path.join(cur, name)
        try {
          const stat = fs.statSync(full)
          if (stat.isDirectory()) stack.push(full)
          else total += stat.size
        } catch {
          /* skip files that vanish mid-walk or refuse a stat */
        }
      }
    }
    return total
  } catch {
    return null
  }
}
