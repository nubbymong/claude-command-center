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
 *   1. Seeds sample data (configs, commands, agents, memory) so pages look populated
 *   2. Launches the built Electron app via Playwright
 *   3. Navigates to each relevant view and captures screenshots
 *   4. Saves JPEGs to src/renderer/assets/training/
 *   5. Cleans up sample data (restores any backed-up originals)
 */

import { _electron as electron } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { execSync } from 'child_process'

const SCREENSHOT_DIR = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'training')
const BUILT_APP = path.join(__dirname, '..', 'out', 'main', 'index.js')

// Platform suffix: running on macOS saves as step-welcome-mac.jpg, Windows as step-welcome.jpg (no suffix)
const PLATFORM_SUFFIX = process.platform === 'darwin' ? '-mac' : ''

const WIDTH = 1280
const HEIGHT = 800
const JPEG_QUALITY = 85

// ── Config directory resolution ──

function getConfigDir(): string {
  if (process.platform === 'win32') {
    // Try new registry key, then old key, then default
    for (const key of ['Software\\Claude Command Center', 'Software\\Claude Conductor']) {
      try {
        const result = execSync(
          `reg query "HKCU\\${key}" /v ResourcesDirectory`,
          { encoding: 'utf-8', timeout: 5000, windowsHide: true }
        )
        const match = result.match(/ResourcesDirectory\s+REG_SZ\s+(.+)/)
        if (match) return path.join(match[1].trim(), 'CONFIG')
      } catch { /* try next */ }
    }
    // Default
    const dataDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude Conductor')
    return path.join(dataDir, 'CONFIG')
  } else {
    // macOS/Linux: read from JSON fallback
    const fallbackFile = path.join(os.homedir(), '.claude-conductor', 'platform-config.json')
    try {
      if (fs.existsSync(fallbackFile)) {
        const config = JSON.parse(fs.readFileSync(fallbackFile, 'utf-8'))
        if (config.ResourcesDirectory) return path.join(config.ResourcesDirectory, 'CONFIG')
        if (config.DataDirectory) return path.join(config.DataDirectory, 'CONFIG')
      }
    } catch { /* fall through */ }
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude Conductor', 'CONFIG')
  }
}

function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

// ── Sample data ──

const homePath = process.platform === 'win32'
  ? `C:\\Users\\${os.userInfo().username}\\Projects`
  : `${os.homedir()}/Projects`

const SAMPLE_CONFIGS = [
  {
    id: 'demo-webapp',
    label: 'Web App',
    workingDirectory: path.join(homePath, 'web-app'),
    model: '',
    color: '#89B4FA',
    sessionType: 'local',
  },
  {
    id: 'demo-api',
    label: 'API Server',
    workingDirectory: path.join(homePath, 'api-server'),
    model: '',
    color: '#A6E3A1',
    sessionType: 'local',
  },
  {
    id: 'demo-mobile',
    label: 'Mobile App',
    workingDirectory: path.join(homePath, 'mobile'),
    model: '',
    color: '#F9E2AF',
    sessionType: 'local',
  },
  {
    id: 'demo-infra',
    label: 'Infrastructure',
    workingDirectory: path.join(homePath, 'infra'),
    model: '',
    color: '#CBA6F7',
    sessionType: 'local',
  },
]

const SAMPLE_COMMANDS = [
  {
    id: 'demo-cmd-review',
    label: 'Code Review',
    prompt: 'Review the recent changes for bugs and improvements',
    scope: 'global',
    color: '#89B4FA',
    defaultArgs: ['--focus security'],
  },
  {
    id: 'demo-cmd-test',
    label: 'Run Tests',
    prompt: 'Run all tests and fix any failures',
    scope: 'global',
    color: '#A6E3A1',
    defaultArgs: [],
  },
  {
    id: 'demo-cmd-docs',
    label: 'Update Docs',
    prompt: 'Update documentation to reflect recent changes',
    scope: 'global',
    color: '#F9E2AF',
    defaultArgs: [],
  },
]

const SAMPLE_COMMAND_SECTIONS = [
  { id: 'demo-section-dev', name: 'Development' },
]

