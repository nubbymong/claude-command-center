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
import { currentTrainingVersion } from '../../src/renderer/training-steps'

const APP_PATH = path.resolve(__dirname, '../../out/main/index.js')
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'),
).version as string

/**
 * A build the user came FROM. It must be >= the NEWEST step `sinceVersion`
 * (currently `commandBar` at 2.1.0-beta.17), so `stepsNewSince` returns
 * nothing and the What's-New page is the WHOLE upgrade run — which is what
 * lets this spec test the notes→resume handover directly. beta.14 (the old
 * value) was older than beta.17, so the run also included the commandBar setup
 * step: the last CTA read "Set it up →", not "Continue", and dismissing the
 * notes handed to that step rather than to resume — the staleness #448 is about.
 * If a later step ships with a newer `sinceVersion`, bump this to match (the
 * frozen table in onboarding-registry.test.ts is where you will see it change).
 * The last test guards the coupling: the final CTA reads "Continue" only when
 * the notes page is genuinely last.
 */
const PREV_VERSION = '2.1.0-beta.17'

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
      // Derived, not hardcoded: this spec is about the What's-New / resume
      // priority chain, so the training walkthrough must stay suppressed. A
      // literal goes stale the moment any card is added above it (#372), which
      // would arm the tour and change what this spec is actually testing.
      lastTrainingVersion: currentTrainingVersion(),
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

test('the notes open on the summary page of the multi-page showcase', async () => {
  // The 2.1 line has a per-feature showcase behind the summary (#441): the
  // footer carries dot navigation, page 0 is the summary, and its CTA advances
  // rather than ending the run. Assert the SHAPE (summary + N showcases), not a
  // fixed page count, so adding a showcase page does not re-break this.
  await expect(page.locator('[data-ux-id="whatsnew-heading"]')).toContainText("What's new in")
  const dots = page.locator('[data-ux-id="whatsnew-dots"] .wn-fdot')
  const total = await dots.count()
  expect(total).toBeGreaterThan(1) // summary + at least one showcase
  await expect(page.locator('[data-ux-id="whatsnew-dot-summary"]')).toHaveClass(/on/)
  // On the summary the CTA advances and a Skip is offered — it does not end here.
  await expect(page.locator('.ob-root .cta')).toHaveText('Next →')
  await expect(page.locator('[data-ux-id="whatsnew-skip"]')).toBeVisible()
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

test('paging to the last showcase page ends the run and hands over to resume', async () => {
  // Advance through the showcase with the footer CTA. On every inner page it
  // reads "Next →"; on the LAST page it becomes the run-ending label. Because
  // PREV_VERSION leaves the notes as the only step, that label is "Continue"
  // (the harness passes it when the page ends the run) — which is also the
  // guard on PREV_VERSION's coupling: a setup step slipping in after the notes
  // would make this read "Set it up →" instead.
  const cta = page.locator('.ob-root .cta')
  for (let i = 0; i < 12; i++) {
    if ((await cta.textContent())?.trim() !== 'Next →') break
    await cta.click()
  }
  await expect(cta).toHaveText('Continue')
  await cta.click()
  await expect(page.locator('.ob-root')).toHaveCount(0, { timeout: 10000 })
  // The saved session seeded above is now the pending decision — and this is
  // also what proves the resume assertion above was not vacuous: the prompt DOES
  // arrive, it was simply waiting its turn behind the notes.
  await expect(page.locator('#resume-sessions-heading')).toBeVisible({ timeout: 10000 })
  await expect(page.getByText('alpha')).toBeVisible()
})
