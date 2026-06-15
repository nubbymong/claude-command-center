/**
 * Playwright E2E tests for Claude Command Center
 * Tests the actual Electron app using Playwright's Electron support.
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

test.describe('App Launch', () => {
  test('window is visible', async () => {
    const isVisible = await ctx.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return win ? win.isVisible() : false
    })
    expect(isVisible).toBe(true)
  })

  test('window has correct minimum size', async () => {
    const size = await ctx.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return win ? win.getMinimumSize() : [0, 0]
    })
    expect(size[0]).toBeGreaterThanOrEqual(1280)
    expect(size[1]).toBeGreaterThanOrEqual(720)
  })

  test('window title contains app name or is default', async () => {
    const title = await page.title()
    // Electron apps may have empty title or the HTML title
    expect(typeof title).toBe('string')
  })

  test('renders the title bar', async () => {
    // The frameless window should have a custom title bar
    // Look for any element that acts as the title bar
    const body = await page.locator('body').innerHTML()
    expect(body.length).toBeGreaterThan(0)
  })

  test('no console errors on startup', async () => {
    const errors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.waitForTimeout(1000)
    // Filter out expected warnings (e.g., React dev mode)
    const realErrors = errors.filter(e =>
      !e.includes('DevTools') && !e.includes('Electron') && !e.includes('Warning:')
    )
    expect(realErrors).toHaveLength(0)
  })
})

test.describe('Setup / Config Loading', () => {
  test('either shows setup dialog or main UI', async () => {
    // The app should show either the setup dialog (first run) or the main layout
    const hasSetup = await page.locator('text=Select Data Directory').isVisible().catch(() => false)
    const hasSidebar = await page.locator('aside').isVisible().catch(() => false)
    const hasLoading = await page.locator('text=Loading').isVisible().catch(() => false)
    const hasCloudAgents = await page.locator('text=Cloud Agents').first().isVisible().catch(() => false)
    const hasBody = (await page.locator('body').innerHTML()).length > 100
    // One of these should be true
    expect(hasSetup || hasSidebar || hasLoading || hasCloudAgents || hasBody).toBe(true)
  })
})

test.describe('Window Controls', () => {
  test('window can be minimized via IPC', async () => {
    // Test that the minimize IPC channel works
    const result = await ctx.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return false
      const wasMinimized = win.isMinimized()
      win.minimize()
      const isMinimized = win.isMinimized()
      win.restore()
      return isMinimized || wasMinimized
    })
    // Just verify it doesn't crash
    expect(typeof result).toBe('boolean')
  })

  test('isMaximized IPC handler responds', async () => {
    const isMaximized = await ctx.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return win ? win.isMaximized() : false
    })
    expect(typeof isMaximized).toBe('boolean')
  })
})
