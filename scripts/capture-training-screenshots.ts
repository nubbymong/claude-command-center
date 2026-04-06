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
const PLATFORM_SUFFIX = process.platform === 'darwin' ? '-mac' : ''
const WIDTH = 1280
const HEIGHT = 800
const JPEG_QUALITY = 85

// ── Config directory resolution ──

function getConfigDir(): string {
  if (process.platform === 'win32') {
    for (const key of ['Software\\Claude Command Center', 'Software\\Claude Conductor']) {
      try {
        const result = execSync(`reg query "HKCU\\${key}" /v ResourcesDirectory`, { encoding: 'utf-8', timeout: 5000, windowsHide: true })
        const match = result.match(/ResourcesDirectory\s+REG_SZ\s+(.+)/)
        if (match) return path.join(match[1].trim(), 'CONFIG')
      } catch { /* try next */ }
    }
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude Conductor', 'CONFIG')
  } else {
    const fallbackFile = path.join(os.homedir(), '.claude-conductor', 'platform-config.json')
    try {
      if (fs.existsSync(fallbackFile)) {
        const config = JSON.parse(fs.readFileSync(fallbackFile, 'utf-8'))
        if (config.ResourcesDirectory) return path.join(config.ResourcesDirectory, 'CONFIG')
        if (config.DataDirectory) return path.join(config.DataDirectory, 'CONFIG')
      }
    } catch {}
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude Conductor', 'CONFIG')
  }
}

// ── Sample data ──

const homePath = process.platform === 'win32'
  ? `C:\\Users\\${os.userInfo().username}\\Projects`
  : `${os.homedir()}/Projects`

const SAMPLE_CONFIGS = [
  { id: 'demo-webapp', label: 'Web App', workingDirectory: path.join(homePath, 'web-app'), model: '', color: '#89B4FA', sessionType: 'local' },
  { id: 'demo-api', label: 'API Server', workingDirectory: path.join(homePath, 'api-server'), model: '', color: '#A6E3A1', sessionType: 'local' },
  { id: 'demo-mobile', label: 'Mobile App', workingDirectory: path.join(homePath, 'mobile'), model: '', color: '#F9E2AF', sessionType: 'local' },
  { id: 'demo-infra', label: 'Infrastructure', workingDirectory: path.join(homePath, 'infra'), model: '', color: '#CBA6F7', sessionType: 'local' },
]

const SAMPLE_COMMANDS = [
  { id: 'demo-cmd-review', label: 'Code Review', prompt: 'Review the recent changes', scope: 'global', color: '#89B4FA', defaultArgs: ['--focus security'] },
  { id: 'demo-cmd-test', label: 'Run Tests', prompt: 'Run all tests and fix failures', scope: 'global', color: '#A6E3A1', defaultArgs: [] },
  { id: 'demo-cmd-docs', label: 'Update Docs', prompt: 'Update documentation', scope: 'global', color: '#F9E2AF', defaultArgs: [] },
]

const SAMPLE_CLOUD_AGENTS = [
  {
    id: 'demo-agent-1', name: 'API Documentation Generator',
    description: 'Generate OpenAPI documentation for all REST endpoints',
    status: 'completed', createdAt: Date.now() - 900000, updatedAt: Date.now() - 300000,
    projectPath: path.join(homePath, 'api-server'),
    output: 'Generated OpenAPI 3.0 spec for 12 endpoints.\nCreated docs/openapi.yaml (245 lines).',
    cost: 0.42, duration: 600000, tokenUsage: { inputTokens: 15000, outputTokens: 8500 },
  },
  {
    id: 'demo-agent-2', name: 'Security Audit',
    description: 'Scan for OWASP top 10 vulnerabilities',
    status: 'completed', createdAt: Date.now() - 1200000, updatedAt: Date.now() - 600000,
    projectPath: path.join(homePath, 'web-app'),
    output: 'Scanned 47 files. Found 0 critical, 2 medium issues.',
    cost: 0.68, duration: 900000, tokenUsage: { inputTokens: 22000, outputTokens: 12000 },
  },
]

