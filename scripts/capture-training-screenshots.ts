/**
 * Capture training walkthrough screenshots from the running built app.
 *
 * Usage:
 *   npm run capture-training
 *
 * Prerequisites:
 *   - `npm run build` must have completed successfully
 *   - @playwright/test must be installed (already a devDependency)
 *
 * What it does:
 *   1. Launches the built Electron app via Playwright (uses real config)
 *   2. Navigates to each relevant view and captures screenshots
 *   3. Saves JPEGs to src/renderer/assets/training/
 */

import { _electron as electron } from '@playwright/test'
import * as path from 'path'

const SCREENSHOT_DIR = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'training')
const BUILT_APP = path.join(__dirname, '..', 'out', 'main', 'index.js')

const WIDTH = 1280
const HEIGHT = 800
const JPEG_QUALITY = 85

async function main() {
  console.log('[capture] Launching Electron app...')

  const app = await electron.launch({
    args: [BUILT_APP],
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
  })

  const window = await app.firstWindow()
  await window.setViewportSize({ width: WIDTH, height: HEIGHT })

  // Wait for app to fully load and render
  console.log('[capture] Waiting for app to load...')
  await window.waitForTimeout(5000)

  // Dismiss any modals (WhatsNew, Training, etc.) by pressing Escape
  await window.keyboard.press('Escape')
  await window.waitForTimeout(500)
  await window.keyboard.press('Escape')
  await window.waitForTimeout(500)

  // Helper: click a nav button by its title attribute
  async function clickNav(label: string) {
    const clicked = await window.evaluate((lbl: string) => {
      // Nav buttons use title attribute containing the label
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        if (btn.title === lbl || btn.title?.startsWith(lbl)) {
          btn.click()
          return true
        }
      }
      return false
    }, label)
    if (!clicked) {
      console.log(`[capture] WARNING: Could not find nav button "${label}"`)
    }
    await window.waitForTimeout(800)
  }

  // Helper: click a tab button by its text content
  async function clickTab(text: string) {
    const clicked = await window.evaluate((txt: string) => {
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        if (btn.textContent?.trim() === txt) {
          btn.click()
          return true
        }
      }
      return false
    }, text)
    if (!clicked) {
      console.log(`[capture] WARNING: Could not find tab "${text}"`)
    }
    await window.waitForTimeout(500)
  }

  // Helper: capture and save screenshot
  async function capture(filename: string, description: string) {
    const outputPath = path.join(SCREENSHOT_DIR, filename)
    await window.screenshot({
      path: outputPath,
      type: 'jpeg',
      quality: JPEG_QUALITY,
    })
    console.log(`[capture] Saved: ${filename} (${description})`)
  }

  // ── Step 1: Welcome — sessions view with empty state ──
  // Should already be on sessions view after load
  await capture('step-welcome.jpg', 'Welcome / sessions overview')

  // ── Step 2: Terminal Configs — show the sidebar configs ──
  // The sidebar with configs should already be visible on sessions view
  await capture('step-terminal-configs.jpg', 'Sidebar with terminal configs')

  // ── Step 3: Sessions — same view, shows session/terminal area ──
  await capture('step-sessions.jpg', 'Sessions and terminal area')

  // ── Step 4: Commands — same view (commands are in the session area) ──
  await capture('step-commands.jpg', 'Quick commands')

  // ── Step 5: Agent Hub ──
  await clickNav('Agent Hub')
  await capture('step-agent-hub.jpg', 'Agent Hub page')

  // ── Step 6: Statusline settings ──
  await clickNav('Settings')
  await clickTab('Status Line')
  await capture('step-statusline.jpg', 'Statusline settings')

  // ── Step 7: Shortcuts/tips ──
  await clickTab('Shortcuts')
  await capture('step-tips.jpg', 'Shortcuts settings')

  await app.close()

  console.log('\n[capture] Done! All screenshots captured.')
  console.log('[capture] Run `npm run build` to include them in the app.')
}

main().catch((err) => {
  console.error('[capture] Error:', err)
  process.exit(1)
})
