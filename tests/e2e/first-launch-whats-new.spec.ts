/**
 * First launch after an update: ONE full-screen surface, and one queue.
 *
 * Pins the two halves of the 2026-08-21 report — "whats new is a horrible wall
 * of text" and "it came up at same time as resume prompt and the seintinal ui"
 * — against the real app rather than against the pure functions underneath it.
 * That distinction is the point: every unit test here passed while the app was
 * still opening the modal, because the bug was in which surface the boot path
 * chose, not in any single decision it made.
 *
 * The seed is deliberately NOT `launchIsolatedApp`'s: that one suppresses What's
 * New so the other specs can reach the UI. This one wants it to fire.
 */
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { STEPS, ONBOARDING_VERSION } from '../../src/renderer/onboarding/steps'
import { emptyGitHubConfig } from '../../src/shared/github-constants'

const APP_PATH = path.resolve(__dirname, '../../out/main/index.js')
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'),
).version as string

/** A build the user could plausibly have come FROM: same line, one behind. */
const PREV_VERSION = '2.1.0-beta.14'

let app: ElectronApplication | undefined
let page: Page
let dataDir: string

test.beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-e2e-firstlaunch-'))
  const config = path.join(dataDir, 'resources', 'CONFIG')
  for (const sub of ['CONFIG', 'insights', 'screenshots', 'skills', 'scripts', 'status']) {
    fs.mkdirSync(path.join(dataDir, 'resources', sub), { recursive: true })
  }
  // Someone who finished onboarding on PREV_VERSION and is now on this build.
  fs.writeFileSync(
    path.join(config, 'app-meta.json'),
    JSON.stringify({
      setupVersion: APP_VERSION,
      lastSeenVersion: PREV_VERSION,
      lastTrainingVersion: '2.1.0',
      hasCreatedFirstConfig: true,
      accountGateDecided: true,
      completedSteps: Object.fromEntries(STEPS.map((s) => [s.id, PREV_VERSION])),
      onboardingCompletedVersion: ONBOARDING_VERSION,
      onboardingAppVersion: PREV_VERSION,
    }),
  )
  fs.writeFileSync(
    path.join(config, 'settings.json'),
    JSON.stringify({ loggingConsentSeen: true, localMachineName: 'e2e-host', updateChannel: 'beta' }),
  )
  // Retire the legacy GitHub onboarding modal. It sits BETWEEN the harness and
  // resume in the priority chain, so leaving it armed means the notes hand over
  // to it rather than to resume — which is the chain working correctly, and
  // which is exactly what the first run of this spec caught.
  fs.writeFileSync(
    path.join(config, 'github-config.json'),
    JSON.stringify({ ...emptyGitHubConfig(), seenOnboardingVersion: 'permanent' }),
  )
  // Saved sessions, so the resume prompt is genuinely pending at the same
  // moment the notes are due. Without this the stacking cannot be reproduced
  // and the test would pass for the wrong reason.
  fs.writeFileSync(
    path.join(config, 'session-state.json'),
    JSON.stringify({
      sessions: [
        { id: 'e2e-a', label: 'alpha', workingDirectory: os.homedir(), color: '#89b4fa', sessionType: 'local' },
      ],
      activeSessionId: 'e2e-a',
      savedAt: 1755000000000,
    }),
  )

  app = await electron.launch({
    args: [APP_PATH, `--user-data-dir=${path.join(dataDir, 'electron-userdata')}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      E2E_HEADLESS: '1',
      CCC_E2E_DATA_DIR: dataDir,
      CCC_FORCE_SPLASH: '0',
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (app) {
    try {
      await Promise.race([app.close(), new Promise<void>((r) => setTimeout(r, 5000))])
    } catch { /* ignore */ }
    try { app.process().kill() } catch { /* already gone */ }
  }
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('an upgrade opens the full-screen page, not the What\'s New modal', async () => {
  // .ob-root is the full-screen harness; the modal is a max-w-lg dialog with an
  // h2 of "What's New". Assert BOTH directions — the harness present AND the
  // modal absent — because the modal still exists for Settings and a regression
  // would put it back on the boot path rather than delete the page.
  await expect(page.locator('.ob-root')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.ob-root h2')).toContainText('What\'s new in')
  await expect(page.getByRole('heading', { name: 'What\'s New', exact: true })).toHaveCount(0)
})

test('the release-notes run is one page, with no setup breadcrumbs', async () => {
  // Nothing in this build carries a newer sinceVersion, so the notes are the
  // whole run: the CTA ends it rather than promising pages that do not exist.
  await expect(page.locator('.ob-root .crumbs')).toHaveCount(0)
  await expect(page.locator('.ob-root .cta')).toHaveText('Continue')
})

test('the resume prompt does not paint over it', async () => {
  // THE REPORTED DEFECT. The resume prompt stood aside only for the onboarding
  // harness — and the release notes were a SEPARATE gate, so that guard never
  // covered them. It is now a gate of its own, below the harness.
  //
  // Sentinel is not asserted here on purpose: it renders nothing when there are
  // no findings, so an absence check would pass on a machine with the bug still
  // in it. Its suppression is pinned in the bootGates unit tests instead.
  await expect(page.locator('#resume-sessions-heading')).toHaveCount(0)
})

test('dismissing the notes hands over to the resume prompt, then the app', async () => {
  await page.locator('.ob-root .cta').click()
  await expect(page.locator('.ob-root')).toHaveCount(0, { timeout: 10000 })
  // The saved session seeded above is now the pending decision — and this is
  // also what proves the previous assertion was not vacuous: the prompt DOES
  // arrive, it was simply waiting its turn.
  await expect(page.locator('#resume-sessions-heading')).toBeVisible({ timeout: 10000 })
  await expect(page.getByText('alpha')).toBeVisible()
})
