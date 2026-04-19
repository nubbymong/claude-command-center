/**
 * E2E for the GitHub sidebar OAuth device-flow UI.
 *
 * What this covers:
 *   - Settings → GitHub tab renders without crashing
 *   - "Sign in with GitHub / Add auth" entry point is present
 *   - AuthProfilesList shows the empty-state when no profiles exist
 *
 * What this intentionally does NOT cover:
 *   - Hitting real api.github.com — E2E must not depend on the network
 *   - The full device-flow poll loop — that requires ipcMain stubs (the
 *     OAuth start IPC has side effects that are impractical to mock in a
 *     launched Electron app). OAuth end-to-end validation stays in manual
 *     QA + the unit tests around OAuthDeviceFlow.
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
  // Give React + store hydration time to complete.
  await page.waitForTimeout(2500)
})

test.afterAll(async () => {
  if (app) await app.close()
})

test.describe('GitHub OAuth UI', () => {
  test('Settings page opens and GitHub tab is reachable', async () => {
    // Dismiss any first-launch modals (what's new, training, onboarding).
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }

    // Click the Settings sidebar button. The TitleBar / Sidebar uses `title`
    // attributes for accessibility labels — same selector pattern as the
    // training-capture script.
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      for (const b of buttons) {
        if (b.title === 'Settings' || b.title?.startsWith('Settings')) {
          b.click()
          return true
        }
      }
      return false
    })
    expect(clicked).toBe(true)
    await page.waitForTimeout(600)

    // Click the GitHub tab within settings. Tabs are rendered as <button>
    // with text content.
    const tabClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      for (const b of buttons) {
        if (b.textContent?.trim() === 'GitHub') {
          b.click()
          return true
        }
      }
      return false
    })
    expect(tabClicked).toBe(true)
    await page.waitForTimeout(400)

    // AuthProfilesList empty-state copy is stable — if this changes, the
    // test fails and we update together with the UI copy.
    const bodyText = await page.locator('body').innerText()
    expect(bodyText).toContain('Auth profiles')
  })

  test('"Sign in with GitHub" entry point is clickable', async () => {
    // Confirm the entry button exists. We avoid clicking it here because
    // oauthStart would kick off a real device-code request; the unit tests
    // around OAuthDeviceFlow cover the modal render path.
    const entryFound = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      for (const b of buttons) {
        const label = b.textContent?.trim() ?? ''
        if (label.includes('Sign in with GitHub') || label.includes('Add auth')) {
          return !b.disabled
        }
      }
      return false
    })
    expect(entryFound).toBe(true)
  })
})
