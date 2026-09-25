/**
 * Playwright E2E test for Codex in Settings (P2.5; adapted in WP2 commit 6g).
 *
 * The Settings Codex tab is retired: Codex now lives in Settings, Accounts,
 * as a row of the Providers card (its on/off switch and its status line, with
 * the install commands and Check again when its CLI is not found) above its
 * accounts. Verifies that the Settings tab list has no Codex tab and that the
 * Accounts tab shows the Codex row with a status line. Does not depend on
 * Codex being installed.
 *
 * Runs against an isolated temp data dir (helpers/electron-app) so the app
 * boots to a clean, setup-complete first-launch state with no real user data.
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

test('Settings has no Codex tab; Settings, Accounts shows the Codex row with its status', async () => {
  // Dismiss any first-launch modals (what's new, training, onboarding).
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
  await page.locator('aside [data-tour="nav-settings"]').click()
  await expect(
    page.locator('[data-testid="page-tab"][data-page="settings"][aria-current="page"]'),
  ).toBeVisible({ timeout: 5000 })

  // The tab list (plain buttons) no longer offers a Codex tab.
  await expect(page.getByRole('button', { name: 'Codex', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  const row = page.locator('[data-testid="provider-row-codex"]')
  await expect(row).toBeVisible({ timeout: 5000 })
  // Status text varies by environment (found and ready, not found, not
  // checked yet for a Codex never switched on, or off).
  await expect(row.locator('[data-testid="provider-status-codex"]')).toBeVisible()
})