const SAMPLE_MEMORY_PROJECTS = [
  {
    projectDir: 'demo-web-app',
    files: [
      { filename: 'user_preferences.md', content: `---\nname: User preferences\ndescription: Developer prefers functional components and Tailwind CSS\ntype: user\n---\n\nSenior full-stack developer. Prefers React functional components with hooks.\n` },
      { filename: 'project_architecture.md', content: `---\nname: Architecture overview\ndescription: Next.js app with Prisma ORM and PostgreSQL\ntype: project\n---\n\nNext.js 14 with App Router. Prisma ORM connecting to PostgreSQL.\n\n**Why:** Migrated from Express to Next.js for SSR benefits.\n**How to apply:** All new API routes go in app/api/.\n` },
      { filename: 'feedback_testing.md', content: `---\nname: Testing approach\ndescription: Integration tests preferred over unit tests with mocks\ntype: feedback\n---\n\nUse integration tests hitting a real test database, not mocks.\n\n**Why:** Prior incident where mocked tests passed but production migration failed.\n` },
    ],
  },
  {
    projectDir: 'demo-api-server',
    files: [
      { filename: 'reference_docs.md', content: `---\nname: API documentation\ndescription: Swagger docs at /api-docs, Postman collection in docs/\ntype: reference\n---\n\nSwagger UI available at http://localhost:3000/api-docs\n` },
      { filename: 'project_auth.md', content: `---\nname: Auth migration\ndescription: JWT auth being replaced with OAuth2\ntype: project\n---\n\nMigrating from custom JWT to OAuth2 with Keycloak.\n\n**Why:** Compliance team flagged custom token handling.\n` },
    ],
  },
]

// ── Seed and cleanup ──

const BACKUP_SUFFIX = '.capture-bak'

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
  const fileMap: Record<string, unknown> = {
    'configs.json': SAMPLE_CONFIGS,
    'commands.json': SAMPLE_COMMANDS,
    'command-sections.json': [{ id: 'demo-section', name: 'Development' }],
    'settings.json': { localMachineName: process.platform === 'darwin' ? 'Mac Mini' : 'Dev Workstation', terminalFontSize: 14, updateChannel: 'stable' },
    'app-meta.json': { setupVersion: '99.99.99', lastTrainingVersion: '99.99.99', lastWhatsNewVersion: '99.99.99', lastSeenVersion: '99.99.99' },
    'cloud-agents.json': SAMPLE_CLOUD_AGENTS,
  }

  for (const [filename, data] of Object.entries(fileMap)) {
    const filePath = path.join(configDir, filename)
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, filePath + BACKUP_SUFFIX)
      backedUpFiles.push(filePath)
      console.log(`[capture] Backed up: ${filename}`)
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  const createdMemoryDirs: string[] = []
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  for (const project of SAMPLE_MEMORY_PROJECTS) {
    const memoryDir = path.join(projectsDir, project.projectDir, 'memory')
    const existed = fs.existsSync(memoryDir)
    fs.mkdirSync(memoryDir, { recursive: true })
    if (!existed) createdMemoryDirs.push(path.join(projectsDir, project.projectDir))
    const indexLines = project.files.map(f => `- [${f.filename.replace('.md', '')}](${f.filename})`).join('\n')
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), `# Memory Index\n\n${indexLines}\n`, 'utf-8')
    for (const file of project.files) fs.writeFileSync(path.join(memoryDir, file.filename), file.content, 'utf-8')
    console.log(`[capture] Seeded memory: ${project.projectDir}`)
  }

  return { configDir, backedUpFiles, createdMemoryDirs }
}

