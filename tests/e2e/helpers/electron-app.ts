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
import { changelog } from '../../../src/renderer/changelog'
import { emptyGitHubConfig } from '../../../src/shared/github-constants'
import { currentTrainingVersion } from '../../../src/renderer/training-steps'
import { STEPS, ONBOARDING_VERSION } from '../../../src/renderer/onboarding/steps'

const APP_PATH = path.resolve(__dirname, '../../../out/main/index.js')

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
  // real `claude` to set up. lastSeenVersion is compared against
  // changelog[0].version (which can lag the package version), so seed it from
  // the changelog to suppress What's New. lastTrainingVersion suppresses the
  // first-run tour.
  const appVersion = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf-8'),
  ).version as string
  fs.writeFileSync(
    path.join(config, 'app-meta.json'),
    JSON.stringify(
      {
        setupVersion: appVersion,
        lastSeenVersion: changelog[0]?.version ?? appVersion,
        lastTrainingVersion: currentTrainingVersion(),
        hasCreatedFirstConfig: true,
        accountGateDecided: true,
        // The v2 onboarding harness (bootGates priority 1.5) outranks every gate
        // seeded above, so without these three keys it blocked EVERY e2e run and
        // the suite became vacuous. Mark the flow finished: all steps completed,
        // at the current ONBOARDING_VERSION, stamped with this app version so
        // shouldReonboardForBeta() doesn't re-fire it on the beta channel.
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-e2e-'))
  seedCleanConfig(dataDir)
  const app = await electron.launch({
    args: [APP_PATH, `--user-data-dir=${path.join(dataDir, 'electron-userdata')}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      E2E_HEADLESS: '1',
      CCC_E2E_DATA_DIR: dataDir,
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Deterministic readiness: the sidebar's new-config button renders once the
  // shell has hydrated and setup is complete (env hook → isSetupComplete).
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
  try {
    await Promise.race([
      a.app.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ])
  } catch {
    /* ignore */
  }
  try {
    a.app.process().kill()
  } catch {
    /* already gone */
  }
  // Remove ONLY the unique mkdtemp dir we created — never a parent/shared path.
  try {
    fs.rmSync(a.dataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