const SAMPLE_SETTINGS = {
  localMachineName: process.platform === 'darwin' ? 'Mac Mini' : 'Dev Workstation',
  terminalFontSize: 14,
  updateChannel: 'stable',
}

const SAMPLE_APP_META = {
  setupVersion: '99.99.99',
  lastTrainingVersion: '99.99.99',
  lastWhatsNewVersion: '99.99.99',
  lastSeenVersion: '99.99.99',
}

const SAMPLE_CLOUD_AGENTS = [
  {
    id: 'demo-agent-1',
    name: 'API Documentation Generator',
    description: 'Generate OpenAPI documentation for all REST endpoints',
    status: 'completed',
    createdAt: Date.now() - 900000,
    updatedAt: Date.now() - 300000,
    projectPath: path.join(homePath, 'api-server'),
    output: 'Generated OpenAPI 3.0 spec for 12 endpoints.\nCreated docs/openapi.yaml (245 lines).',
    cost: 0.42,
    duration: 600000,
    tokenUsage: { inputTokens: 15000, outputTokens: 8500 },
  },
  {
    id: 'demo-agent-2',
    name: 'Security Audit',
    description: 'Scan for OWASP top 10 vulnerabilities',
    status: 'completed',
    createdAt: Date.now() - 1200000,
    updatedAt: Date.now() - 600000,
    projectPath: path.join(homePath, 'web-app'),
    output: 'Scanned 47 files. Found 0 critical, 2 medium issues.\n- XSS risk in user input handler (src/routes/profile.ts:42)\n- Missing CSRF token on form submission (src/components/Settings.tsx:88)',
    cost: 0.68,
    duration: 900000,
    tokenUsage: { inputTokens: 22000, outputTokens: 12000 },
  },
]

const SAMPLE_MEMORY_PROJECTS = [
  {
    projectDir: 'demo-web-app',
    files: [
      {
        filename: 'user_preferences.md',
        content: `---\nname: User preferences\ndescription: Developer prefers functional components and Tailwind CSS\ntype: user\n---\n\nSenior full-stack developer. Prefers React functional components with hooks over class components. Uses Tailwind CSS for styling. Familiar with TypeScript.\n`,
      },
      {
        filename: 'project_architecture.md',
        content: `---\nname: Architecture overview\ndescription: Next.js app with Prisma ORM and PostgreSQL\ntype: project\n---\n\nNext.js 14 with App Router. Prisma ORM connecting to PostgreSQL. Auth via NextAuth.js with GitHub provider.\n\n**Why:** Migrated from Express to Next.js for SSR benefits.\n**How to apply:** All new API routes go in app/api/, use Prisma for DB queries.\n`,
      },
      {
        filename: 'feedback_testing.md',
        content: `---\nname: Testing approach\ndescription: Integration tests preferred over unit tests with mocks\ntype: feedback\n---\n\nUse integration tests hitting a real test database, not mocks.\n\n**Why:** Prior incident where mocked tests passed but production migration failed.\n**How to apply:** All new test files should use the test DB helper from tests/setup.ts.\n`,
      },
    ],
  },
  {
    projectDir: 'demo-api-server',
    files: [
      {
        filename: 'reference_docs.md',
        content: `---\nname: API documentation\ndescription: Swagger docs at /api-docs, Postman collection in docs/\ntype: reference\n---\n\nSwagger UI available at http://localhost:3000/api-docs\nPostman collection exported to docs/postman-collection.json\nLinear project "API-CORE" tracks all API bugs.\n`,
      },
      {
        filename: 'project_auth.md',
        content: `---\nname: Auth migration\ndescription: JWT auth being replaced with OAuth2 - target completion Q2 2026\ntype: project\n---\n\nMigrating from custom JWT to OAuth2 with Keycloak.\n\n**Why:** Compliance team flagged custom token handling.\n**How to apply:** New endpoints must use OAuth2 middleware from src/middleware/oauth2.ts.\n`,
      },
    ],
  },
]

// ── Seed and cleanup ──

const BACKUP_SUFFIX = '.capture-bak'
const CONFIG_FILES_TO_SEED = ['configs', 'commands', 'command-sections', 'settings', 'app-meta', 'cloud-agents']

