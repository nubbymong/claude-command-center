/**
 * Playwright E2E test for the Settings Codex tab (P2.5).
 *
 * Verifies that the Codex tab exists in Settings and renders a status row
 * containing "Codex CLI" text. Does not depend on Codex being installed.
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

test('Settings shows Codex tab with status row', async () => {
  await page.click('button:has-text("Settings")')
  await page.click('button:has-text("Codex")')
  // Status row must be present (text varies by environment -- installed or not)
  await expect(page.locator('text=Codex CLI').first()).toBeVisible({ timeout: 2000 })
})
