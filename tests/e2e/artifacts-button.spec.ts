/**
 * E2E (#501): the Artifacts core tool ships in the real packaged app.
 *
 * The command-bar button itself only shows for a local, non-shell session that
 * resolves to an account profile — a state the isolated e2e harness (no accounts,
 * no real `claude`) cannot reach, and one the unit test
 * (commandbar-artifacts-button.test.tsx) covers deterministically. What e2e CAN
 * prove here, without a session or account, is that the new core tool is
 * registered and surfaces in the app's UI: Settings → Custom Commands → Core
 * tools lists one row per CORE_TOOL_ID, so an "Artifacts" row appearing there is
 * proof the tool shipped and integrated (alongside the existing Browser row).
 */
import { test, expect } from '@playwright/test'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'

let ctx: IsolatedApp
let page: IsolatedApp['page']

test.beforeAll(async () => {
  test.setTimeout(90000)
  ctx = await launchIsolatedApp()
  page = ctx.page
})

test.afterAll(async () => {
  // closeIsolatedApp's worst case (5s graceful race + taskkill + rm retries)
  // can exceed the 30s default hook budget on a loaded VM — give it headroom.
  test.setTimeout(120000)
  await closeIsolatedApp(ctx)
})

test.describe('#501 Artifacts core tool (packaged app)', () => {
  test('appears in Settings → Custom Commands → Core tools, beside Browser', async () => {
    test.setTimeout(60000)
    // Open Settings from the nav rail. The data-tour anchor is the
    // src-sanctioned stable selector (nav aria-labels are dynamic by design);
    // once Settings opens it exists as a page TAB whose accessible name is
    // also exactly "Settings", so the bare role+name lookup goes ambiguous
    // on any later pass. Then wait for the tab to be ACTIVE, not a fixed 400ms.
    await page.locator('aside [data-tour="nav-settings"]').click()
    await expect(
      page.locator('[data-testid="page-tab"][data-page="settings"][aria-current="page"]'),
    ).toBeVisible({ timeout: 5000 })

    // Switch to the Custom Commands tab.
    await page.getByRole('button', { name: 'Custom Commands' }).click()
    await expect(page.locator('[data-testid="custom-commands-tab"]')).toBeVisible({ timeout: 10000 })

    // Non-vacuous: an existing core tool row is present...
    await expect(page.locator('[data-testid="settings-core-browser"]')).toBeVisible()
    // ...and the new Artifacts row shipped alongside it.
    const artifacts = page.locator('[data-testid="settings-core-artifacts"]')
    await expect(artifacts).toBeVisible()
    await expect(artifacts).toHaveText(/Artifacts/i)

    await page.screenshot({ path: test.info().outputPath('501-artifacts-core-tool.png') })
    await test.info().attach('501-artifacts-core-tool', { path: test.info().outputPath('501-artifacts-core-tool.png'), contentType: 'image/png' })
  })
})
