/**
 * E2E: import a Claude desktop chat into a RUNNING session (#209), driven in the
 * REAL packaged app.
 *
 * This is the desktop-gate evidence for the feature. It drives the exact path a
 * human would take by hand — right-click a running Claude session ->
 * "Import Claude Desktop chat…" -> Paste -> generate brief -> write -> send — and
 * asserts the brief file actually lands in the session's working directory with
 * its provenance banner. Runs against an isolated temp data dir
 * (helpers/electron-app), so it never touches real user config.
 *
 * Boundaries (deliberately NOT covered here, and why):
 *   - "typed, NOT submitted": the injected prompt carries no trailing CR. That
 *     control-byte invariant is unit-tested (buildInjectPrompt in
 *     src/shared/desktop-import.ts) because xterm renders to a canvas with no DOM
 *     text to assert on.
 *   - Org-scoped share: needs a signed-in claude.ai account (#216). It cannot be
 *     scripted without credentials and stays a human check on the PR.
 *   - Public share FETCH: hits live claude.ai, so it is env-gated
 *     (CCC_E2E_SHARE_URL) rather than run in CI, where the network would flake it.
 *     The share TAB's wiring (guidance + bad-URL rejection) IS covered offline.
 *
 * The brief step tolerates either producer: in CI `claude` is absent, so
 * generateBrief falls back to the deterministic extract quickly; locally it may
 * attempt the headless `claude -p` pass first, so that step gets generous time.
 * Both producers prepend the same provenance banner, so the assertion is
 * mode-agnostic.
 */
import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'

let ctx: IsolatedApp
let page: IsolatedApp['page']
let workDir: string

const SESSION_NAME = 'E2E Import'
const BANNER_TEXT = 'Imported from a Claude desktop conversation'

// A tiny transcript with role markers and one fenced code block, so the capture
// summary is deterministic: 2 messages, 1 code block.
const PASTE = [
  'Human: We need a health check endpoint for the API.',
  '',
  'Claude: Add a GET /healthz that returns 200. For example:',
  '',
  '```ts',
  "app.get('/healthz', (_req, res) => res.sendStatus(200))",
  '```',
].join('\n')

test.beforeAll(async () => {
  test.setTimeout(120000)
  ctx = await launchIsolatedApp()
  page = ctx.page
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-e2e-import-'))
  await createRunningClaudeSession()
})

test.afterAll(async () => {
  // Tearing down with a live PTY session can exceed the 30s hook default.
  test.setTimeout(120000)
  // This session leaves a long-lived shell PTY as a CHILD of the Electron
  // process. Killing only the Electron pid orphans that child, whose inherited
  // stdio pipes stay open — Playwright then blocks on the process exit and the
  // worker teardown times out. Tree-kill the whole process group first, while it
  // is still intact, so nothing survives to hold a pipe.
  try {
    const pid = ctx?.app.process().pid
    if (pid) {
      if (process.platform === 'win32') {
        // stdio ignored: taskkill prints to stderr for any protected child it
        // cannot touch (e.g. conhost), which is harmless noise once the tree is
        // down — don't let it clutter the CI log.
        execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, timeout: 10000, stdio: 'ignore' })
      } else {
        try { process.kill(-pid, 'SIGKILL') } catch { process.kill(pid, 'SIGKILL') }
      }
    }
  } catch {
    /* already gone */
  }
  await closeIsolatedApp(ctx)
  try {
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* the spawned shell may still hold the dir open on Windows */
  }
})

/**
 * Create a Claude x Local session and launch it, so a real running session exists
 * to import INTO. The import menu item is gated on exactly this shape
 * (Sidebar.tsx: !shellOnly && local && provider === 'claude'); a terminal-only or
 * SSH session would never show it. The child `claude` process does not need to
 * thrive — the session ROW only has to exist to be right-clicked.
 */
async function createRunningClaudeSession(): Promise<void> {
  await page.locator('[data-tour="new-config"]').first().click()
  await expect(page.locator('text=New saved config')).toBeVisible({ timeout: 10000 })

  await page.locator('[role="radiogroup"][aria-label="Provider"] label:has(input[value="claude"])').click()
  await page.locator('[role="radiogroup"][aria-label="Where it runs"] label:has(input[value="local"])').click()

  // Claude x Local requires a working directory (peach *) and a name.
  await page.locator('input[placeholder*="path"]').first().fill(workDir)
  await page.locator('input[placeholder="e.g. App Dev"]').fill(SESSION_NAME)

  await page.locator('button:has-text("Create config")').click()
  // Creating from the sidebar launches the config immediately; the row shows the name.
  await expect(page.locator(`text=${SESSION_NAME}`).first()).toBeVisible({ timeout: 30000 })
}