function cleanupSampleData(info: BackupInfo): void {
  console.log('[capture] Cleaning up...')
  const files = ['configs.json', 'commands.json', 'command-sections.json', 'settings.json', 'app-meta.json', 'cloud-agents.json']
  for (const filename of files) {
    const filePath = path.join(info.configDir, filename)
    const backupPath = filePath + BACKUP_SUFFIX
    try {
      if (fs.existsSync(backupPath)) { fs.copyFileSync(backupPath, filePath); fs.unlinkSync(backupPath) }
      else if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch {}
  }
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  for (const project of SAMPLE_MEMORY_PROJECTS) {
    const memoryDir = path.join(projectsDir, project.projectDir, 'memory')
    try {
      for (const file of project.files) { const fp = path.join(memoryDir, file.filename); if (fs.existsSync(fp)) fs.unlinkSync(fp) }
      const idx = path.join(memoryDir, 'MEMORY.md'); if (fs.existsSync(idx)) fs.unlinkSync(idx)
    } catch {}
  }
  for (const dir of info.createdMemoryDirs) {
    try {
      const memDir = path.join(dir, 'memory')
      if (fs.existsSync(memDir) && fs.readdirSync(memDir).length === 0) fs.rmdirSync(memDir)
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
    } catch {}
  }
  console.log('[capture] Done.')
}

// ── Helpers ──

/** Click a nav button by its title attribute */
async function clickNav(window: any, label: string): Promise<void> {
  // Try exact title match first, then startsWith
  const clicked = await window.evaluate((lbl: string) => {
    const buttons = Array.from(document.querySelectorAll('button'))
    // Exact match
    for (const btn of buttons) {
      if (btn.title === lbl) { btn.click(); return true }
    }
    // StartsWith match (for "2 agents running" etc)
    for (const btn of buttons) {
      if (btn.title?.startsWith(lbl)) { btn.click(); return true }
    }
    return false
  }, label)
  if (!clicked) console.log(`[capture] WARNING: nav button "${label}" not found`)
  else console.log(`[capture] Nav -> ${label}`)
  await window.waitForTimeout(1200)
}

/** Click a tab button by text */
async function clickTab(window: any, text: string): Promise<void> {
  await window.evaluate((txt: string) => {
    const buttons = document.querySelectorAll('button')
    for (const btn of buttons) { if (btn.textContent?.trim() === txt) { btn.click(); return } }
  }, text)
  await window.waitForTimeout(500)
}

async function dismissModals(window: any): Promise<void> {
  for (let i = 0; i < 4; i++) { await window.keyboard.press('Escape'); await window.waitForTimeout(400) }
}

async function capture(window: any, filename: string, description: string): Promise<void> {
  const platformFilename = PLATFORM_SUFFIX ? filename.replace('.jpg', `${PLATFORM_SUFFIX}.jpg`) : filename
  await window.screenshot({ path: path.join(SCREENSHOT_DIR, platformFilename), type: 'jpeg', quality: JPEG_QUALITY })
  console.log(`[capture] Saved: ${platformFilename} (${description})`)
}

// ── Main ──

async function main() {
  const backupInfo = seedSampleData()

  try {
    console.log('[capture] Launching Electron app...')
    const app = await electron.launch({ args: [BUILT_APP], env: { ...process.env, NODE_ENV: 'production' } })
    const window = await app.firstWindow()
    await window.setViewportSize({ width: WIDTH, height: HEIGHT })
    console.log('[capture] Waiting for app to load...')
    await window.waitForTimeout(6000)
    await dismissModals(window)

    // Step 1: Session Options — open edit dialog on first config
    await window.evaluate(() => {
      const items = document.querySelectorAll('button')
      for (const btn of items) {
        if (btn.title === 'Edit' || btn.title === 'Edit config') { btn.click(); return }
      }
      // Fallback: right-click first config label to get context menu, then click Edit
      const spans = document.querySelectorAll('span')
      for (const s of spans) {
        if (s.textContent === 'Web App' || s.textContent === 'API Server') {
          s.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 150 }))
          return
        }
      }
    })
    await window.waitForTimeout(1000)
    // If context menu, click Edit
    await window.evaluate(() => {
      const items = document.querySelectorAll('[role="menuitem"], button')
      for (const el of items) { if (el.textContent?.trim() === 'Edit') { (el as HTMLElement).click(); return } }
    })
    await window.waitForTimeout(800)
    await capture(window, 'step-session-options.jpg', 'Session config dialog')
    // Close dialog — try multiple methods
    await window.keyboard.press('Escape')
    await window.waitForTimeout(300)
    await window.keyboard.press('Escape')
    await window.waitForTimeout(300)
    // Also click any close/cancel button
    await window.evaluate(() => {
      const overlays = document.querySelectorAll('.fixed')
      overlays.forEach(el => el.remove())
    })
    await window.waitForTimeout(500)

    // Step 2: Agent Hub
    await clickNav(window, 'Agent Hub')
    // Click first agent to show detail panel
    await window.evaluate(() => {
      const cards = document.querySelectorAll('[class*="cursor-pointer"], [class*="agent"]')
      for (const card of cards) {
        if (card instanceof HTMLElement && card.textContent?.includes('API Documentation')) {
          card.click(); return
        }
      }
    })
    await window.waitForTimeout(500)
    await capture(window, 'step-agent-hub.jpg', 'Agent Hub with detail')

    // Step 3: Vision
    await clickNav(window, 'Vision')
    await capture(window, 'step-vision.jpg', 'Vision page')

    // Step 4: Tokenomics
    await clickNav(window, 'Tokenomics')
    await capture(window, 'step-tokenomics.jpg', 'Tokenomics page')

    // Step 5: Memory
    await clickNav(window, 'Memory')
    await window.waitForTimeout(3000) // async scan
    await capture(window, 'step-memory.jpg', 'Memory Visualiser')

    // Step 6: Settings (Security)
    await clickNav(window, 'Settings')
    await window.waitForTimeout(500)
    await capture(window, 'step-security.jpg', 'Settings page')

    // Step 7: Tips (Shortcuts tab)
    await clickTab(window, 'Shortcuts')
    await window.waitForTimeout(500)
    await capture(window, 'step-tips.jpg', 'Shortcuts tab')

    console.log('[capture] Closing app...')
    await app.close()
  } finally {
    cleanupSampleData(backupInfo)
  }

  console.log('\n[capture] All screenshots captured.')
}

main().catch((err) => {
  console.error('[capture] Error:', err)
  try { cleanupSampleData({ configDir: getConfigDir(), backedUpFiles: [], createdMemoryDirs: [] }) } catch {}
  process.exit(1)
})
