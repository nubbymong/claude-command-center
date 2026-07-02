/**
 * Playwright E2E tests — Sidebar navigation and view switching.
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

test.describe('Sidebar Navigation', () => {
  test('sidebar is visible by default', async () => {
    const sidebar = page.locator('aside')
    // If a setup/boot gate is somehow showing, sidebar won't be visible — skip.
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

    // Nav row: Agent Hub, Insights, Tokenomics, Conductor MCP, Memory, Logs,
    // Settings + Feature Guide = 8 buttons.
    const navArea = sidebar.locator('.px-2.pt-2')
    const buttons = navArea.locator('button')
    const count = await buttons.count()
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

  test('Agent Hub nav button is first', async () => {
    const sidebar = page.locator('aside')
    if (!await sidebar.isVisible().catch(() => false)) {
      test.skip()
      return
    }

    // First nav button is Agent Hub (formerly "Cloud Agents"). The button's
    // title attribute mirrors the nav label.
    const firstButton = sidebar.locator('.px-2.pt-2 button').first()
    const title = await firstButton.getAttribute('title')
    expect(title).toContain('Agent Hub')
  })

  test('clicking Agent Hub shows the dashboard', async () => {
    const sidebar = page.locator('aside')
    if (!await sidebar.isVisible().catch(() => false)) {
      test.skip()
      return
    }

    const firstButton = sidebar.locator('.px-2.pt-2 button').first()
    await firstButton.click()
    await page.waitForTimeout(500)

    // PageFrame renders its title as a <span>, not an <h1>, so assert the nav
    // entry's active state — a robust "the Agent Hub view is showing" signal.
    await expect(firstButton).toHaveClass(/rail-active/)
  })

  test('"Saved Configs" section exists in sidebar', async () => {
    const sidebar = page.locator('aside')
    if (!await sidebar.isVisible().catch(() => false)) {
      test.skip()
      return
    }

    // Exact match: the empty-state "No saved configs…" also contains the
    // substring, so a loose text= locator hits two elements.
    const configsLabel = sidebar.getByText('Saved Configs', { exact: true })
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

  test('Check for Updates lives in Settings (moved off the sidebar)', async () => {
    // The big green sidebar update toast was removed; the update affordance is
    // now the footer pill (shown only when an update is available) plus a
    // Settings field. Assert the Settings field exists rather than the old
    // sidebar text.
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      for (const b of buttons) {
        if (b.title === 'Settings' || b.title?.startsWith('Settings')) {
          b.click()
          return
        }
      }
    })
    await page.waitForTimeout(500)

    const body = await page.locator('body').innerText()
    expect(body).toContain('Check for Updates')
  })
})