interface BackupInfo {
  configDir: string
  backedUpFiles: string[]
  createdMemoryDirs: string[]
}

function seedSampleData(): BackupInfo {
  const configDir = getConfigDir()
  fs.mkdirSync(configDir, { recursive: true })
  console.log(`[capture] Config dir: ${configDir}`)

  const backedUpFiles: string[] = []

  // Map of config key to filename and data
  const fileMap: Record<string, { filename: string; data: unknown }> = {
    configs: { filename: 'configs.json', data: SAMPLE_CONFIGS },
    commands: { filename: 'commands.json', data: SAMPLE_COMMANDS },
    'command-sections': { filename: 'command-sections.json', data: SAMPLE_COMMAND_SECTIONS },
    settings: { filename: 'settings.json', data: SAMPLE_SETTINGS },
    'app-meta': { filename: 'app-meta.json', data: SAMPLE_APP_META },
    'cloud-agents': { filename: 'cloud-agents.json', data: SAMPLE_CLOUD_AGENTS },
  }

  for (const [key, { filename, data }] of Object.entries(fileMap)) {
    const filePath = path.join(configDir, filename)
    // Backup existing
    if (fs.existsSync(filePath)) {
      const backupPath = filePath + BACKUP_SUFFIX
      fs.copyFileSync(filePath, backupPath)
      backedUpFiles.push(filePath)
      console.log(`[capture] Backed up: ${filename}`)
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
    console.log(`[capture] Seeded: ${filename}`)
  }

  // Seed memory files
  const createdMemoryDirs: string[] = []
  const projectsDir = getClaudeProjectsDir()

  for (const project of SAMPLE_MEMORY_PROJECTS) {
    const memoryDir = path.join(projectsDir, project.projectDir, 'memory')
    const existed = fs.existsSync(memoryDir)
    fs.mkdirSync(memoryDir, { recursive: true })
    if (!existed) createdMemoryDirs.push(path.join(projectsDir, project.projectDir))

    // Write MEMORY.md index
    const indexLines = project.files.map(f => `- [${f.filename.replace('.md', '')}](${f.filename})`).join('\n')
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), `# Memory Index\n\n${indexLines}\n`, 'utf-8')

    for (const file of project.files) {
      fs.writeFileSync(path.join(memoryDir, file.filename), file.content, 'utf-8')
    }
    console.log(`[capture] Seeded memory: ${project.projectDir} (${project.files.length} files)`)
  }

  return { configDir, backedUpFiles, createdMemoryDirs }
}

function cleanupSampleData(info: BackupInfo): void {
  console.log('[capture] Cleaning up sample data...')

  // Restore config files
  const fileMap: Record<string, string> = {
    configs: 'configs.json',
    commands: 'commands.json',
    'command-sections': 'command-sections.json',
    settings: 'settings.json',
    'app-meta': 'app-meta.json',
    'cloud-agents': 'cloud-agents.json',
  }

  for (const [key, filename] of Object.entries(fileMap)) {
    const filePath = path.join(info.configDir, filename)
    const backupPath = filePath + BACKUP_SUFFIX
    try {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, filePath)
        fs.unlinkSync(backupPath)
        console.log(`[capture] Restored: ${filename}`)
      } else {
        // No backup means we created it — remove it
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      }
    } catch (err) {
      console.warn(`[capture] Warning: failed to restore ${filename}: ${err}`)
    }
  }

  // Clean up memory files
  const projectsDir = getClaudeProjectsDir()
  for (const project of SAMPLE_MEMORY_PROJECTS) {
    const memoryDir = path.join(projectsDir, project.projectDir, 'memory')
    try {
      // Only delete files we created
      for (const file of project.files) {
        const fp = path.join(memoryDir, file.filename)
        if (fs.existsSync(fp)) fs.unlinkSync(fp)
      }
      const indexPath = path.join(memoryDir, 'MEMORY.md')
      if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath)
    } catch (err) {
      console.warn(`[capture] Warning: failed to clean memory ${project.projectDir}: ${err}`)
    }
  }

  // Remove empty dirs we created
  for (const dir of info.createdMemoryDirs) {
    try {
      const memDir = path.join(dir, 'memory')
      if (fs.existsSync(memDir) && fs.readdirSync(memDir).length === 0) fs.rmdirSync(memDir)
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
    } catch { /* ignore */ }
  }

  console.log('[capture] Cleanup complete.')
}

