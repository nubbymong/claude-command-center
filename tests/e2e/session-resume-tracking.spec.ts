/**
 * E2E (#480): durable, cross-safe session->conversation tracking, validated in the
 * REAL packaged app.
 *
 * Scope — what e2e can honestly assert here:
 *   1. The new `session_conversation` durable table ships and is created when the
 *      packaged app opens transcripts.db at startup (the DDL runs for real, not
 *      only under the unit `openTranscriptsDb`).
 *   2. The Restart action — the exact user gesture that used to resume the wrong
 *      conversation — runs end-to-end in the app without crashing, and the session
 *      returns healthy.
 *
 * NOT here (covered by unit + native suites, which need no real `claude`):
 *   - The exact-only resume / ownership-guard / eviction LOGIC. Proving a real
 *     cross would require two live `claude` conversations writing transcripts and
 *     firing authenticated hooks — absent in CI. That correctness lives in
 *     transcript-binder-ownership / transcripts-db.native / resume-ipc-handlers.
 *
 * better-sqlite3 is built for Electron's ABI and cannot be required from the
 * plain-node Playwright runner, so the schema check scans the DB file bytes for
 * the table's CREATE SQL — SQLite stores it as plaintext in sqlite_master.
 */
import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'

const SESSION_NAME = 'E2E Resume 480'

async function shot(page: import('@playwright/test').Page, name: string): Promise<void> {
  const file = test.info().outputPath(`${name}.png`)
  await page.screenshot({ path: file })
  await test.info().attach(name, { path: file, contentType: 'image/png' })
}

/** True if any of the sqlite files (main + WAL) contains the given ASCII needle. */
function dbFilesContain(dataDir: string, needle: string): boolean {
  const base = path.join(dataDir, 'transcripts.db')
  for (const f of [base, `${base}-wal`, `${base}-shm`]) {
    try {
      if (fs.existsSync(f) && fs.readFileSync(f).includes(Buffer.from(needle, 'ascii'))) return true
    } catch {
      /* ignore unreadable / locked */
    }
  }
  return false
}

test.describe('#480 durable session-conversation tracking (packaged app)', () => {
  test.describe.configure({ mode: 'serial' })

  test('the app ships and creates the session_conversation durable table', async () => {
    test.setTimeout(90000)
    let a: IsolatedApp | undefined
    try {
      a = await launchIsolatedApp()
      // The logging worker opens transcripts.db at startup and runs the DDL.
      await expect
        .poll(() => fs.existsSync(path.join(a!.dataDir, 'transcripts.db')), { timeout: 30000, intervals: [300] })
        .toBe(true)
      // The #480 table's CREATE SQL is stored as plaintext in sqlite_master.
      await expect
        .poll(() => dbFilesContain(a!.dataDir, 'session_conversation'), { timeout: 30000, intervals: [300] })
        .toBe(true)
      await shot(a.page, '480-01-app-booted')
    } finally {
      await closeIsolatedApp(a)
    }
  })

  test('Restart on a live session returns it healthy (no crash)', async () => {
    test.setTimeout(120000)
    let a: IsolatedApp | undefined
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-e2e-480-work-'))
    try {
      a = await launchIsolatedApp()
      const page = a.page

      // Create a Terminal x Local session (no real `claude` binary needed).
      await page.locator('[data-testid="panel-tab-saved"]').click()
      await page.locator('[data-testid="new-config-button"]').click()
      await expect(page.locator('text=New saved config')).toBeVisible({ timeout: 10000 })
      await page.locator('[role="radiogroup"][aria-label="Provider"] label:has(input[value="terminal"])').click()
      await page.locator('[role="radiogroup"][aria-label="Where it runs"] label:has(input[value="local"])').click()
      await page.locator('input[placeholder*="home folder"]').first().fill(workDir)
      await page.locator('input[placeholder="e.g. App Dev"]').fill(SESSION_NAME)
      await page.locator('button:has-text("Create config")').click()

      const card = page.locator('.session-card').filter({ hasText: SESSION_NAME }).first()
      await expect(card).toBeVisible({ timeout: 30000 })
      await shot(page, '480-02-session-created')

      // Click Restart (the gesture that used to resume the wrong conversation).
      const restart = page.locator('button[title="Restart session"]').first()
      await expect(restart).toBeVisible({ timeout: 15000 })
      await restart.click()

      // The session card returns and the shell stays healthy (no crash / blank).
      await expect(card).toBeVisible({ timeout: 30000 })
      await expect(page.locator('[data-tour="new-config"]').first()).toBeVisible()
      await shot(page, '480-03-after-restart')
    } finally {
      await closeIsolatedApp(a)
      try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})
