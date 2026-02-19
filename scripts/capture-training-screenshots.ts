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
 *   1. Creates a temporary config directory with mock data
 *   2. Launches the built Electron app via Playwright
 *   3. Navigates to each relevant view and captures screenshots
 *   4. Saves 960x800 JPEGs to src/renderer/assets/training/
 */

import { _electron as electron } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const SCREENSHOT_DIR = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'training')
const BUILT_APP = path.join(__dirname, '..', 'out', 'main', 'index.js')

const WIDTH = 1280
const HEIGHT = 800
const JPEG_QUALITY = 85

// Screenshot step definitions
const STEPS = [
  { filename: 'step-welcome.jpg', view: 'sessions', action: 'none', description: 'Empty welcome screen' },
  { filename: 'step-terminal-configs.jpg', view: 'sessions', action: 'open-sidebar', description: 'Sidebar with configs' },
  { filename: 'step-sessions.jpg', view: 'sessions', action: 'none', description: 'Active session with terminal' },
  { filename: 'step-commands.jpg', view: 'sessions', action: 'none', description: 'Quick commands panel' },
  { filename: 'step-agent-hub.jpg', view: 'cloud-agents', action: 'none', description: 'Agent Hub page' },
  { filename: 'step-statusline.jpg', view: 'settings', action: 'statusline-tab', description: 'Statusline settings' },
  { filename: 'step-tips.jpg', view: 'settings', action: 'shortcuts-tab', description: 'Shortcuts settings' },
]

async function main() {
  // Create temp config dir with mock data
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-training-'))
  const configDir = path.join(tmpDir, 'CONFIG')
  fs.mkdirSync(configDir, { recursive: true })

  // Write minimal mock config files
  const mockConfigs = [
    { id: 'demo-1', label: 'React Project', workingDirectory: 'C:\\Projects\\react-app', group: 'Frontend', model: 'sonnet' },
    { id: 'demo-2', label: 'API Server', workingDirectory: 'C:\\Projects\\api', group: 'Backend', model: 'opus' },
    { id: 'demo-3', label: 'DevOps', workingDirectory: 'C:\\Projects\\infra', group: 'Ops', model: 'sonnet' },
  ]
  fs.writeFileSync(path.join(configDir, 'configs.json'), JSON.stringify(mockConfigs, null, 2))
  fs.writeFileSync(path.join(configDir, 'commands.json'), JSON.stringify([
    { id: 'cmd-1', label: 'Fix Bug', prompt: '/fix the current issue', configId: null },
    { id: 'cmd-2', label: 'Write Tests', prompt: 'Write comprehensive tests', configId: null },
  ], null, 2))
  fs.writeFileSync(path.join(configDir, 'appMeta.json'), JSON.stringify({
    setupVersion: '1.2.121',
    lastSeenVersion: '1.2.121',
    lastTrainingVersion: '1.0.0',
  }, null, 2))
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({}, null, 2))

  console.log(`[capture] Temp config dir: ${tmpDir}`)
  console.log(`[capture] Launching Electron app...`)

  const app = await electron.launch({
    args: [BUILT_APP],
    env: {
      ...process.env,
      PORTABLE_EXECUTABLE_DIR: tmpDir,
      NODE_ENV: 'production',
    },
  })

  const window = await app.firstWindow()
  await window.setViewportSize({ width: WIDTH, height: HEIGHT })

  // Wait for app to load
  console.log('[capture] Waiting for app to load...')
  await window.waitForTimeout(4000)

  for (const step of STEPS) {
    console.log(`[capture] Capturing: ${step.description} -> ${step.filename}`)

    // Navigate to the correct view if needed
    if (step.view === 'cloud-agents') {
      await window.evaluate(() => {
        const sidebar = document.querySelector('[data-view="cloud-agents"]') as HTMLElement
        sidebar?.click()
      })
      await window.waitForTimeout(1000)
    } else if (step.view === 'settings') {
      await window.evaluate(() => {
        const sidebar = document.querySelector('[data-view="settings"]') as HTMLElement
        sidebar?.click()
      })
      await window.waitForTimeout(500)

      if (step.action === 'statusline-tab') {
        await window.evaluate(() => {
          const tabs = document.querySelectorAll('button')
          for (const tab of tabs) {
            if (tab.textContent?.trim() === 'Status Line') {
              tab.click()
              break
            }
          }
        })
        await window.waitForTimeout(300)
      } else if (step.action === 'shortcuts-tab') {
        await window.evaluate(() => {
          const tabs = document.querySelectorAll('button')
          for (const tab of tabs) {
            if (tab.textContent?.trim() === 'Shortcuts') {
              tab.click()
              break
            }
          }
        })
        await window.waitForTimeout(300)
      }
    }

    // Capture screenshot
    const outputPath = path.join(SCREENSHOT_DIR, step.filename)
    await window.screenshot({
      path: outputPath,
      type: 'jpeg',
      quality: JPEG_QUALITY,
    })
    console.log(`[capture] Saved: ${outputPath}`)
  }

  await app.close()

  // Cleanup temp dir
  fs.rmSync(tmpDir, { recursive: true, force: true })

  console.log('\n[capture] Done! All screenshots captured.')
  console.log('[capture] Run `npm run build` to include them in the app.')
}

main().catch((err) => {
  console.error('[capture] Error:', err)
  process.exit(1)
})