// ── Helpers ──

async function clickNav(window: any, label: string): Promise<void> {
  const clicked = await window.evaluate((lbl: string) => {
    const buttons = document.querySelectorAll('button')
    for (const btn of buttons) {
      if (btn.title === lbl || btn.title?.startsWith(lbl) || btn.textContent?.trim() === lbl) {
        btn.click()
        return true
      }
    }
    return false
  }, label)
  if (!clicked) console.log(`[capture] WARNING: Could not find nav button "${label}"`)
  await window.waitForTimeout(1000)
}

async function clickTab(window: any, text: string): Promise<void> {
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
  if (!clicked) console.log(`[capture] WARNING: Could not find tab "${text}"`)
  await window.waitForTimeout(500)
}

async function goToSessions(window: any): Promise<void> {
  // Click Sessions nav or use a sidebar button
  const clicked = await window.evaluate(() => {
    // Try clicking a session tab first
    const tabs = document.querySelectorAll('[class*="tab"]')
    for (const tab of tabs) {
      if (tab instanceof HTMLElement) {
        tab.click()
        return true
      }
    }
    // Try the Sessions sidebar icon (cloud icon, first nav button)
    const buttons = document.querySelectorAll('button')
    for (const btn of buttons) {
      if (btn.title === 'Sessions' || btn.textContent?.includes('Sessions')) {
        btn.click()
        return true
      }
    }
    return false
  })
  await window.waitForTimeout(800)
}

async function dismissModals(window: any): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await window.keyboard.press('Escape')
    await window.waitForTimeout(400)
  }
  // Also dismiss any fixed overlays programmatically
  await window.evaluate(() => {
    const overlays = document.querySelectorAll('.fixed.inset-0')
    overlays.forEach(el => {
      const closeBtn = el.querySelector('button')
      if (closeBtn) closeBtn.click()
    })
  })
  await window.waitForTimeout(300)
}

async function capture(window: any, filename: string, description: string): Promise<void> {
  const platformFilename = PLATFORM_SUFFIX
    ? filename.replace('.jpg', `${PLATFORM_SUFFIX}.jpg`)
    : filename
  const outputPath = path.join(SCREENSHOT_DIR, platformFilename)
  await window.screenshot({
    path: outputPath,
    type: 'jpeg',
    quality: JPEG_QUALITY,
  })
  console.log(`[capture] Saved: ${platformFilename} (${description})`)
}

// ── Main capture sequence ──

