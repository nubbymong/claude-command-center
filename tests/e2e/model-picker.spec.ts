/**
 * E2E: the versioned model picker (#385), driven in the REAL packaged app.
 *
 * Before #385 the "Starting model" picker offered only family ALIASES (opus,
 * sonnet, …); a user could not pin an exact release, and a stored versioned id
 * had no row to show as selected. This proves the fix end-to-end:
 *   1. a PINNED versioned row ("Opus 4.6" -> claude-opus-4-6) appears under its
 *      family <optgroup> in the dialog's model picker and is selectable, and
 *   2. the chosen id round-trips UNCHANGED into the persisted config on disk
 *      (configs.json in the isolated data dir) — no alias flattening.
 *
 * Runs against an isolated temp data dir (helpers/electron-app) so it never
 * touches real user config. Screenshot evidence is attached by PATH (the `list`
 * reporter drops body attachments — see AGENTS.md, driving the desktop gate).
 */
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'

let ctx: IsolatedApp
let page: IsolatedApp['page']

test.beforeAll(async () => {
  ctx = await launchIsolatedApp()
  page = ctx.page
})

test.afterAll(async () => {
  // Creating a Claude config launches it, leaving a live shell/agent PTY as an
  // Electron child. On Windows app.close()/process().kill() does NOT reap that
  // subtree, and the orphan's inherited pipes hang Playwright's worker teardown
  // (AGENTS.md: tree-kill with taskkill /pid <electron> /T /F, stdio ignored).
  test.setTimeout(120000)
  const pid = ctx?.app.process().pid
  if (pid && process.platform === 'win32') {
    try {
      const { execFileSync } = await import('child_process')
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
  }
  await closeIsolatedApp(ctx)
})

// Attach a screenshot as persistent evidence. Write to the test's outputPath and
// attach by PATH — a `body` attach is silently dropped by the `list` reporter.
async function shot(name: string) {
  const file = test.info().outputPath(name)
  await page.screenshot({ path: file })
  await test.info().attach(name, { path: file, contentType: 'image/png' })
}

// Same visually-hidden-radio-in-a-label pattern the permutations spec drives:
// click the CARD (the <label>), assert on the <input>.
const providerCard = (v: string) =>
  page.locator(`[role="radiogroup"][aria-label="Provider"] label:has(input[value="${v}"])`)
const transportCard = (v: string) =>
  page.locator(`[role="radiogroup"][aria-label="Where it runs"] label:has(input[value="${v}"])`)

// One shared app instance: a previously-open dialog would block the sidebar
// button, so close it via Cancel first (Escape does not close this dialog).
async function openDialog() {
  const cancel = page.locator('button:has-text("Cancel")').first()
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click()
    await expect(page.locator('text=New saved config')).toHaveCount(0)
  }
  // Two-mode panel: open the Saved tab first (the panel defaults to Running),
  // then the central "+ New" button's Config option (#483).
  await page.locator('[data-testid="panel-tab-saved"]').click()
  await page.locator('[data-testid="new-button"]').click()
  await page.locator('[data-testid="new-menu-config"]').click()
  await expect(page.locator('text=New saved config')).toBeVisible({ timeout: 10000 })
}

test.describe('Model picker — versioned ids (#385)', () => {
  test('a pinned versioned row is selectable and round-trips into the persisted config', async () => {
    // A real config create launches the config (spawns a PTY) — needs headroom.
    test.setTimeout(120000)

    await openDialog()
    await providerCard('claude').click()
    await transportCard('local').click()
    await expect(page.locator('text=Starting model')).toBeVisible()

    // The dialog's model control is the native <select> under "Starting model".
    // Several <select>s exist (model, permission mode, group, section); the one
    // offering the pinned id is unambiguously the model picker.
    const modelSelect = page
      .locator('select')
      .filter({ has: page.locator('option[value="claude-opus-4-6"]') })
      .first()
    await expect(modelSelect).toHaveCount(1)

    // The PINNED versioned row is present, sits under a family <optgroup>, and
    // carries the EXACT versioned id as its value (not a flattened alias) — this
    // is the row #385 added. modelGroupsFromRegistry renders each family's pins
    // in their own <optgroup>, so this asserts the versioned id actually appears.
    await expect(modelSelect.locator('optgroup option[value="claude-opus-4-6"]')).toHaveCount(1)
    await expect(modelSelect.locator('option[value="claude-opus-4-6"]')).toHaveText('Opus 4.6')

    // Selectable: choosing it sticks.
    await modelSelect.selectOption('claude-opus-4-6')
    await expect(modelSelect).toHaveValue('claude-opus-4-6')

    // Fill the remaining required fields (Claude × Local needs an absolute
    // working directory and a label). The isolated data dir is an absolute path.
    await page.locator('input[placeholder*="path"]').first().fill(ctx.dataDir)
    await page.locator('input[placeholder="e.g. App Dev"]').fill('E2E Opus46')

    await shot('model-picker-opus46-selected.png')

    await page.locator('button:has-text("Create config")').click()
    // The config appears in the sidebar once created.
    await expect(page.locator('text=E2E Opus46').first()).toBeVisible({ timeout: 30000 })

    // The chosen id round-trips UNCHANGED into the persisted config on disk.
    const configsPath = path.join(ctx.dataDir, 'resources', 'CONFIG', 'configs.json')
    await expect
      .poll(
        () => {
          if (!fs.existsSync(configsPath)) return null
          try {
            const list = JSON.parse(fs.readFileSync(configsPath, 'utf8')) as Array<{
              label?: string
              claudeOptions?: { model?: string }
            }>
            const c = list.find((x) => x.label === 'E2E Opus46')
            return c?.claudeOptions?.model ?? null
          } catch {
            return null // a torn read mid-write: poll again
          }
        },
        { timeout: 30000, intervals: [500] },
      )
      .toBe('claude-opus-4-6')
  })
})
