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
 * The second test is a guard on a state the app itself never writes: the
 * clean seed (helpers/electron-app) marks the Codex question answered
 * (codexAnswered) without a yes (no saved Codex on/off). Main and the
 * renderer read that as "not set up", so the New saved config dialog must
 * grey the Codex card and say to set it up in Settings, Accounts. (A real
 * unanswered user never reaches the dialog: the one-time Codex question
 * covers the app.)
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

  // Scoped to the tab list (its <nav>): General also shows an "Accounts" link
  // button (code review tools, "Change in Accounts"), so the bare role query
  // matches two buttons and a click fails strict mode.
  await page.getByRole('navigation').getByRole('button', { name: 'Accounts', exact: true }).click()
  const row = page.locator('[data-testid="provider-row-codex"]')
  await expect(row).toBeVisible({ timeout: 5000 })
  // Status text varies by environment (found and ready, not found, not
  // checked yet for a Codex never switched on, or off).
  await expect(row.locator('[data-testid="provider-status-codex"]')).toBeVisible()
})

test('with Codex not set up, the New saved config dialog greys the Codex card and says so', async () => {
  // Guard on a state no answer path writes: the helper's clean seed marks the
  // Codex question answered but saves no yes (codexAnswered, and no saved
  // Codex on/off). The app reads that as not set up, and a Codex that is not
  // set up starts nothing (owner decision U1, 2026-09-26), so the dialog,
  // which reads the saved on/off, must not offer the Codex card.
  await page.locator('[data-testid="panel-tab-saved"]').click()
  await page.locator('[data-testid="new-button"]').click()
  await page.locator('[data-testid="new-menu-config"]').click()
  const dialog = page.locator('[data-testid="session-dialog"]')
  await expect(dialog.locator('#session-dialog-title')).toHaveText('New saved config', { timeout: 10000 })
  const providers = dialog.locator('[role="radiogroup"][aria-label="Provider"]')
  // No connection is chosen yet, so SSH is not what greys the card; Claude
  // Code is still offered, so the group itself is live.
  await expect(providers.locator('input[value="claude"]')).toBeEnabled()
  await expect(providers.locator('input[value="codex"]')).toBeDisabled()
  await expect(dialog.getByTestId('codex-not-set-up-note')).toHaveText(
    'Codex is not set up yet. Set it up in Settings, Accounts to launch this config.',
  )
  await expect(dialog.getByTestId('codex-off-note')).toHaveCount(0)
  await expect(dialog.getByTestId('codex-ssh-note')).toHaveCount(0)
})
