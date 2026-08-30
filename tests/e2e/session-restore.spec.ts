/**
 * E2E: session-state DURABILITY + fail-open restore (#397), driven in the REAL
 * packaged app across TWO launches sharing one data dir.
 *
 * This is the desktop-gate evidence for #397. The feature's whole promise is that
 * an open session survives "no matter how the app closes" — including a hard crash,
 * not a graceful quit — and that a CORRUPT persisted session-state file never
 * wedges boot (it fails OPEN: recover from the .bak, else start clean). A single
 * launch cannot prove either; this spec launches, creates a session, HARD-KILLS the
 * process tree to simulate a crash, then RELAUNCHES against the same data dir and
 * asserts what came back.
 *
 * Why a Terminal x Local session: it needs no real `claude` binary (absent in CI),
 * yet it is a first-class persisted session (shellOnly, provider 'claude') that the
 * autosave writes to session-state.json exactly like any other — so the durability
 * path under test is the real one, with no external dependency to flake.
 *
 * The isolated-app helper (helpers/electron-app) mkdtemps a FRESH data dir per
 * launch and rm's it on close, which is wrong for a two-launch test. So launch #1
 * uses the helper only to SEED + boot (it hands back its dataDir), and every
 * relaunch here re-launches Electron directly against that SAME dataDir with its own
 * --user-data-dir (a killed instance's single-instance lock lives in the userdata
 * dir, so a fresh one per relaunch sidesteps it). The dataDir is rm'd once, in
 * afterAll — never by closeIsolatedApp.
 *
 * Boundaries (NOT covered here, and why):
 *   - The per-field fail-open repair of a restored SPAWN (invalid resume uuid /
 *     codex preset) is unit-tested (sanitize-restored-spawn-options.test.ts): it is
 *     pure argv-construction logic with no DOM surface, and exercising it E2E would
 *     need a real resumable Claude conversation on disk.
 *   - The read-failure latch (EBUSY/EACCES makes a load a non-absence) is unit-
 *     tested (session-state-read-failure.test.ts): reliably holding a file
 *     unreadable mid-launch is not scriptable cross-platform.
 */
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchIsolatedApp, IsolatedApp } from './helpers/electron-app'

const APP_PATH = path.resolve(__dirname, '../../out/main/index.js')
const SESSION_NAME = 'E2E Restore'

let seeded: IsolatedApp
let dataDir: string
let workDir: string
let stateFile: string
let bakFile: string
let configDir: string

// Live app under test at any given moment (so teardown can always kill it).
let live: { app: ElectronApplication; page: Page } | null = null

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(120000)
  // Launch #1 via the helper: seeds past the boot gates and hands back its dataDir.
  seeded = await launchIsolatedApp()
  live = { app: seeded.app, page: seeded.page }
  dataDir = seeded.dataDir
  configDir = path.join(dataDir, 'resources', 'CONFIG')
  stateFile = path.join(configDir, 'session-state.json')
  bakFile = `${stateFile}.bak`
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-e2e-restore-work-'))

  await createTerminalSession(seeded.page)

  // The autosave debounces ~1s after a session is added, then writes
  // session-state.json (+ a .bak mirror). Wait for BOTH to hit disk — that on-disk
  // file is the entire thing a crash must not lose.
  await expect
    .poll(() => (fs.existsSync(stateFile) && fs.existsSync(bakFile) ? readState(stateFile)?.sessions?.length ?? 0 : 0), {
      timeout: 20000,
      intervals: [250],
    })
    .toBeGreaterThan(0)

  // Prove the persisted record carries the identity we will assert on restore.
  const saved = readState(stateFile)!
  const row = saved.sessions.find((s) => s.label === SESSION_NAME)
  expect(row, 'the created session was not persisted to session-state.json').toBeTruthy()
  expect(row!.workingDirectory).toBe(workDir)

  // HARD crash: tree-kill launch #1. NOT a graceful app.close() — the point of #397
  // is durability across a non-graceful death. The debounced autosave already
  // flushed above, so nothing is lost by killing now.
  hardKill(live.app)
  live = null
})

test.afterAll(async () => {
  test.setTimeout(60000)
  if (live) {
    hardKill(live.app)
    live = null
  }
  // Remove ONLY the unique dirs we created.
  for (const d of [dataDir, workDir]) {
    try {
      if (d) fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* a spawned shell may still hold a handle on Windows */
    }
  }
})

test('restores a session after a HARD crash (relaunch, same data dir)', async () => {
  test.setTimeout(90000)
  const { page } = await launchAppAt('relaunch-1')

  // The restore surfaces as the "Resume previous sessions?" card, listing the saved
  // session by name — proof the crashed session's record was read back on boot.
  const prompt = page.getByRole('dialog', { name: /Resume previous sessions/i })
  await expect(prompt).toBeVisible({ timeout: 20000 })
  await expect(prompt.getByText(SESSION_NAME, { exact: false })).toBeVisible()
  await shot(page, '01-resume-prompt-after-crash')

  // Accept the restore: the session card comes back with the same name. Session
  // rows render only inside the RUNNING tabpanel of the two-mode panel (the
  // unselected tabpanel is unmounted), so select it before asserting.
  await prompt.getByRole('button', { name: 'Resume' }).click()
  await page.locator('[data-testid="panel-tab-running"]').click()
  await expect(page.locator('.session-card').filter({ hasText: SESSION_NAME }).first()).toBeVisible({ timeout: 30000 })
  await shot(page, '02-session-restored')

  hardKill(live!.app)
  live = null
})

