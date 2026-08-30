/**
 * E2E for the GitHub sidebar OAuth device-flow UI.
 *
 * What this covers:
 *   - Settings → GitHub tab renders without crashing
 *   - "Sign in with GitHub / Add account" entry point is present
 *   - AccountsSection shows the empty-state when no profiles exist
 *
 * What this intentionally does NOT cover:
 *   - Hitting real api.github.com — E2E must not depend on the network
 *   - The full device-flow poll loop — that requires ipcMain stubs (the
 *     OAuth start IPC has side effects that are impractical to mock in a
 *     launched Electron app). OAuth end-to-end validation stays in manual
 *     QA + the unit tests around OAuthDeviceFlow.
 *
 * Runs against an isolated temp data dir (helpers/electron-app) so the app
 * boots to a clean, setup-complete first-launch state with no real user data.
 *
 * Navigation (rc.10): nav-rail buttons no longer carry `title` attributes
 * (the OS tooltip was replaced by an inline one), so the old
 * `button.title === 'Settings'` scan matched nothing. The rail's stable
 * anchor is `data-tour="nav-settings"`; Settings opens as a page TAB.
 */

import { test, expect } from '@playwright/test'
import { launchIsolatedApp, closeIsolatedApp, IsolatedApp } from './helpers/electron-app'

let ctx: IsolatedApp
let page: IsolatedApp['page']

test.beforeAll(async () => {
  ctx = await launchIsolatedApp()
  page = ctx.page
})

test.afterAll(async () => {
  await closeIsolatedApp(ctx)
})

test.describe('GitHub OAuth UI', () => {
  test('Settings page opens and GitHub tab is reachable', async () => {
    // Dismiss any first-launch modals (what's new, training, onboarding).
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }

    // Open Settings from the nav rail (stable data-tour anchor; the aria-label
    // is dynamic by design, and `title` no longer exists on nav items).
    await page.locator('aside [data-tour="nav-settings"]').click()
    await expect(
      page.locator('[data-testid="page-tab"][data-page="settings"][aria-current="page"]'),
    ).toBeVisible({ timeout: 5000 })

    // Switch to the GitHub tab within Settings (left tab list, plain buttons).
    await page.getByRole('button', { name: 'GitHub', exact: true }).click()

    // AccountsSection empty-state copy is stable and GitHub-tab-specific — the
    // bare word "Accounts" also appears in the Settings tab list, so it proved
    // nothing about reaching the GitHub tab.
    await expect(page.getByText('No auth profiles yet')).toBeVisible({ timeout: 5000 })
  })

  test('"Sign in with GitHub" entry point is clickable', async () => {
    // Confirm the entry button exists and is enabled. We avoid clicking it
    // because oauthStart would kick off a real device-code request; the unit
    // tests around OAuthDeviceFlow cover the modal render path. Current copy:
    // "Sign in with GitHub / Add account" (AccountsSection).
    const entry = page.getByRole('button', { name: /Sign in with GitHub/ })
    await expect(entry).toBeVisible()
    await expect(entry).toBeEnabled()
  })
})
