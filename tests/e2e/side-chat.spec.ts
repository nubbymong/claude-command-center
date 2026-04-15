/**
 * Playwright E2E tests -- Side Chat
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

test.describe('Side Chat', () => {
  test('app launches without crashing', async () => {
    const body = await page.locator('body').innerHTML()
    expect(body.length).toBeGreaterThan(100)
  })

  test('Ctrl+; does not crash when no session active', async () => {
    // Press Ctrl+; when no session is active -- should be a no-op
    await page.keyboard.press('Control+;')
    await page.waitForTimeout(500)
    // Verify app is still running
    const body = await page.locator('body').innerHTML()
    expect(body.length).toBeGreaterThan(100)
  })

  test('Side Chat overlay is not visible by default', async () => {
    const sideChat = page.locator('text=Side Chat').first()
    const isVisible = await sideChat.isVisible({ timeout: 1000 }).catch(() => false)
    expect(isVisible).toBe(false)
  })
})