/** Right-click the running session and open its "Import Claude Desktop chat…" dialog. */
async function openImportDialog(): Promise<void> {
  // A dialog left open by a previous step would swallow the right-click; close it.
  const cancel = page.locator('button:has-text("Cancel")').first()
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click().catch(() => {})
  }
  // Open the SESSION context menu by dispatching the DOM event directly on the
  // session card. Two things make a plain right-click wrong here: (1) the saved
  // CONFIG shares the session's name, so a name-based click can land on the
  // config row (a different menu); (2) the row div overlays its own label span,
  // so hit-testing refuses the click. `.session-card` is unique to session rows
  // (ConfigRow uses a different class), and dispatchEvent bubbles straight to the
  // row's React onContextMenu regardless of layering. The handler positions the
  // menu from e.clientX/Y (0,0 here) — fine, the items are still clickable.
  const sessionRow = page.locator('.session-card').filter({ hasText: SESSION_NAME }).first()
  await sessionRow.dispatchEvent('contextmenu')
  const item = page.locator('text=Import Claude Desktop chat')
  await expect(item).toBeVisible({ timeout: 10000 })
  await item.click()
  await expect(page.locator('text=Import a Claude desktop chat')).toBeVisible()
}

/**
 * Capture the current window as desktop-gate evidence. Writes the PNG to the
 * test's output dir (so it persists to disk under any reporter, not only the HTML
 * one) AND attaches it by path so it shows inline in the Playwright report.
 */
async function shot(name: string): Promise<void> {
  const file = test.info().outputPath(`${name}.png`)
  await page.screenshot({ path: file })
  await test.info().attach(name, { path: file, contentType: 'image/png' })
}

test('running session: right-click -> Import -> paste -> brief -> written -> send', async () => {
  // The brief step may spawn a headless `claude` before falling back locally.
  test.setTimeout(180000)

  await openImportDialog()
  await shot('01-dialog-open')

  // Paste tab is the default. Capture the transcript.
  await page.locator('textarea[placeholder*="Paste the conversation"]').fill(PASTE)
  await page.locator('button:has-text("Read the paste")').click()
  await expect(page.locator('text=/Captured 2 messages/')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('text=/1 code block/')).toBeVisible()
  await shot('02-captured')

  // Generate the brief (either producer; see file header).
  await page.locator('button:has-text("Generate the brief")').click()
  await expect(page.locator(`pre:has-text("${BANNER_TEXT}")`)).toBeVisible({ timeout: 150000 })
  await shot('03-brief')

  // Write it into the session's working directory.
  await page.locator('button:has-text("Use this brief")').click()
  await expect(page.locator('text=/Brief saved to/')).toBeVisible({ timeout: 15000 })
  await shot('04-saved')

  // The strong assertion: the brief file really landed under the session's
  // working dir, in .claude/imports, carrying the provenance banner.
  const importsDir = path.join(workDir, '.claude', 'imports')
  await expect
    .poll(() => (fs.existsSync(importsDir) ? fs.readdirSync(importsDir).filter((f) => f.endsWith('.md')) : []), {
      timeout: 10000,
      intervals: [500],
    })
    .not.toHaveLength(0)
  const files = fs.readdirSync(importsDir).filter((f) => f.endsWith('.md'))
  const briefBody = fs.readFileSync(path.join(importsDir, files[0]), 'utf8')
  expect(briefBody).toContain(BANNER_TEXT)

  // Send it: types the read-it prompt into the session (NOT submitted) and closes.
  await page.locator('button:has-text("Send to session")').click()
  await expect(page.locator('text=Import a Claude desktop chat')).toHaveCount(0)
})

test('share tab: renders guidance and rejects a non-share URL (offline)', async () => {
  await openImportDialog()
  await page.locator('button:has-text("Share link")').click()
  // The always-on line: a publicly shared link works straight away.
  await expect(page.locator('text=/publicly/i').first()).toBeVisible()

  // A URL that is not a claude.ai/share link is rejected at the boundary.
  await page.locator('input[placeholder*="claude.ai/share"]').fill('https://example.com/not-a-share')
  await page.locator('button:has-text("Fetch")').click()
  await expect(page.locator('[class*="text-red"]').first()).toBeVisible({ timeout: 15000 })

  await page.locator('button:has-text("Cancel")').click()
})

test('share tab: fetches a real public share when CCC_E2E_SHARE_URL is set', async () => {
  test.skip(
    !process.env.CCC_E2E_SHARE_URL,
    'set CCC_E2E_SHARE_URL to a public claude.ai/share/<uuid> link to exercise the live fetch',
  )
  test.setTimeout(120000)

  await openImportDialog()
  await page.locator('button:has-text("Share link")').click()
  await page.locator('input[placeholder*="claude.ai/share"]').fill(process.env.CCC_E2E_SHARE_URL!)
  await page.locator('button:has-text("Fetch")').click()
  await expect(page.locator('text=/Captured \\d+ message/')).toBeVisible({ timeout: 90000 })
  await shot('05-share-captured')

  await page.locator('button:has-text("Cancel")').click()
})
