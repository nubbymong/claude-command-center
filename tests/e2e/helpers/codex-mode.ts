/**
 * What the Codex mode-matrix specs share (P4.9, row 67; WP1.60): seeding an
 * isolated data dir with Codex on and one managed Codex account, the fake
 * Codex's record of the sessions it was started as, creating a Codex config
 * the way a user does, reading the active terminal's text, the Codex switch
 * in Settings, Accounts, and relaunching the app against the same data dir.
 *
 * VM ONLY, like every e2e helper: the specs that use it launch the Electron
 * app. Nothing here reads or writes the runner's own ~/.codex or ~/.claude:
 * the account's folder and the instance's home are inside the spec's data dir
 * (helpers/electron-app.ts, helpers/isolated-env.ts).
 */
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import {
  emptyRegistry, createIdentity, beginAccountSetup, commitAccountSetup, checkRegistryInvariants, parseRegistryDoc,
} from '../../../src/shared/providers'
import type { ProviderRegistryDoc, RegistryResult } from '../../../src/shared/providers'
import { installFakeCodex, signInFakeRealm } from './fake-codex'
import { isolatedLaunchEnv } from './isolated-env'

const APP_PATH = path.resolve(__dirname, '../../../out/main/index.js')
const IS_WIN = process.platform === 'win32'

/** The seeded account: opaque ids (prefix + lowercase hex, as the app makes). */
export const CODEX_ACCOUNT = {
  identityId: 'idn-e2e0c0de0000000000000067',
  accountId: 'acct-e2e0c0de0000000000000067',
  realmId: 'realm-e2e0c0de0000000000000067',
  name: 'E2E Codex',
} as const

/** The account's own Codex folder, where the app keeps it (realm-paths.ts). */
export const realmDirOf = (dataDir: string): string => path.join(dataDir, 'resources', 'codex-realms', CODEX_ACCOUNT.realmId)
/** Where a spec's fake Codex lives (and where it records its sessions). */
export const fakeDirOf = (dataDir: string): string => path.join(dataDir, 'fake-codex')

function ok(r: RegistryResult, step: string): ProviderRegistryDoc {
  if (!r.ok) throw new Error(`seeding the Codex account failed at ${step}: ${r.code}: ${r.message}`)
  return r.doc
}

export interface CodexSeedOptions {
  /** Install the fake Codex in fakeDirOf(dataDir) and sign the account's
   *  folder in as far as it can tell. Off for a real-CLI spec. */
  fake?: boolean
  /** Draw terminals with xterm's DOM renderer (GPU rendering off), so a spec
   *  can read what a tab shows ([data-terminal-active] .xterm-rows). */
  domTerminal?: boolean
  /** How the account signed in, as the registry records it. */
  method?: 'apiKey' | 'browser'
}

/**
 * Codex on and answered (owner decision 2026-09-26: a saved on/off without
 * the answer is ignored), Hello Codex already seen (its one-time takeover
 * would cover the window), and one managed Codex account in the registry,
 * written with the app's own registry transitions (src/shared/providers), as
 * codex-session-creation.spec.ts seeds it. For launchIsolatedApp's seedExtra,
 * after its clean seed.
 */