test('fail-open: a CORRUPT session-state.json recovers from the .bak, never wedges', async () => {
  test.setTimeout(90000)

  // Corrupt ONLY the primary; leave the .bak (the last known-good mirror) intact.
  fs.writeFileSync(stateFile, '{ "sessions": [ this is deliberately not valid JSON', 'utf-8')
  expect(fs.existsSync(bakFile), 'precondition: the .bak mirror should exist from launch #1').toBe(true)

  const { page } = await launchAppAt('relaunch-corrupt-bak')

  // 1) It BOOTED — the main shell rendered (new-config present), so a corrupt file
  //    did not wedge startup.
  await expect(page.locator('[data-tour="new-config"]').first()).toBeVisible({ timeout: 20000 })

  // 2) It RECOVERED the last-good set from the .bak: the Resume card lists the
  //    session that was only in the (now-corrupt) primary.
  const prompt = page.getByRole('dialog', { name: /Resume previous sessions/i })
  await expect(prompt).toBeVisible({ timeout: 20000 })
  await expect(prompt.getByText(SESSION_NAME, { exact: false })).toBeVisible()
  await shot(page, '03-recovered-from-bak')

  // 3) The unparseable primary was moved aside (never silently destroyed).
  const asideExists = fs
    .readdirSync(configDir)
    .some((f) => f.startsWith('session-state.json.corrupt-'))
  expect(asideExists, 'the corrupt primary should have been moved aside to *.corrupt-*').toBe(true)

  hardKill(live!.app)
  live = null
})

test('fail-open: a CORRUPT primary with NO usable .bak boots clean (no wedge, no phantom)', async () => {
  test.setTimeout(90000)

  // Corrupt the primary AND remove the .bak, so there is nothing to recover.
  fs.writeFileSync(stateFile, 'not json at all }{', 'utf-8')
  try {
    if (fs.existsSync(bakFile)) fs.unlinkSync(bakFile)
  } catch {
    /* ignore */
  }

  const { page } = await launchAppAt('relaunch-corrupt-nobak')

  // Booted to the main shell...
  await expect(page.locator('[data-tour="new-config"]').first()).toBeVisible({ timeout: 20000 })
  // ...and offered NO resume (nothing recoverable => clean start, not a wedge and
  // not a phantom prompt). Give the async session.load time to have fired first.
  await page.waitForTimeout(3000)
  await expect(page.getByRole('dialog', { name: /Resume previous sessions/i })).toHaveCount(0)
  await shot(page, '04-clean-start-no-bak')

  hardKill(live!.app)
  live = null
})

// ─────────────────────────────────────────────────────────────── helpers

/** Create + launch a Terminal x Local session named SESSION_NAME in workDir. */
async function createTerminalSession(page: Page): Promise<void> {
  // Two-mode panel: open the Saved tab first (the panel defaults to Running),
  // then the central "+ New" button's Config option (#483).
  await page.locator('[data-testid="panel-tab-saved"]').click()
  await page.locator('[data-testid="new-button"]').click()
  await page.locator('[data-testid="new-menu-config"]').click()
  await expect(page.locator('text=New saved config')).toBeVisible({ timeout: 10000 })

  await page
    .locator('[role="radiogroup"][aria-label="Provider"] label:has(input[value="terminal"])')
    .click()
  await page
    .locator('[role="radiogroup"][aria-label="Where it runs"] label:has(input[value="local"])')
    .click()

  // Working directory is optional for a terminal config; fill it so we can assert
  // it round-trips through persist -> crash -> restore.
  await page.locator('input[placeholder*="home folder"]').first().fill(workDir)
  await page.locator('input[placeholder="e.g. App Dev"]').fill(SESSION_NAME)

  await page.locator('button:has-text("Create config")').click()
  // Creating from the sidebar launches the config immediately (App.onConfirm ->
  // launchConfig), so a real running session row appears — in the RUNNING
  // tabpanel. Creation leaves the panel on the Saved tab (the config row's
  // running-count badge, not a tab switch, is the affordance there) and the
  // unselected tabpanel is unmounted, so switch tabs before asserting the row.
  await page.locator('[data-testid="panel-tab-running"]').click()
  await expect(page.locator('.session-card').filter({ hasText: SESSION_NAME }).first()).toBeVisible({
    timeout: 30000,
  })
}

/**
 * Launch the packaged app directly against the SHARED dataDir (mirrors
 * helpers/electron-app's launch env), with a per-launch --user-data-dir so a prior
 * killed instance's single-instance lock does not collide. Waits until the main
 * shell has hydrated.
 */
async function launchAppAt(tag: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [APP_PATH, `--user-data-dir=${path.join(dataDir, `electron-userdata-${tag}`)}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      E2E_HEADLESS: '1',
      CCC_E2E_DATA_DIR: dataDir,
      CCC_FORCE_SPLASH: '0',
    },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('[data-tour="new-config"]', { timeout: 20000 })
  live = { app, page }
  return { app, page }
}

/** Tree-kill the whole Electron process group — simulates a crash, and leaves no
 *  orphan PTY child holding an inherited pipe open (which hangs worker teardown). */
function hardKill(app: ElectronApplication): void {
  try {
    const pid = app.process().pid
    if (!pid) return
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, timeout: 10000, stdio: 'ignore' })
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        process.kill(pid, 'SIGKILL')
      }
    }
  } catch {
    /* already gone */
  }
}

/** Read + parse a session-state file, tolerating an absent/garbage file. */
function readState(file: string): { sessions: Array<{ label: string; workingDirectory: string }> } | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

/** Capture desktop-gate evidence: write the PNG to the test output dir (persists
 *  under any reporter) AND attach it by path (shows inline in the report). */
async function shot(page: Page, name: string): Promise<void> {
  const file = test.info().outputPath(`${name}.png`)
  await page.screenshot({ path: file })
  await test.info().attach(name, { path: file, contentType: 'image/png' })
}
