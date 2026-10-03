/**
 * The Codex mode matrix, restart (P4.9, row 67; WP1.60), against the real app
 * on the fake Codex CLI:
 *   1. a Codex tab's Restart starts a new Codex process for the same session,
 *      on the same account's folder, with the same options, and the old one
 *      is gone;
 *   2. an app relaunch after a crash offers the Codex tab back, and the
 *      restored tab starts Codex again on that account.
 *
 * The fake (helpers/fake-codex.ts) stands in for Codex's TUI when the app
 * starts a session: it records each start (argv, CODEX_HOME, working folder,
 * pid) beside itself and stays up, so the spec counts starts and compares
 * them. It is first on the instance's PATH with every real Codex taken off
 * it, and the "sign-in already on this computer" the app checks is an empty
 * folder of the spec's own: nothing reads the VM user's ~/.codex.
 *
 * VM ONLY: this launches the Electron app (never on the owner's workstation).
 * The data dir outlives the first launch (the relaunch reads it), so it is
 * removed here, not by closeIsolatedApp.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { launchIsolatedApp } from './helpers/electron-app'
import { fakeCodexEnv, FAKE_CODEX_VERSION } from './helpers/fake-codex'
import {
  CODEX_ACCOUNT, seedCodexAccount, realmDirOf, fakeDirOf, fakeCodexLaunches, flagValue, sameFolder, alive,
  createCodexConfig, openSession, restartFresh, savedSessions, relaunchAt, hardKill,
} from './helpers/codex-mode'

const LABEL = 'E2E Codex restart'
/** The options a restart and a restore must keep. */
const KEPT = ['--sandbox', '--ask-for-approval', '-m']

let dataDir = ''
let workDir = ''
let app: ElectronApplication | undefined
let page: Page
const env = (d: string) => fakeCodexEnv(fakeDirOf(d), path.join(d, 'codex-home'))

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(120000)
  const ctx = await launchIsolatedApp({ seedExtra: (d) => seedCodexAccount(d, { fake: true }), env })
  ;({ app, page, dataDir } = ctx)
  workDir = path.join(dataDir, 'project')
  fs.mkdirSync(workDir, { recursive: true })
})

test.afterAll(async () => {
  test.setTimeout(60000)
  hardKill(app)
  try { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }) } catch { /* a handle still closing on Windows */ }
})

test('a Codex tab restarts as a new Codex process, on the same account, with the same options', async () => {
  test.setTimeout(120000)
  // The app sees the spec's fake, not the machine's Codex.
  const discovered = await page.evaluate(async () => {
    const api = (window as unknown as { electronAPI: { providerAccounts: { discover: (id: string) => Promise<unknown> } } }).electronAPI
    return api.providerAccounts.discover('codex')
  }) as { ok: boolean; installation?: Record<string, unknown> }
  expect(discovered.installation, `main did not find the spec's fake Codex: ${JSON.stringify(discovered)}`)
    .toMatchObject({ discoveryState: 'found', version: FAKE_CODEX_VERSION, compatibility: 'supported' })

  await createCodexConfig(page, { label: LABEL, dir: workDir })
  await expect.poll(() => fakeCodexLaunches(fakeDirOf(dataDir)).length, { timeout: 30000, message: 'creating the config did not start Codex' }).toBe(1)
  const [first] = fakeCodexLaunches(fakeDirOf(dataDir))
  expect(sameFolder(first.codexHome, realmDirOf(dataDir)), `CODEX_HOME ${first.codexHome}`).toBe(true)
  expect(sameFolder(first.cwd, workDir), `working folder ${first.cwd}`).toBe(true)
  expect(first.argv[0], 'a new config starts a new conversation').not.toBe('resume')
  expect(first.tty, 'Codex runs on the terminal').toBe(true)

  await openSession(page, LABEL)
  await restartFresh(page)
  await expect.poll(() => fakeCodexLaunches(fakeDirOf(dataDir)).length, { timeout: 30000, message: 'Restart did not start Codex again' }).toBe(2)
  const second = fakeCodexLaunches(fakeDirOf(dataDir))[1]
  expect(second.pid).not.toBe(first.pid)
  expect(sameFolder(second.codexHome, realmDirOf(dataDir)), `CODEX_HOME ${second.codexHome}`).toBe(true)
  for (const flag of KEPT) expect(flagValue(second.argv, flag), flag).toBe(flagValue(first.argv, flag))
  // A plain Restart with no conversation to carry on starts afresh.
  expect(second.argv[0]).not.toBe('resume')
  // The old Codex went with the restart.
  await expect.poll(() => alive(first.pid), { timeout: 15000, message: `the first Codex (pid ${first.pid}) outlived the restart` }).toBe(false)
  // One tab, still bound to its account.
  await page.locator('[data-testid="panel-tab-running"]').click()
  await expect(page.locator('.session-card').filter({ hasText: LABEL })).toHaveCount(1)
})

test('after a crash, a relaunch offers the Codex tab back, and the restored tab starts Codex on its account', async () => {
  test.setTimeout(150000)
  // The autosave has the Codex tab, bound to its account.
  await expect.poll(
    () => savedSessions(dataDir).some((s) => s.provider === 'codex' && s.label === LABEL && s.providerAccountId === CODEX_ACCOUNT.accountId),
    { timeout: 20000, message: 'the Codex tab was not saved for the next start' },
  ).toBe(true)
  const [first] = fakeCodexLaunches(fakeDirOf(dataDir))
  const before = fakeCodexLaunches(fakeDirOf(dataDir)).length

  hardKill(app)
  app = undefined
  ;({ app, page } = await relaunchAt(dataDir, 'relaunch-1', env(dataDir)))

  const prompt = page.getByRole('dialog', { name: /Resume previous sessions/i })
  await expect(prompt).toBeVisible({ timeout: 20000 })
  await expect(prompt.getByText(LABEL, { exact: false })).toBeVisible()
  // Codex is on: the tab is not tagged as one that will not start.
  await expect(prompt.getByTestId('resume-session-launch-blocked')).toHaveCount(0)
  await prompt.getByRole('button', { name: 'Resume', exact: true }).click()

  await openSession(page, LABEL)
  await expect.poll(() => fakeCodexLaunches(fakeDirOf(dataDir)).length, { timeout: 30000, message: 'the restored tab did not start Codex' }).toBe(before + 1)
  const restored = fakeCodexLaunches(fakeDirOf(dataDir))[before]
  expect(sameFolder(restored.codexHome, realmDirOf(dataDir)), `CODEX_HOME ${restored.codexHome}`).toBe(true)
  for (const flag of KEPT) expect(flagValue(restored.argv, flag), flag).toBe(flagValue(first.argv, flag))
  expect(sameFolder(restored.cwd, workDir), `working folder ${restored.cwd}`).toBe(true)
})
