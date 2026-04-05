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

  // Dismiss any modals (WhatsNew, Training, machine name prompt, etc.)
  await window.keyboard.press('Escape')
  await window.waitForTimeout(500)
  await window.keyboard.press('Escape')
  await window.waitForTimeout(500)
  await window.keyboard.press('Escape')
  await window.waitForTimeout(500)

  // Helper: click a nav button by its title attribute
  async function clickNav(label: string) {
    const clicked = await window.evaluate((lbl: string) => {
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

  // ── Step 1: Welcome — sessions view with sidebar visible ──
  await capture('step-welcome.jpg', 'Welcome / sessions overview with sidebar')

  // ── Step 2: Terminal Configs — show the sidebar configs ──
  await capture('step-terminal-configs.jpg', 'Sidebar with terminal configs')

  // ── Step 3: Sessions — same view, shows session/terminal area ──
  await capture('step-sessions.jpg', 'Sessions and terminal area')

  // ── Step 4: Commands — same view, command bar visible at bottom ──
  await capture('step-commands.jpg', 'Quick commands bar')

  // ── Step 5: Agent Hub ──
  await clickNav('Agent Hub')
  await capture('step-agent-hub.jpg', 'Agent Hub page')

  // ── Step 6: Statusline — go back to sessions to show context bar ──
  // Navigate to sessions view first
  await window.evaluate(() => {
    const buttons = document.querySelectorAll('button')
    for (const btn of buttons) {
      if (btn.textContent?.includes('Sessions') || btn.title === 'Sessions') {
        btn.click()
        return
      }
    }
  })
  await window.waitForTimeout(800)
  await capture('step-statusline.jpg', 'Statusline / context bar')

  // ── Step 7: Vision ──
  await clickNav('Vision')
  await capture('step-vision.jpg', 'Vision system page')

  // ── Step 8: Tokenomics ──
  await clickNav('Tokenomics')
  await capture('step-tokenomics.jpg', 'Tokenomics page')

  // ── Step 9: Memory Visualiser ──
  await clickNav('Memory')
  await capture('step-memory.jpg', 'Memory Visualiser page')

  // ── Step 10: Storyboard — go back to sessions to show command bar ──
  await window.evaluate(() => {
    const buttons = document.querySelectorAll('button')
    for (const btn of buttons) {
      if (btn.textContent?.includes('Sessions') || btn.title === 'Sessions') {
        btn.click()
        return
      }
    }
  })
  await window.waitForTimeout(800)
  await capture('step-storyboard.jpg', 'Command bar with Storyboard button')

  // ── Step 11: Session Options — open a config dialog if possible ──
  // Try to right-click a config to show edit dialog
  await capture('step-session-options.jpg', 'Session options (from config dialog)')

  // ── Step 12: Screenshots — same session view with Snap button visible ──
  await capture('step-screenshots.jpg', 'Screenshot / Snap button area')

  // ── Step 13: Security — show settings page ──
  await clickNav('Settings')
  await window.waitForTimeout(500)
  await capture('step-security.jpg', 'Settings page (security section)')

  // ── Step 14: Tips — shortcuts tab ──
  await clickTab('Shortcuts')
  await capture('step-tips.jpg', 'Shortcuts / tips')

  await app.close()

  console.log('\n[capture] Done! All screenshots captured.')
  console.log('[capture] Run `npm run build` to include them in the app.')
}

main().catch((err) => {
  console.error('[capture] Error:', err)
  process.exit(1)
})
