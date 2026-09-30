/**
 * "Do you use Codex?" after an update (owner decisions 2026-09-26), against the
 * real app: every user who updates answers again, nothing carries over from the
 * earlier Codex setting, and the answer is recorded only when given.
 *
 * Three upgraders, as they arrive from an earlier build (no `codexAnswered`):
 *   - Claude only (never touched Codex): the page shows after the release
 *     notes; No records Codex off and answered, and a relaunch never asks again.
 *   - Codex only (Claude Code off, an earlier `codexEnabled: true`): No cannot
 *     be chosen and says why; Yes leads to the Set up Codex page.
 *   - both (an earlier `codexEnabled: true`): the earlier setting does not carry
 *     over, the page asks, and closing the app before answering asks again.
 *
 * VM ONLY: this launches the Electron app (never on the owner's workstation).
 * The seed is this spec's own, not `launchIsolatedApp`'s, which answers the
 * question so the other specs reach the app. `CODEX_HOME` names an empty
 * folder of the seed's, so the Set up Codex page never looks at the VM's own
 * `~/.codex`.
 */
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { STEPS, ONBOARDING_VERSION } from '../../src/renderer/onboarding/steps'
import { emptyGitHubConfig } from '../../src/shared/github-constants'
import { currentTrainingVersion } from '../../src/renderer/training-steps'

const APP_PATH = path.resolve(__dirname, '../../out/main/index.js')
const APP_VERSION = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')).version as string
/** The build the user came from: see first-launch-whats-new.spec.ts for why
 *  this value keeps the upgrade run to the release notes alone. */
const PREV_VERSION = '2.1.0-rc.9'

function seed(settings: Record<string, unknown>): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-e2e-codex-reconfirm-'))
  const config = path.join(dataDir, 'resources', 'CONFIG')
  for (const sub of ['CONFIG', 'insights', 'screenshots', 'skills', 'scripts', 'status']) {
    fs.mkdirSync(path.join(dataDir, 'resources', sub), { recursive: true })
  }
  fs.writeFileSync(path.join(config, 'app-meta.json'), JSON.stringify({
    setupVersion: APP_VERSION,
    lastSeenVersion: PREV_VERSION,
    lastTrainingVersion: currentTrainingVersion(),
    hasCreatedFirstConfig: true,
    accountGateDecided: true,
    completedSteps: Object.fromEntries(STEPS.map((s) => [s.id, PREV_VERSION])),
    onboardingCompletedVersion: ONBOARDING_VERSION,
    onboardingAppVersion: PREV_VERSION,
  }))
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({
    loggingConsentSeen: true,
    // P3.12 round 1: the current indexing notice, so it is not shown again here.
    loggingConsentVersion: 2,
    localMachineName: 'e2e-host',
    updateChannel: 'stable',
    updateChannelChosen: true,
    ...settings,
  }))
  fs.writeFileSync(path.join(config, 'github-config.json'), JSON.stringify({ ...emptyGitHubConfig(), seenOnboardingVersion: 'permanent' }))
  fs.mkdirSync(codexHome(dataDir), { recursive: true })
  return dataDir
}

/** This run's own Codex home: empty, so there is no sign-in on "this computer". */
const codexHome = (dataDir: string): string => path.join(dataDir, 'codex-home')

