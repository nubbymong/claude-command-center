/**
 * Playwright E2E test for the Settings Codex tab (P2.5).
 *
 * Verifies that the Codex tab exists in Settings and renders a status row
 * containing "Codex CLI" text. Does not depend on Codex being installed.
 */

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'

const APP_PATH = path.resolve(__dirname, '../../out/main/index.js')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await electron.launch({
    args: [APP_PATH],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      E2E_HEADLESS: '1',
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
})

test.afterAll(async () => {
  if (app) await app.close()
})

test('Settings shows Codex tab with status row', async ({ page: _p }) => {
  await page.click('button:has-text("Settings")')
  await page.click('button:has-text("Codex")')
  // Status row must be present (text varies by environment -- installed or not)
  await expect(page.locator('text=Codex CLI').first()).toBeVisible({ timeout: 2000 })
})
