/**
 * A fresh install chooses its assistants (WP1.1; P4.9, row 67, with P4.10):
 * the real app's onboarding, from its first page to the app, once per choice.
 *   - Claude Code only, with no Codex installed (WP1.1): the Codex pages never
 *     show, the choice is saved (Claude on, Codex off and answered), the app
 *     is reached, and Settings, Accounts shows Codex off.
 *   - Both, with no Codex installed: Set up Codex says the CLI was not found
 *     and can be skipped; both are saved on; Accounts says Codex was not found.
 *   - Codex only, with the fake Codex: Claude's pages never show, Set up Codex
 *     shows, Claude is saved off; Accounts shows Codex ready and Claude off.
 *
 * Fresh: no lastSeenVersion and no finished steps, so the onboarding opens in
 * its fresh-install form. setupVersion is seeded only to keep the Claude CLI
 * setup wizard away, which starts a real `claude` in a terminal; it does not
 * change the fresh-install form (OnboardingHarness reads lastSeenVersion).
 *
 * Which CLIs the app sees is the spec's own: a stand-in `claude` that answers
 * `--version` with a supported version (2.1.278), first on the instance's
 * PATH, and, for the Codex-only case, the fake Codex (helpers/fake-codex.ts);
 * every folder holding a real Claude or Codex is taken off that PATH, and
 * CODEX_HOME is an empty folder of the spec's. Nothing reads the VM user's
 * ~/.claude or ~/.codex (the home is inside the data dir, isolated-env.ts).
 *
 * VM ONLY: this launches the Electron app (never on the owner's workstation).
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { emptyGitHubConfig } from '../../src/shared/github-constants'
import { isolatedLaunchEnv } from './helpers/isolated-env'
import { installFakeCodex, FAKE_CODEX_VERSION } from './helpers/fake-codex'
import { openAccounts, savedSettings, hardKill } from './helpers/codex-mode'

const APP_PATH = path.resolve(__dirname, '../../out/main/index.js')
const APP_VERSION = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')).version as string
const IS_WIN = process.platform === 'win32'
/** A Claude Code the app supports (CLAUDE_MIN_MANAGED_CLI_VERSION). */
const STAND_IN_CLAUDE_VERSION = '2.1.278'
const CLI_NAMES = ['claude', 'claude.exe', 'claude.cmd', 'claude.bat', 'claude.ps1', 'codex', 'codex.exe', 'codex.cmd', 'codex.bat', 'codex.ps1']

type Choice = 'claude' | 'codex' | 'both'

/** A fresh data dir: past the indexing notice and the GitHub modal only. */
function seedFresh(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-e2e-onboarding-'))
  const config = path.join(dataDir, 'resources', 'CONFIG')
  for (const sub of ['CONFIG', 'insights', 'screenshots', 'skills', 'scripts', 'status']) {
    fs.mkdirSync(path.join(dataDir, 'resources', sub), { recursive: true })
  }
  fs.writeFileSync(path.join(config, 'app-meta.json'), JSON.stringify({ setupVersion: APP_VERSION }))
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({
    loggingConsentSeen: true,
    loggingConsentVersion: 2,
    updateChannel: 'stable',
    updateChannelChosen: true,
  }))
  fs.writeFileSync(path.join(config, 'github-config.json'), JSON.stringify({ ...emptyGitHubConfig(), seenOnboardingVersion: 'permanent' }))
  return dataDir
}

