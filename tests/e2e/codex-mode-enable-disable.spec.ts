/**
 * The Codex mode matrix, enable and disable round trips (P4.9, row 67;
 * WP1.60), against the real app on the fake Codex CLI. In order, on one app:
 *   1. while a Codex tab runs, Codex cannot be turned off, and its switch
 *      says why (the in-use refusal);
 *   2. once the tab's Codex has stopped, Codex turns off: its saved config
 *      says why, and a Restart of the tab reads Not started and starts nothing;
 *   3. turned on again, the config is offered again and the tab's Restart
 *      starts Codex on the same account;
 *   4. with Codex off at the next start, the Resume prompt tags the Codex
 *      tab, the restored tab reads Not started, and turning Codex on and
 *      restarting the tab starts it.
 *
 * Which Codex the app sees is the spec's fake (helpers/fake-codex.ts), which
 * records every session it is started as and stays up until `/exit`; the
 * "sign-in already on this computer" is an empty folder of the spec's own,
 * never the VM user's ~/.codex. Terminals draw with the DOM renderer (GPU
 * rendering off in the seed) so the spec reads what a tab says.
 *
 * VM ONLY: this launches the Electron app (never on the owner's workstation).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { launchIsolatedApp } from './helpers/electron-app'
import { fakeCodexEnv, FAKE_CODEX_VERSION } from './helpers/fake-codex'
import {
  seedCodexAccount, realmDirOf, fakeDirOf, fakeCodexLaunches, sameFolder, alive, createCodexConfig, openSession,
  activeSessionId, terminalText, ptyWrite, restartFresh, openAccounts, flipCodex, codexSwitchText, savedSettings,
  savedSessions, relaunchAt, hardKill,
} from './helpers/codex-mode'

const LABEL = 'E2E Codex on and off'
const OFF_TITLE = 'Codex is off. Turn it on in Settings, Accounts to launch this config.'
const NOT_STARTED = 'Not started. Codex is off. Turn it on in Settings, Accounts, then Restart this tab.'

let dataDir = ''
let workDir = ''
let app: ElectronApplication | undefined
let page: Page
const env = (d: string) => fakeCodexEnv(fakeDirOf(d), path.join(d, 'codex-home'))
const launches = () => fakeCodexLaunches(fakeDirOf(dataDir))
const configRow = () => page.getByTestId('saved-tab').locator('[data-testid="config-row"]').filter({ hasText: LABEL })

/** Stop the Codex of the tab on screen the way a user does (`/exit`). */
async function exitCodex(): Promise<void> {
  const last = launches().at(-1)!
  await ptyWrite(page, await activeSessionId(page), '/exit\r')
  await expect.poll(() => alive(last.pid), { timeout: 15000, message: `the tab's Codex (pid ${last.pid}) did not stop` }).toBe(false)
}

/** Turn Codex off in Settings, Accounts. The tab's hold on Codex ends when
 *  its process does (at most a few seconds later): a refusal while it is
 *  still counted is tried again, within a bound. */
async function turnCodexOff(): Promise<void> {
  await openAccounts(page)
  await expect(async () => {
    if ((await codexSwitchText(page).textContent())?.trim() !== 'Off') await flipCodex(page, 'off')
    await expect(codexSwitchText(page)).toHaveText('Off', { timeout: 2000 })
  }).toPass({ timeout: 30000 })
  await expect.poll(() => savedSettings(dataDir).codexEnabled, { timeout: 10000 }).toBe(false)
}

/** Turn Codex on in Settings, Accounts, and wait until the app has found
 *  the CLI again. */
async function turnCodexOn(): Promise<void> {
  await openAccounts(page)
  await flipCodex(page, 'on')
  await expect(codexSwitchText(page)).toHaveText('On', { timeout: 10000 })
  await expect(page.getByTestId('provider-status-codex')).toHaveText(`Codex ${FAKE_CODEX_VERSION} - ready`, { timeout: 30000 })
  await expect.poll(() => savedSettings(dataDir).codexEnabled, { timeout: 10000 }).toBe(true)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(120000)
  const ctx = await launchIsolatedApp({ seedExtra: (d) => seedCodexAccount(d, { fake: true, domTerminal: true }), env })
  ;({ app, page, dataDir } = ctx)
  workDir = path.join(dataDir, 'project')
  fs.mkdirSync(workDir, { recursive: true })
})

test.afterAll(async () => {
  test.setTimeout(60000)
  hardKill(app)
  try { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }) } catch { /* a handle still closing on Windows */ }
})

