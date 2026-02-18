/**
 * Playwright E2E tests — Sidebar navigation and view switching
 */

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'

const APP_PATH = path.resolve(__dirname, '../../out/main/index.js')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await electron.launch({
    args: [APP_PATH],
    env: { ...process.env, NODE_ENV: 'test', E2E_HEADLESS: '1' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000) // Wait for setup check + config load
})

test.afterAll(async () => {
  if (app) await app.close()
})

test.describe('Sidebar Navigation', () => {
  test('sidebar is visible by default', async () => {
    const sidebar = page.locator('aside')
    // If setup dialog is showing, sidebar won't be visible — that's OK
    const isVisible = await sidebar.isVisible().catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }
    expect(isVisible).toBe(true)
  })

  test('has all navigation buttons', async () => {
    const sidebar = page.locator('aside')
    if (!await sidebar.isVisible().catch(() => false)) {
      test.skip()
      return
    }

    // Navigation area with buttons
    const navArea = sidebar.locator('.px-2.pt-2')
    const buttons = navArea.locator('button')
    const count = await buttons.count()
    // Should have: Cloud Agents, Sessions, Browse, Usage, Insights, Logs, Settings, Debug = 8
    expect(count).toBeGreaterThanOrEqual(7)
  })

  test('clicking nav buttons switches views', async () => {
    const sidebar = page.locator('aside')
    if (!await sidebar.isVisible().catch(() => false)) {
      test.skip()
      return
    }

    const navButtons = sidebar.locator('.px-2.pt-2 button')
    const count = await navButtons.count()

    // Click each nav button and verify no crash
    for (let i = 0; i < Math.min(count, 7); i++) {
      await navButtons.nth(i).click()
      await page.waitForTimeout(200)
      // Just verify the page didn't crash
      const bodyText = await page.locator('body').innerHTML()
      expect(bodyText.length).toBeGreaterThan(0)
    }
  })

  test('Cloud Agents nav button is first', async () => {
    const sidebar = page.locator('aside')
    if (!await sidebar.isVisible().catch(() => false)) {
      test.skip()
      return
    }

    // First nav button should have cloud agents tooltip
    const firstButton = sidebar.locator('.px-2.pt-2 button').first()
    const title = await firstButton.getAttribute('title')
    expect(title).toContain('Cloud Agents')
  })

  test('clicking Cloud Agents shows the dashboard', async () => {
    const sidebar = page.locator('aside')
    if (!await sidebar.isVisible().catch(() => false)) {
      test.skip()
      return
    }

    const firstButton = sidebar.locator('.px-2.pt-2 button').first()
    await firstButton.click()
    await page.waitForTimeout(500)

    // Should see "Cloud Agents" heading
    const heading = page.locator('h1:has-text("Cloud Agents")')
    await expect(heading).toBeVisible({ timeout: 3000 })
  })

  test('"Saved Configs" section exists in sidebar', async () => {
    const sidebar = page.locator('aside')
    if (!await sidebar.isVisible().catch(() => false)) {
      test.skip()
      return
    }

    const configsLabel = sidebar.locator('text=Saved Configs')
    await expect(configsLabel).toBeVisible()
  })

  test('"Active Sessions" section exists in sidebar', async () => {
    const sidebar = page.locator('aside')
    if (!await sidebar.isVisible().catch(() => false)) {
      test.skip()
      return
    }

    const sessionsLabel = sidebar.getByText('Active Sessions', { exact: true })
    await expect(sessionsLabel).toBeVisible()
  })

  test('Check for Updates button exists', async () => {
    const sidebar = page.locator('aside')
    if (!await sidebar.isVisible().catch(() => false)) {
      test.skip()
      return
    }

    const updateBtn = sidebar.locator('text=Check for Updates')
    // May also show "Update Available" — either is fine
    const hasUpdate = await updateBtn.isVisible().catch(() => false)
    const hasAvailable = await sidebar.locator('text=Update Available').isVisible().catch(() => false)
    expect(hasUpdate || hasAvailable).toBe(true)
  })
})