async function main() {
  const backupInfo = seedSampleData()

  try {
    console.log('[capture] Launching Electron app...')
    const app = await electron.launch({
      args: [BUILT_APP],
      env: { ...process.env, NODE_ENV: 'production' },
    })

    const window = await app.firstWindow()
    await window.setViewportSize({ width: WIDTH, height: HEIGHT })

    console.log('[capture] Waiting for app to load...')
    await window.waitForTimeout(6000)
    await dismissModals(window)

    // ── Step 1: Welcome — sessions view with sidebar showing configs ──
    await capture(window, 'step-welcome.jpg', 'Welcome / sessions overview with sidebar')

    // ── Step 2: Terminal Configs — same view, shows sidebar configs ──
    await capture(window, 'step-terminal-configs.jpg', 'Sidebar with terminal configs')

    // ── Step 3: Sessions — launch a session so terminal is visible ──
    // Double-click the first config to launch it
    const launched = await window.evaluate(() => {
      // Find config list items and click the first one to launch
      const configItems = document.querySelectorAll('[class*="sidebar"] button, [class*="config"] button')
      for (const item of configItems) {
        const el = item as HTMLElement
        if (el.title?.includes('Launch') || el.title?.includes('Start')) {
          el.click()
          return true
        }
      }
      // Try double-clicking the first config label
      const labels = document.querySelectorAll('[class*="config"]')
      for (const label of labels) {
        if (label instanceof HTMLElement && label.textContent && !label.textContent.includes('SAVED')) {
          const dblClick = new MouseEvent('dblclick', { bubbles: true })
          label.dispatchEvent(dblClick)
          return true
        }
      }
      return false
    })
    if (launched) {
      console.log('[capture] Launched session, waiting for terminal...')
      await window.waitForTimeout(5000)
    }
    await capture(window, 'step-sessions.jpg', 'Active session with terminal')

    // ── Step 4: Commands — session view with command bar visible ──
    await capture(window, 'step-commands.jpg', 'Quick commands bar')

    // ── Step 5: Agent Hub ──
    await clickNav(window, 'Agent Hub')
    await window.waitForTimeout(500)
    await capture(window, 'step-agent-hub.jpg', 'Agent Hub page')

    // ── Step 6: Statusline — go back to sessions, show context bar ──
    await goToSessions(window)
    await window.waitForTimeout(500)
    await capture(window, 'step-statusline.jpg', 'Statusline / context bar')

    // ── Step 7: Vision ──
    await clickNav(window, 'Vision')
    await capture(window, 'step-vision.jpg', 'Vision system page')

    // ── Step 8: Tokenomics ──
    await clickNav(window, 'Tokenomics')
    await capture(window, 'step-tokenomics.jpg', 'Tokenomics page')

    // ── Step 9: Memory Visualiser ──
    await clickNav(window, 'Memory')
    await window.waitForTimeout(3000) // Memory scan is async
    await capture(window, 'step-memory.jpg', 'Memory Visualiser page')

    // ── Step 10: Storyboard — session view with command bar ──
    await goToSessions(window)
    await window.waitForTimeout(500)
    await capture(window, 'step-storyboard.jpg', 'Command bar with Storyboard button')

    // ── Step 11: Session Options — open config edit dialog ──
    // Right-click or click edit on a config
    const dialogOpened = await window.evaluate(() => {
      // Try to find an edit button in the sidebar
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        if (btn.title === 'Edit' || btn.title === 'Edit config') {
          btn.click()
          return true
        }
      }
      // Try right-clicking a config label
      const configLabels = document.querySelectorAll('[class*="config-label"], [class*="sidebar"] span')
      for (const label of configLabels) {
        if (label instanceof HTMLElement && label.textContent && !label.textContent.includes('SAVED') && !label.textContent.includes('ACTIVE')) {
          const evt = new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 })
          label.dispatchEvent(evt)
          return true
        }
      }
      return false
    })
    if (dialogOpened) {
      await window.waitForTimeout(1000)
      // If context menu appeared, click "Edit" option
      await window.evaluate(() => {
        const menuItems = document.querySelectorAll('[class*="menu"] button, [class*="dropdown"] button, [class*="context"] button, [role="menuitem"]')
        for (const item of menuItems) {
          if (item.textContent?.trim() === 'Edit') {
            (item as HTMLElement).click()
            return
          }
        }
      })
      await window.waitForTimeout(800)
    }
    await capture(window, 'step-session-options.jpg', 'Session options dialog')
    await window.keyboard.press('Escape')
    await window.waitForTimeout(500)

    // ── Step 12: Screenshots — session view with Snap button visible ──
    await goToSessions(window)
    await window.waitForTimeout(500)
    await capture(window, 'step-screenshots.jpg', 'Screenshot / Snap button area')

    // ── Step 13: Security — Settings > General tab ──
    await clickNav(window, 'Settings')
    await window.waitForTimeout(500)
    await capture(window, 'step-security.jpg', 'Settings page (security section)')

    // ── Step 14: Tips — Settings > Shortcuts tab ──
    await clickTab(window, 'Shortcuts')
    await window.waitForTimeout(500)
    await capture(window, 'step-tips.jpg', 'Shortcuts / tips')

    console.log('[capture] Closing app...')
    await app.close()
  } finally {
    cleanupSampleData(backupInfo)
  }

  console.log('\n[capture] Done! All screenshots captured.')
  console.log('[capture] Run `npm run build` to include them in the app.')
}

main().catch((err) => {
  console.error('[capture] Error:', err)
  // Try cleanup even on error
  try {
    const configDir = getConfigDir()
    cleanupSampleData({ configDir, backedUpFiles: [], createdMemoryDirs: [] })
  } catch { /* ignore */ }
  process.exit(1)
})