export function seedCodexAccount(dataDir: string, opts: CodexSeedOptions = {}): void {
  const resources = path.join(dataDir, 'resources')
  const config = path.join(resources, 'CONFIG')

  const settingsFile = path.join(config, 'settings.json')
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  fs.writeFileSync(settingsFile, JSON.stringify({
    ...settings,
    codexEnabled: true,
    codexAnswered: true,
    // gpuDefaultOnMigrated: the one-time move to GPU rendering has run, so the
    // saved false stands (settingsStore.ts migrateGpuDefaultOn).
    ...(opts.domTerminal ? { terminal: { ...(settings.terminal ?? {}), gpuRendering: false }, gpuDefaultOnMigrated: true } : {}),
  }, null, 2))

  const metaFile = path.join(config, 'app-meta.json')
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, helloCodexSeenVersion: meta.setupVersion ?? 'seen' }, null, 2))

  const method = opts.method ?? 'apiKey'
  let doc = emptyRegistry()
  doc = ok(createIdentity(doc, { id: CODEX_ACCOUNT.identityId, friendlyName: CODEX_ACCOUNT.name, colourKey: 'indigo' }, 1), 'createIdentity')
  doc = ok(beginAccountSetup(doc, {
    accountId: CODEX_ACCOUNT.accountId, realmId: CODEX_ACCOUNT.realmId, providerId: 'codex', method,
    realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${CODEX_ACCOUNT.realmId}`,
  }, 2), 'beginAccountSetup')
  doc = ok(commitAccountSetup(doc, CODEX_ACCOUNT.accountId, {
    identityId: CODEX_ACCOUNT.identityId, authMethod: method, lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted',
  }, 3), 'commitAccountSetup')
  const problems = checkRegistryInvariants(doc)
  if (problems.length) throw new Error(`the seeded registry breaks its invariants: ${problems.join('; ')}`)
  const text = JSON.stringify(doc, null, 2)
  const parsed = parseRegistryDoc(JSON.parse(text))
  if (!parsed.ok) throw new Error(`the seeded registry does not parse back: ${JSON.stringify(parsed)}`)
  fs.mkdirSync(path.join(resources, 'providers'), { recursive: true })
  fs.writeFileSync(path.join(resources, 'providers', 'registry.json'), text)
  fs.mkdirSync(realmDirOf(dataDir), { recursive: true })
  if (opts.fake !== false) {
    signInFakeRealm(realmDirOf(dataDir))
    installFakeCodex(fakeDirOf(dataDir))
  }
}

/** One session the fake Codex was started as (helpers/fake-codex.ts). */
export interface FakeLaunch { argv: string[]; codexHome: string | null; cwd: string; pid: number; tty: boolean; at: number }

/** Every session the fake Codex in `fakeDir` was started as, oldest first. */
export function fakeCodexLaunches(fakeDir: string): FakeLaunch[] {
  let text = ''
  try { text = fs.readFileSync(path.join(fakeDir, 'launches.jsonl'), 'utf8') } catch { return [] }
  const out: FakeLaunch[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as FakeLaunch) } catch { /* a line still being written: read again */ }
  }
  return out
}

/** The value after `flag` in a launch's argv. */
export const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

/** Two paths name the same folder (canonical, and case-blind on Windows). */
export function sameFolder(a: string | null | undefined, b: string): boolean {
  if (!a) return false
  const canon = (p: string) => {
    let c = p
    try { c = fs.realpathSync.native(p) } catch { /* compare as given */ }
    c = path.resolve(c)
    return IS_WIN ? c.toLowerCase() : c
  }
  return canon(a) === canon(b)
}

/** Whether a process is still running. */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

const dialog = (page: Page) => page.locator('[data-testid="session-dialog"]')
const providerCard = (page: Page, v: string) => page.locator(`[role="radiogroup"][aria-label="Provider"] label:has(input[value="${v}"])`)
const transportCard = (page: Page, v: string) => page.locator(`[role="radiogroup"][aria-label="Connection"] label:has(input[value="${v}"])`)

/**
 * Create a Codex config on this computer, bound to the seeded account, the
 * way a user does (the sidebar's Saved tab, "+ New", Config: New saved
 * config), as codex-session-creation.spec.ts drives it. Creating a config
 * also launches it.
 */
export async function createCodexConfig(page: Page, o: { label: string; dir: string }): Promise<void> {
  await page.locator('[data-testid="panel-tab-saved"]').click()
  await page.locator('[data-testid="new-button"]').click()
  await page.locator('[data-testid="new-menu-config"]').click()
  await expect(dialog(page), 'New saved config did not open').toBeVisible({ timeout: 10000 })
  await providerCard(page, 'codex').click()
  await transportCard(page, 'local').click()
  const picker = page.locator('[data-testid="codex-account-select"]')
  await expect(picker, 'no "Codex account" picker: the Accounts snapshot has not reached the dialog').toBeVisible({ timeout: 15000 })
  await expect(picker).toHaveValue(CODEX_ACCOUNT.accountId)
  await page.locator('input[placeholder*="path"]').first().fill(o.dir)
  await page.locator('input[placeholder="e.g. App Dev"]').fill(o.label)
  await expect(page.locator('[data-testid="session-dialog-validation"]'), 'Create config is held back').toHaveText('')
  await page.locator('[data-testid="session-dialog-submit"]').click()
  await expect(dialog(page)).toHaveCount(0, { timeout: 15000 })
}

/** Bring a session's tab to the front from the sidebar's Running tab. */
export async function openSession(page: Page, label: string): Promise<void> {
  await page.locator('[data-testid="panel-tab-running"]').click()
  const card = page.locator('.session-card').filter({ hasText: label }).first()
  await expect(card, `no session card for ${label} in the Running tab`).toBeVisible({ timeout: 30000 })
  await card.click()
  await expect(page.locator('[data-terminal-active]')).toHaveCount(1, { timeout: 10000 })
}

/** The session id of the terminal on screen. */
export async function activeSessionId(page: Page): Promise<string> {
  const id = await page.locator('[data-terminal-active]').getAttribute('data-terminal-session')
  if (!id) throw new Error('the active terminal names no session')
  return id
}

/** What the terminal on screen shows, row by row (needs the DOM renderer:
 *  seedCodexAccount's domTerminal). */
export async function terminalRows(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('[data-terminal-active] .xterm-rows > div'))
    .map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' ')))
}

/** The terminal on screen as one text (rows joined; a wrapped line joins too). */
export async function terminalText(page: Page): Promise<string> {
  return (await terminalRows(page)).map((r) => r.replace(/\s+$/, '')).join('\n')
}

/** Type into a session as its terminal would. */
export async function ptyWrite(page: Page, sessionId: string, data: string): Promise<void> {
  await page.evaluate(([id, d]) => {
    const api = (window as unknown as { electronAPI: { pty: { write: (id: string, data: string) => void } } }).electronAPI
    api.pty.write(id, d)
  }, [sessionId, data] as const)
}

/** Restart the tab on screen with the header's Restart, Restart (a fresh
 *  start, no conversation picker). */
export async function restartFresh(page: Page): Promise<void> {
  const button = page.locator('[data-testid="codex-restart"]').filter({ visible: true })
  await expect(button, 'the tab header has no Restart (codex-restart)').toHaveCount(1, { timeout: 10000 })
  await button.click()
  await expect(page.locator('[data-testid="codex-restart-menu"]')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="codex-restart-fresh"]').click()
}

/** Settings, Accounts, and its Codex row. */
export async function openAccounts(page: Page): Promise<void> {
  await page.locator('aside [data-tour="nav-settings"]').click()
  await expect(page.locator('[data-testid="page-tab"][data-page="settings"][aria-current="page"]')).toBeVisible({ timeout: 5000 })
  await page.getByRole('navigation').getByRole('button', { name: 'Accounts', exact: true }).click()
  await expect(page.locator('[data-testid="provider-row-codex"]')).toBeVisible({ timeout: 5000 })
}

/** Turn Codex on or off with its switch in Settings, Accounts (open). */
export async function flipCodex(page: Page, to: 'on' | 'off'): Promise<void> {
  const row = page.locator('[data-testid="provider-row-codex"]')
  await row.getByRole('switch', { name: to === 'off' ? 'Turn Codex off' : 'Turn Codex on' }).click()
}

/** The Codex switch's own words: On, Off or Not set up. */
export const codexSwitchText = (page: Page) => page.locator('[data-testid="provider-switch-text-codex"]')

/** The saved settings the app wrote. */
export function savedSettings(dataDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'resources', 'CONFIG', 'settings.json'), 'utf8'))
}

/** The sessions the app saved for its next start (session-persistence.ts). */
export function savedSessions(dataDir: string): Array<Record<string, unknown>> {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, 'resources', 'CONFIG', 'session-state.json'), 'utf8'))
    return Array.isArray(doc?.sessions) ? doc.sessions : []
  } catch {
    return [] // not written yet, or a torn read mid-write: poll again
  }
}

/** Launch the app against an existing data dir (a relaunch), with a fresh
 *  Electron user-data dir so the killed instance's single-instance lock does
 *  not collide (session-restore.spec.ts). Waits for the main shell. */
export async function relaunchAt(dataDir: string, tag: string, env: Record<string, string | undefined>): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [APP_PATH, `--user-data-dir=${path.join(dataDir, `electron-userdata-${tag}`)}`],
    env: isolatedLaunchEnv(dataDir, env),
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('[data-tour="new-config"]', { timeout: 20000 })
  return { app, page }
}

/** Tree-kill the app (a crash, not a quit): its PTY children go with it. */
export function hardKill(app: ElectronApplication | undefined): void {
  if (!app) return
  let pid: number | undefined
  try { pid = app.process().pid } catch { return }
  if (!pid) return
  try {
    if (IS_WIN) execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000, windowsHide: true })
    else {
      try { process.kill(-pid, 'SIGKILL') } catch { process.kill(pid, 'SIGKILL') }
    }
  } catch { /* already gone */ }
}