/** A stand-in `claude` that answers `--version` and records every call. */
function installStandInClaude(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'stand-in-claude.js'), [
    "const fs = require('fs'), path = require('path')",
    "fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ argv: process.argv.slice(2), at: Date.now() }) + String.fromCharCode(10))",
    `if (process.argv[2] === '--version') { process.stdout.write('${STAND_IN_CLAUDE_VERSION} (Claude Code)' + String.fromCharCode(10)); process.exit(0) }`,
    'process.exit(0)',
    '',
  ].join('\n'))
  if (IS_WIN) {
    fs.writeFileSync(path.join(dir, 'claude.cmd'), ['@ECHO off', `"${process.execPath}" "%~dp0stand-in-claude.js" %*`, ''].join('\r\n'))
  } else {
    fs.writeFileSync(path.join(dir, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(path.join(dir, 'stand-in-claude.js'))})\n`, { mode: 0o755 })
    // The app finds a CLI through a login shell on macOS and Linux: a stand-in
    // that keeps the PATH given here (as helpers/fake-codex.ts's does), so the
    // user's own login shell never puts a real Claude or Codex back, with or
    // without the fake Codex.
    fs.writeFileSync(path.join(dir, 'login-shell'), '#!/bin/sh\n[ "$1" = "-l" ] && shift\nexec /bin/sh "$@"\n', { mode: 0o755 })
  }
  return dir
}

/** PATH without any folder holding a Claude or a Codex, the given folders first. */
function pathWith(first: string[]): string {
  const rest = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d && !CLI_NAMES.some((n) => {
    try { return fs.existsSync(path.join(d, n)) } catch { return false }
  }))
  return [...first, ...rest].join(path.delimiter)
}

async function launch(dataDir: string, withCodex: boolean): Promise<{ app: ElectronApplication; page: Page }> {
  const claudeDir = installStandInClaude(path.join(dataDir, 'stand-in-claude'))
  const codexDir = withCodex ? installFakeCodex(path.join(dataDir, 'fake-codex')) : null
  const codexHome = path.join(dataDir, 'codex-home')
  fs.mkdirSync(codexHome, { recursive: true })
  const app = await electron.launch({
    args: [APP_PATH, `--user-data-dir=${path.join(dataDir, 'electron-userdata')}`],
    env: isolatedLaunchEnv(dataDir, {
      PATH: pathWith(codexDir ? [claudeDir, codexDir] : [claudeDir]),
      CODEX_HOME: codexHome,
      // The stand-in login shell on macOS and Linux, in every cell.
      ...(!IS_WIN ? { SHELL: path.join(claudeDir, 'login-shell') } : {}),
    }),
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

const visible = async (l: Locator) => (await l.count()) > 0 && (await l.first().isVisible().catch(() => false))

/** Where the onboarding is: its page's heading, else the start of its text. */
async function whereAmI(root: Locator): Promise<string> {
  if ((await root.count()) === 0) return '(the app)'
  const h = root.locator('h1, h2').filter({ visible: true }).first()
  const heading = (await h.count()) ? ((await h.textContent()) ?? '').trim() : ''
  if (heading) return heading
  return ((await root.first().innerText().catch(() => '')) ?? '').trim().slice(0, 120)
}

/**
 * Walk the onboarding as a user who takes the defaults: skip the showcase,
 * choose `choice` on the assistants page, skip Set up Codex, go past every
 * other page with its main button ("Continue anyway" where the Claude version
 * was not read), and leave from the last page with "Skip to the app". Returns
 * the pages passed, in order.
 */
async function walk(page: Page, choice: Choice, seen: { codexSetupState?: string }): Promise<string[]> {
  const root = page.locator('.ob-root').filter({ visible: true })
  await expect(root, 'the onboarding did not open on a fresh install').toHaveCount(1, { timeout: 30000 })
  const steps: string[] = []
  for (let i = 0; i < 40; i++) {
    if ((await root.count()) === 0) return steps
    const here = await whereAmI(root)
    const go = async (what: string, target: Locator) => {
      steps.push(what)
      await target.click()
      await expect.poll(async () => (await whereAmI(root)) !== here, { timeout: 20000, message: `${what} did not move on from "${here}"` }).toBe(true)
    }
    if (await visible(page.getByTestId('assistants-cards'))) {
      const card = page.getByTestId(`assistants-card-${choice}`)
      await card.click()
      await expect(card).toHaveAttribute('aria-checked', 'true')
      await go(`assistants:${choice}`, page.getByTestId('assistants-continue'))
      continue
    }
    if (await visible(page.locator('[data-ux-id="whatsnew-skip"]'))) { await go('showcase:skip', page.locator('[data-ux-id="whatsnew-skip"]')); continue }
    if (await visible(page.getByTestId('codex-setup'))) {
      // Settled once it says where Codex stands (the CLI check is async).
      const states = ['missing', 'update', 'sign-in', 'adopt', 'done', 'unavailable']
      let state = ''
      await expect.poll(async () => {
        for (const s of states) if (await visible(page.getByTestId(`codex-setup-${s}`))) { state = s; return s }
        return ''
      }, { timeout: 30000, message: 'Set up Codex never said where Codex stands' }).not.toBe('')
      seen.codexSetupState = state
      await go(`codexSetup:${state}:skip`, page.getByTestId('codex-setup-skip'))
      continue
    }
    const toApp = root.locator('button.skip', { hasText: 'Skip to the app' })
    if (await visible(toApp)) { await go('finish:skip-to-app', toApp); continue }
    const anyway = root.locator('button.foot-skip').filter({ visible: true })
    if (await visible(anyway)) { await go(`${here}:continue-anyway`, anyway.first()); continue }
    const cta = root.locator('button.cta').filter({ visible: true })
    if (await visible(cta)) {
      // A page's main button can be off while it loads (GitHub's Next until
      // its saved setting is read): wait a bounded while before calling it stuck.
      await expect(cta.first()).toBeEnabled({ timeout: 10000 }).catch(() => { /* judged below */ })
      if (await cta.first().isEnabled()) { await go(here, cta.first()); continue }
    }
    throw new Error(`the onboarding is stuck at "${here}" after: ${steps.join(' > ')}`)
  }
  throw new Error(`the onboarding did not finish: ${steps.join(' > ')}`)
}

/** The app is showing and nothing covers it (codex-reconfirm-upgrade.spec.ts). */
async function appUncovered(page: Page): Promise<void> {
  await expect(page.locator('.ob-root').filter({ visible: true })).toHaveCount(0, { timeout: 15000 })
  await expect(page.locator('[data-tour="new-config"]')).toBeVisible({ timeout: 20000 })
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(page.getByTestId('app-behind')).not.toHaveAttribute('inert', { timeout: 10000 })
}

function cell(title: string, choice: Choice, withCodex: boolean, check: (o: { page: Page; dataDir: string; steps: string[]; seen: { codexSetupState?: string } }) => Promise<void>) {
  test.describe(title, () => {
    let app: ElectronApplication | undefined
    let dataDir = ''
    test.afterAll(async () => {
      hardKill(app)
      try { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }) } catch { /* a handle still closing on Windows */ }
    })
    test('reaches the app with its choice saved', async () => {
      test.setTimeout(180000)
      dataDir = seedFresh()
      let page: Page
      ;({ app, page } = await launch(dataDir, withCodex))
      const seen: { codexSetupState?: string } = {}
      const steps = await walk(page, choice, seen)
      test.info().annotations.push({ type: 'pages', description: steps.join(' > ') })
      await appUncovered(page)
      await check({ page, dataDir, steps, seen })
    })
  })
}

cell('a fresh install, Claude Code only, no Codex installed (WP1.1)', 'claude', false, async ({ page, dataDir, steps }) => {
  expect(steps).toContain('assistants:claude')
  expect(steps.some((s) => s.startsWith('codexSetup')), 'a Codex page showed for a Claude-only choice').toBe(false)
  expect(steps.some((s) => /find Claude/i.test(s)), 'the Claude pages were skipped').toBe(true)
  await expect.poll(() => savedSettings(dataDir).codexAnswered, { timeout: 10000 }).toBe(true)
  expect(savedSettings(dataDir)).toMatchObject({ codexEnabled: false, codexAnswered: true })
  expect(savedSettings(dataDir).claudeEnabled).not.toBe(false)
  await openAccounts(page)
  await expect(page.getByTestId('provider-switch-text-codex')).toHaveText('Off')
  await expect(page.getByTestId('provider-status-codex')).toHaveText('Off')
  await expect(page.getByTestId('provider-status-claude')).toHaveText(`Claude Code ${STAND_IN_CLAUDE_VERSION} - ready`, { timeout: 30000 })
})

cell('a fresh install, both assistants, no Codex installed', 'both', false, async ({ page, dataDir, steps, seen }) => {
  expect(steps).toContain('assistants:both')
  expect(seen.codexSetupState, 'Set up Codex did not say the CLI was not found').toBe('missing')
  await expect.poll(() => savedSettings(dataDir).codexEnabled, { timeout: 10000 }).toBe(true)
  expect(savedSettings(dataDir)).toMatchObject({ codexEnabled: true, codexAnswered: true })
  expect(savedSettings(dataDir).claudeEnabled).not.toBe(false)
  await openAccounts(page)
  await expect(page.getByTestId('provider-switch-text-codex')).toHaveText('On')
  await expect(page.getByTestId('provider-status-codex')).toHaveText('Codex was not found on this computer', { timeout: 30000 })
})

cell('a fresh install, Codex only, with a supported Codex', 'codex', true, async ({ page, dataDir, steps, seen }) => {
  expect(steps).toContain('assistants:codex')
  // Found and supported, nobody signed in on this computer: ready to sign in.
  expect(seen.codexSetupState).toBe('sign-in')
  expect(steps.some((s) => /find Claude/i.test(s)), 'a Claude page showed for a Codex-only choice').toBe(false)
  await expect.poll(() => savedSettings(dataDir).codexEnabled, { timeout: 10000 }).toBe(true)
  expect(savedSettings(dataDir)).toMatchObject({ claudeEnabled: false, codexEnabled: true, codexAnswered: true })
  await openAccounts(page)
  await expect(page.getByTestId('provider-switch-text-claude')).toHaveText('Off')
  await expect(page.getByTestId('provider-status-codex')).toHaveText(`Codex ${FAKE_CODEX_VERSION} - ready`, { timeout: 30000 })
})