test('while a Codex tab runs, Codex cannot be turned off, and the switch says why', async () => {
  test.setTimeout(120000)
  await createCodexConfig(page, { label: LABEL, dir: workDir })
  await expect.poll(() => launches().length, { timeout: 30000, message: 'creating the config did not start Codex' }).toBe(1)
  expect(alive(launches()[0].pid)).toBe(true)

  await openAccounts(page)
  await expect(codexSwitchText(page)).toHaveText('On')
  await flipCodex(page, 'off')
  // Everything holding Codex is counted (the tab, and anything else of it
  // running then, such as a usage read): never fewer than the one tab.
  await expect(page.getByTestId('provider-error-codex')).toHaveText(/^Codex is in use \([1-9]\d*\)\.$/, { timeout: 10000 })
  await expect(codexSwitchText(page)).toHaveText('On')
  expect(savedSettings(dataDir).codexEnabled).toBe(true)
  expect(alive(launches()[0].pid), 'the refusal left the tab running').toBe(true)
})

test("once the tab's Codex has stopped, Codex turns off; its config says why, and a restart reads Not started", async () => {
  test.setTimeout(150000)
  await openSession(page, LABEL)
  await exitCodex()
  await expect.poll(() => terminalText(page), { timeout: 15000, message: 'the tab did not show its Codex ending' }).toMatch(/\[Process exited/)

  await turnCodexOff()

  // The saved config says why it will not launch.
  await page.locator('[data-testid="panel-tab-saved"]').click()
  await expect(configRow()).toHaveCount(1)
  const tag = configRow().getByTestId('config-row-provider-off')
  await expect(tag).toHaveText('Codex off')
  await expect(tag).toHaveAttribute('title', OFF_TITLE)

  // The tab is kept; its Restart starts nothing and says so.
  await openSession(page, LABEL)
  await restartFresh(page)
  await expect.poll(() => terminalText(page), { timeout: 15000, message: 'the restarted tab did not say it was not started' }).toContain('Not started. Codex is off.')
  // The whole line, however the terminal wrapped it.
  expect((await terminalText(page)).replace(/\s+/g, '')).toContain(NOT_STARTED.replace(/\s+/g, ''))
  expect(launches().length, 'a restart with Codex off started Codex').toBe(1)
})

test('turned on again, the config is offered again, and the tab restarts on the same account', async () => {
  test.setTimeout(120000)
  await turnCodexOn()
  await page.locator('[data-testid="panel-tab-saved"]').click()
  await expect(configRow()).toHaveCount(1)
  await expect(configRow().getByTestId('config-row-provider-off')).toHaveCount(0)

  await openSession(page, LABEL)
  await restartFresh(page)
  await expect.poll(() => launches().length, { timeout: 30000, message: 'the restart after turning Codex on did not start it' }).toBe(2)
  const again = launches()[1]
  expect(sameFolder(again.codexHome, realmDirOf(dataDir)), `CODEX_HOME ${again.codexHome}`).toBe(true)
  expect(alive(again.pid)).toBe(true)
})

test('with Codex off at the next start, the restored tab reads Not started; turned on, its restart starts it', async () => {
  test.setTimeout(180000)
  await expect.poll(() => savedSessions(dataDir).some((s) => s.provider === 'codex' && s.label === LABEL), { timeout: 20000 }).toBe(true)
  const before = launches().length
  // A crash with the tab running, then Codex off as the user left it: the
  // switch-off itself was driven through the app above, so the saved
  // setting is written here (codexAnswered stays true).
  hardKill(app)
  app = undefined
  const settingsFile = path.join(dataDir, 'resources', 'CONFIG', 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify({ ...savedSettings(dataDir), codexEnabled: false, codexAnswered: true }, null, 2))
  ;({ app, page } = await relaunchAt(dataDir, 'relaunch-off', env(dataDir)))

  const prompt = page.getByRole('dialog', { name: /Resume previous sessions/i })
  await expect(prompt).toBeVisible({ timeout: 20000 })
  await expect(prompt.getByText(LABEL, { exact: false })).toBeVisible()
  const blocked = prompt.getByTestId('resume-session-launch-blocked')
  await expect(blocked).toHaveText('Codex off')
  await expect(blocked).toHaveAttribute('title', NOT_STARTED)
  await prompt.getByRole('button', { name: 'Resume', exact: true }).click()

  await openSession(page, LABEL)
  await expect.poll(() => terminalText(page), { timeout: 20000, message: 'the restored tab did not say it was not started' }).toContain('Not started. Codex is off.')
  expect(launches().length, 'a restored tab started Codex while it was off').toBe(before)

  await turnCodexOn()
  await openSession(page, LABEL)
  await restartFresh(page)
  await expect.poll(() => launches().length, { timeout: 30000, message: 'the restart after turning Codex on did not start it' }).toBe(before + 1)
  expect(sameFolder(launches()[before].codexHome, realmDirOf(dataDir))).toBe(true)
})