async function launch(dataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  // The runner's CODEX_HOME goes, whatever its case (Windows keeps one
  // variable per name, case-insensitively; two spellings leave the winner to
  // chance), and this run's own replaces it.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toUpperCase() !== 'CODEX_HOME') env[key] = value
  }
  const app = await electron.launch({
    args: [APP_PATH, `--user-data-dir=${path.join(dataDir, 'electron-userdata')}`],
    env: { ...env, NODE_ENV: 'test', E2E_HEADLESS: '1', CCC_E2E_DATA_DIR: dataDir, CCC_FORCE_SPLASH: '0', CODEX_HOME: codexHome(dataDir) },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** The app itself is showing, and nothing covers it: the sidebar's Saved tab
 *  (the anchor launchIsolatedApp waits on; it renders once the config has
 *  loaded) is visible, and the app behind the window-covering pages is not
 *  inert (App.tsx `app-behind`: inert while the release notes, the Codex
 *  question or the Set up Codex page shows). The start-up gates are decided
 *  in the effect that runs after that first render, so two animation frames
 *  pass before the check: a page that is going to show has shown by then.
 *  Only after this does an absence assertion prove anything; before the
 *  renderer boots, every page is absent. */
async function appUncovered(page: Page): Promise<void> {
  await expect(page.locator('[data-tour="new-config"]')).toBeVisible({ timeout: 20000 })
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(page.getByTestId('app-behind')).not.toHaveAttribute('inert', { timeout: 10000 })
}

async function close(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return
  try { await Promise.race([app.close(), new Promise<void>((r) => setTimeout(r, 5000))]) } catch { /* ignore */ }
  try { app.process().kill() } catch { /* already gone */ }
}

/** Page through the release notes to their end, as the user does. */
async function finishNotes(page: Page): Promise<void> {
  await expect(page.locator('.ob-root')).toBeVisible({ timeout: 20000 })
  const cta = page.locator('.ob-root .cta')
  const dots = page.locator('[data-ux-id="whatsnew-dots"] .wn-fdot')
  const pages = await dots.count()
  for (let i = 0; i < pages; i++) {
    if ((await cta.textContent())?.trim() !== 'Next →') break
    await cta.click()
    await expect(dots.nth(i + 1)).toHaveClass(/(^|\s)on(\s|$)/)
  }
  await expect(cta).toHaveText('Continue')
  await cta.click()
}

const savedSettings = (dataDir: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(dataDir, 'resources', 'CONFIG', 'settings.json'), 'utf-8'))

/** The saved settings, once the app has written them (the save is async). */
async function settled(dataDir: string, key: string): Promise<Record<string, unknown>> {
  await expect.poll(() => savedSettings(dataDir)[key], { timeout: 10000 }).not.toBeUndefined()
  return savedSettings(dataDir)
}

test.describe('Claude-only upgrader', () => {
  let app: ElectronApplication | undefined
  let dataDir: string
  test.beforeAll(() => { dataDir = seed({}) })
  test.afterAll(async () => {
    await close(app)
    try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('asks after the notes; No records Codex off and answered; a relaunch never asks again', async () => {
    let page: Page
    ;({ app, page } = await launch(dataDir))
    await finishNotes(page)
    await expect(page.getByTestId('codex-reconfirm')).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('heading', { name: 'Do you use Codex?' })).toBeVisible()
    // Escape does nothing: the page cannot be left without an answer.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('codex-reconfirm')).toBeVisible()
    await page.getByTestId('codex-reconfirm-no').click()
    await page.getByTestId('codex-reconfirm-continue').click()
    await expect(page.getByTestId('codex-reconfirm')).toHaveCount(0, { timeout: 10000 })
    // No leads to the app, not to Set up Codex.
    await appUncovered(page)
    await expect(page.getByTestId('codex-setup')).toHaveCount(0)
    const s = await settled(dataDir, 'codexAnswered')
    expect(s).toMatchObject({ codexEnabled: false, codexAnswered: true })
    await close(app)
    ;({ app, page } = await launch(dataDir))
    // The app comes up with nothing over it: no release notes, no question.
    await appUncovered(page)
    await expect(page.locator('.ob-root')).toHaveCount(0)
    await expect(page.getByTestId('codex-reconfirm')).toHaveCount(0)
  })
})

test.describe('Codex-only upgrader', () => {
  let app: ElectronApplication | undefined
  let dataDir: string
  test.beforeAll(() => { dataDir = seed({ claudeEnabled: false, codexEnabled: true }) })
  test.afterAll(async () => {
    await close(app)
    try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('No cannot be chosen and says why; Yes leads to Set up Codex, and is recorded', async () => {
    let page: Page
    ;({ app, page } = await launch(dataDir))
    await finishNotes(page)
    await expect(page.getByTestId('codex-reconfirm')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('codex-reconfirm-no')).toBeDisabled()
    await expect(page.getByTestId('codex-reconfirm-no-why')).toHaveText('Claude Code is off, and one assistant always stays on.')
    await page.getByTestId('codex-reconfirm-continue').click()
    await expect(page.getByTestId('codex-setup')).toBeVisible({ timeout: 10000 })
    const s = await settled(dataDir, 'codexAnswered')
    expect(s).toMatchObject({ codexEnabled: true, codexAnswered: true })
    await page.getByTestId('codex-setup-skip').click()
    await expect(page.getByTestId('codex-setup')).toHaveCount(0, { timeout: 10000 })
  })
})

test.describe('Claude and Codex upgrader', () => {
  let app: ElectronApplication | undefined
  let dataDir: string
  test.beforeAll(() => { dataDir = seed({ codexEnabled: true }) })
  test.afterAll(async () => {
    await close(app)
    try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('the earlier Codex setting does not carry over, and closing before answering asks again', async () => {
    let page: Page
    ;({ app, page } = await launch(dataDir))
    await finishNotes(page)
    await expect(page.getByTestId('codex-reconfirm')).toBeVisible({ timeout: 10000 })
    // Nothing recorded by showing the page: the earlier value is gone (hydrate
    // drops it), and no answer is written.
    await expect.poll(() => savedSettings(dataDir).codexEnabled, { timeout: 10000 }).toBeUndefined()
    expect(savedSettings(dataDir).codexAnswered).toBeUndefined()
    await close(app)
    ;({ app, page } = await launch(dataDir))
    // The notes were seen; the question was not answered: it is asked again.
    await expect(page.getByTestId('codex-reconfirm')).toBeVisible({ timeout: 20000 })
    await page.getByTestId('codex-reconfirm-continue').click()
    await expect(page.getByTestId('codex-setup')).toBeVisible({ timeout: 10000 })
    expect(await settled(dataDir, 'codexAnswered')).toMatchObject({ codexEnabled: true, codexAnswered: true })
  })
})
