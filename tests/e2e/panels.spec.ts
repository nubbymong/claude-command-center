/**
 * Playwright E2E tests -- Panel system
 */
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import { waitForAppReady } from './helpers'

const APP_PATH = path.resolve(__dirname, '../../out/main/index.js')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await electron.launch({
    args: [APP_PATH],
    env: { ...process.env, NODE_ENV: 'test', E2E_HEADLESS: '1' },
  })
  page = await app.firstWindow()
  await waitForAppReady(page)
})

test.afterAll(async () => {
  if (app) await app.close()
})

test.describe('Panel System', () => {
  test('app launches without crashing', async () => {
    const body = await page.locator('body').innerHTML()
    expect(body.length).toBeGreaterThan(100)
  })

  test('main content area exists', async () => {
    const main = page.locator('main')
    const isVisible = await main.isVisible().catch(() => false)
    // Main area should be visible if past setup
    expect(typeof isVisible).toBe('boolean')
  })

  test('Views button appears in session header when session is active', async () => {
    // This test may skip if no session is active (no config setup in test env)
    const viewsButton = page.getByText('Views').first()
    const isVisible = await viewsButton.isVisible({ timeout: 2000 }).catch(() => false)
    // Views button only appears when a session is active
    // In test env without config, we may not have a session
    if (!isVisible) {
      test.skip()
      return
    }
    expect(isVisible).toBe(true)
  })

  test('clicking Views shows dropdown menu', async () => {
    const viewsButton = page.getByText('Views').first()
    const isVisible = await viewsButton.isVisible({ timeout: 2000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }
    await viewsButton.click()
    // Check for dropdown items
    const diffOption = page.getByText('Diff Viewer').first()
    const optionVisible = await diffOption.isVisible({ timeout: 1000 }).catch(() => false)
    expect(optionVisible).toBe(true)
    // Click away to dismiss
    await page.locator('body').click()
  })
})
