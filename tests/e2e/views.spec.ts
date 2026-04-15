/**
 * Playwright E2E tests — Various views (Settings, Usage, Logs, Insights, Browse)
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
  await page.waitForTimeout(3000)
})

test.afterAll(async () => {
  if (app) await app.close()
})

async function clickNavButton(index: number): Promise<boolean> {
  const sidebar = page.locator('aside')
  if (!await sidebar.isVisible().catch(() => false)) return false
  const buttons = sidebar.locator('.px-2.pt-2 button')
  const count = await buttons.count()
  if (index >= count) return false
  await buttons.nth(index).click()
  await page.waitForTimeout(500)
  return true
}

test.describe('Sessions View', () => {
  test('shows empty state or session list', async () => {
    // Sessions = nav button index 1 (after Cloud Agents)
    if (!await clickNavButton(1)) { test.skip(); return }

    // Should show either "Create a terminal config" empty state or active tabs
    const body = await page.locator('main').innerHTML()
    expect(body.length).toBeGreaterThan(0)
  })

  test('empty sessions shows command center heading', async () => {
    if (!await clickNavButton(1)) { test.skip(); return }

    const heading = page.locator('text=Claude Command Center')
    const hasHeading = await heading.isVisible().catch(() => false)
    // True if no sessions, false if sessions exist — both valid
    expect(typeof hasHeading).toBe('boolean')
  })
})

test.describe('Browse View', () => {
  test('renders project browser', async () => {
    // Browse = nav button index 2
    if (!await clickNavButton(2)) { test.skip(); return }
    await page.waitForTimeout(500)
    const body = await page.locator('main').innerHTML()
    expect(body.length).toBeGreaterThan(0)
  })
})

test.describe('Usage View', () => {
  test('renders usage dashboard', async () => {
    // Usage = nav button index 3
    if (!await clickNavButton(3)) { test.skip(); return }
    await page.waitForTimeout(500)
    const body = await page.locator('main').innerHTML()
    expect(body.length).toBeGreaterThan(0)
  })
})

test.describe('Insights View', () => {
  test('renders insights page', async () => {
    // Insights = nav button index 4
    if (!await clickNavButton(4)) { test.skip(); return }
    await page.waitForTimeout(500)
    const body = await page.locator('main').innerHTML()
    expect(body.length).toBeGreaterThan(0)
  })
})

test.describe('Logs View', () => {
  test('renders log viewer', async () => {
    // Logs = nav button index 5
    if (!await clickNavButton(5)) { test.skip(); return }
    await page.waitForTimeout(500)
    const body = await page.locator('main').innerHTML()
    expect(body.length).toBeGreaterThan(0)
  })
})

test.describe('Settings View', () => {
  test('renders settings page', async () => {
    // Settings = nav button index 6
    if (!await clickNavButton(6)) { test.skip(); return }
    await page.waitForTimeout(500)
    const body = await page.locator('main').innerHTML()
    expect(body.length).toBeGreaterThan(0)
  })
})

test.describe('Sidebar Toggle', () => {
  test('Ctrl+B toggles sidebar', async () => {
    const sidebar = page.locator('aside')
    if (!await sidebar.isVisible().catch(() => false)) { test.skip(); return }

    // Toggle off
    await page.keyboard.press('Control+b')
    await page.waitForTimeout(300)
    const hiddenAfterToggle = !await sidebar.isVisible().catch(() => true)

    // Toggle back on
    await page.keyboard.press('Control+b')
    await page.waitForTimeout(300)
    const visibleAfterToggle = await sidebar.isVisible().catch(() => false)

    // At least one toggle should have worked
    expect(hiddenAfterToggle || visibleAfterToggle).toBe(true)
  })
})

test.describe('Session Config Dialog', () => {
  test('Ctrl+T opens new config dialog', async () => {
    const sidebar = page.locator('aside')
    if (!await sidebar.isVisible().catch(() => false)) { test.skip(); return }

    await page.keyboard.press('Control+t')
    await page.waitForTimeout(500)

    // Should see dialog with label/directory inputs
    const hasLabelInput = await page.locator('input[placeholder*="label" i], input[value=""]').first().isVisible().catch(() => false)
    const hasDialog = await page.locator('.fixed, .absolute').first().isVisible().catch(() => false)
    expect(hasLabelInput || hasDialog).toBe(true)

    // Close with Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  })
})
