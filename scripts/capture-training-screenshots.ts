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

// Use sanitized paths — never expose real OS username in screenshots
const homePath = process.platform === 'win32'
  ? 'C:\\Users\\developer\\Projects'
  : '/Users/developer/Projects'

const SAMPLE_CONFIGS = [
  { id: 'demo-webapp', label: 'Web App', workingDirectory: path.join(homePath, 'web-app'), model: '', color: '#89B4FA', sessionType: 'local' },
  { id: 'demo-api', label: 'API Server', workingDirectory: path.join(homePath, 'api-server'), model: '', color: '#A6E3A1', sessionType: 'local' },
  { id: 'demo-mobile', label: 'Mobile App', workingDirectory: path.join(homePath, 'mobile'), model: '', color: '#F9E2AF', sessionType: 'local' },
  { id: 'demo-infra', label: 'Infrastructure', workingDirectory: path.join(homePath, 'infra'), model: '', color: '#CBA6F7', sessionType: 'local' },
  { id: 'demo-gpu', label: 'GPU Server', workingDirectory: '/home/developer/ml-pipeline', model: '', color: '#F38BA8', sessionType: 'ssh', sshConfig: { host: '10.0.1.50', port: 22, username: 'developer', remotePath: '/home/developer/ml-pipeline' } },
]

const SAMPLE_COMMANDS = [
  { id: 'demo-cmd-review', label: 'Code Review', prompt: 'Review the recent changes', scope: 'global', color: '#89B4FA', defaultArgs: ['--focus security'], sectionId: 'demo-section-dev' },
  { id: 'demo-cmd-test', label: 'Run Tests', prompt: 'Run all tests and fix failures', scope: 'global', color: '#A6E3A1', defaultArgs: [], sectionId: 'demo-section-dev' },
  { id: 'demo-cmd-docs', label: 'Update Docs', prompt: 'Update documentation', scope: 'global', color: '#F9E2AF', defaultArgs: [] },
  { id: 'demo-cmd-deploy', label: 'Deploy Staging', prompt: 'Deploy to staging environment', scope: 'global', color: '#F38BA8', target: 'partner', sectionId: 'demo-section-ops' },
  { id: 'demo-cmd-git', label: 'Git Status', prompt: 'git status', scope: 'global', color: '#CBA6F7', target: 'partner' },
]

const SAMPLE_SECTIONS = [
  { id: 'demo-section-dev', name: 'Development', scope: 'global', target: 'claude', color: '#89B4FA' },
  { id: 'demo-section-ops', name: 'Operations', scope: 'global', target: 'partner', color: '#F38BA8' },
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

// Fake GitHub config + auth profile for the Settings > GitHub screenshot.
// The "token" entry here is a label only — the real token lives in OS
// credential storage and is not captured in the JSON file. These fields
// populate the AuthProfilesList render so the screenshot shows a realistic
// signed-in state instead of the empty "No auth profiles yet" placeholder.
// Importantly: no real usernames, repo owners, or tokens in this demo.
const SAMPLE_GITHUB_CONFIG = {
  schemaVersion: 1,
  authProfiles: {
    'demo-github-profile': {
      id: 'demo-github-profile',
      kind: 'oauth' as const,
      label: 'developer',
      username: 'developer',
      scopes: ['repo', 'notifications'],
      capabilities: ['pulls', 'issues', 'contents', 'statuses', 'checks', 'actions', 'notifications'],
      createdAt: Date.now() - 86_400_000,
      lastVerifiedAt: Date.now() - 3_600_000,
      expiryObservable: false,
      rateLimits: {
        core: { limit: 5000, remaining: 4732, resetAt: Date.now() + 1800_000, capturedAt: Date.now() },
      },
    },
  },
  defaultAuthProfileId: 'demo-github-profile',
  featureToggles: {
    sessionContext: true,
    activePR: true,
    ci: true,
    reviews: true,
    issues: true,
    notifications: true,
    localGit: true,
    agentIntent: false,
  },
  syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 300 },
  enabledByDefault: false,
  transcriptScanningOptIn: false,
}

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
  projectsRenamed: boolean
}

function seedSampleData(): BackupInfo {
  const configDir = getConfigDir()
  fs.mkdirSync(configDir, { recursive: true })
  console.log(`[capture] Config dir: ${configDir}`)

  const backedUpFiles: string[] = []
  // Generate realistic tokenomics data with sanitized project names
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const sampleTokenomics = {
    sessions: [
      { sessionId: 'demo-s1', projectDir: 'web-app', model: 'claude-sonnet-4-5-20250514', firstTimestamp: now - 2 * 3600000, lastTimestamp: now - 1800000, totalInputTokens: 45000, totalOutputTokens: 18000, cacheReadTokens: 12000, cacheWriteTokens: 8000, totalCostUsd: 0.42, durationMs: 5400000 },
      { sessionId: 'demo-s2', projectDir: 'api-server', model: 'claude-sonnet-4-5-20250514', firstTimestamp: now - 8 * 3600000, lastTimestamp: now - 6 * 3600000, totalInputTokens: 82000, totalOutputTokens: 35000, cacheReadTokens: 25000, cacheWriteTokens: 15000, totalCostUsd: 0.89, durationMs: 7200000 },
      { sessionId: 'demo-s3', projectDir: 'web-app', model: 'claude-opus-4-5-20250514', firstTimestamp: now - day - 3600000, lastTimestamp: now - day, totalInputTokens: 120000, totalOutputTokens: 55000, cacheReadTokens: 40000, cacheWriteTokens: 20000, totalCostUsd: 3.15, durationMs: 3600000 },
    ],
    dailyAggregates: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(i => {
      const d = new Date(now - i * day).toISOString().slice(0, 10)
      const costs = [1.31, 3.15, 2.47, 1.89, 4.22, 0.95, 2.78]
      const tokens = [127000, 120000, 95000, 78000, 165000, 45000, 110000]
      const sessions = [2, 1, 3, 2, 4, 1, 3]
      return [d, { date: d, totalCostUsd: costs[i], totalTokens: tokens[i], messageCount: sessions[i] * 15, sessionCount: sessions[i], totalDurationMs: 0, avgCostPerHour: 0, byModel: {} }]
    })),
    lastSeeded: now,
  }

  const fileMap: Record<string, unknown> = {
    'configs.json': SAMPLE_CONFIGS,
    'commands.json': SAMPLE_COMMANDS,
    'command-sections.json': SAMPLE_SECTIONS,
    'settings.json': { localMachineName: process.platform === 'darwin' ? 'Mac Mini' : 'Dev Workstation', terminalFontSize: 14, updateChannel: 'stable' },
    'app-meta.json': { setupVersion: '99.99.99', lastTrainingVersion: '99.99.99', lastWhatsNewVersion: '99.99.99', lastSeenVersion: '99.99.99' },
    'cloud-agents.json': SAMPLE_CLOUD_AGENTS,
    'tokenomics.json': sampleTokenomics,
    'github-config.json': SAMPLE_GITHUB_CONFIG,
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

  // Temporarily hide real projects so only demo ones appear in screenshots.
  // Rename ~/.claude/projects/ → ~/.claude/projects-real-bak/ during capture.
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  const projectsBackup = projectsDir + '-real-bak'
  let projectsRenamed = false
  if (fs.existsSync(projectsDir)) {
    fs.renameSync(projectsDir, projectsBackup)
    projectsRenamed = true
    console.log('[capture] Hid real projects directory')
  }
  fs.mkdirSync(projectsDir, { recursive: true })

  const createdMemoryDirs: string[] = []
  for (const project of SAMPLE_MEMORY_PROJECTS) {
    const memoryDir = path.join(projectsDir, project.projectDir, 'memory')
    fs.mkdirSync(memoryDir, { recursive: true })
    createdMemoryDirs.push(path.join(projectsDir, project.projectDir))
    const indexLines = project.files.map(f => `- [${f.filename.replace('.md', '')}](${f.filename})`).join('\n')
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), `# Memory Index\n\n${indexLines}\n`, 'utf-8')
    for (const file of project.files) fs.writeFileSync(path.join(memoryDir, file.filename), file.content, 'utf-8')
    console.log(`[capture] Seeded memory: ${project.projectDir}`)
  }

  return { configDir, backedUpFiles, createdMemoryDirs, projectsRenamed }
}

function cleanupSampleData(info: BackupInfo): void {
  console.log('[capture] Cleaning up...')
  const files = ['configs.json', 'commands.json', 'command-sections.json', 'settings.json', 'app-meta.json', 'cloud-agents.json', 'tokenomics.json', 'github-config.json']
  for (const filename of files) {
    const filePath = path.join(info.configDir, filename)
    const backupPath = filePath + BACKUP_SUFFIX
    try {
      if (fs.existsSync(backupPath)) { fs.copyFileSync(backupPath, filePath); fs.unlinkSync(backupPath) }
      else if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch {}
  }
  // Restore real projects directory
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  const projectsBackup = projectsDir + '-real-bak'
  if (info.projectsRenamed) {
    try {
      // CRITICAL: verify the backup exists BEFORE removing projectsDir.
      // The error-path caller in main() passes a fabricated
      // `projectsRenamed: true`, so a failure before seedSampleData
      // actually ran the rename would otherwise destroy the user's real
      // projects and then fail to restore them.
      if (!fs.existsSync(projectsBackup)) {
        console.warn('[capture] Backup directory missing; skipping restore to protect real data')
      } else {
        fs.rmSync(projectsDir, { recursive: true, force: true })
        fs.renameSync(projectsBackup, projectsDir)
        console.log('[capture] Restored real projects directory')
      }
    } catch (err) {
      console.error('[capture] WARNING: Failed to restore projects directory!', err)
      console.error(`[capture] Your real projects are at: ${projectsBackup}`)
      console.error('[capture] Manually rename it back to: ' + projectsDir)
    }
  } else {
    // Just clean up demo projects
    for (const dir of info.createdMemoryDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
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

const DOCS_SCREENSHOT_DIR = path.join(__dirname, '..', 'docs', 'screenshots')

// Map from training filenames to docs filenames (for README screenshots)
const DOCS_COPY_MAP: Record<string, string> = {
  'step-session-options.jpg': 'session-config.jpg',
  'step-tokenomics.jpg': 'tokenomics.jpg',
  'step-memory.jpg': 'memory.jpg',
  'step-agent-hub.jpg': 'agent-hub.jpg',
  'step-vision.jpg': 'vision.jpg',
  'step-security.jpg': 'settings.jpg',
  'step-tips.jpg': 'shortcuts.jpg',
}

async function capture(window: any, filename: string, description: string): Promise<void> {
  const platformFilename = PLATFORM_SUFFIX ? filename.replace('.jpg', `${PLATFORM_SUFFIX}.jpg`) : filename
  const trainingPath = path.join(SCREENSHOT_DIR, platformFilename)
  await window.screenshot({ path: trainingPath, type: 'jpeg', quality: JPEG_QUALITY })
  console.log(`[capture] Saved: ${platformFilename} (${description})`)

  // Also copy to docs/screenshots/ if this file maps to a docs screenshot
  const docsName = DOCS_COPY_MAP[filename]
  if (docsName) {
    const docsPlatformName = PLATFORM_SUFFIX ? docsName.replace('.jpg', `${PLATFORM_SUFFIX}.jpg`) : docsName
    fs.mkdirSync(DOCS_SCREENSHOT_DIR, { recursive: true })
    fs.copyFileSync(trainingPath, path.join(DOCS_SCREENSHOT_DIR, docsPlatformName))
    console.log(`[capture]   -> docs/screenshots/${docsPlatformName}`)
  }
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

    // Step 8: GitHub sidebar (Settings > GitHub tab)
    // Captured here because the full panel needs a running sync and cached
    // PR/CI data that we can't reliably seed without network access. The
    // Settings page is the user's entry point per the onboarding modal and
    // tips — most visually meaningful no-network shot for the tour.
    await clickTab(window, 'GitHub')
    await window.waitForTimeout(600)
    await capture(window, 'github-panel.jpg', 'Settings > GitHub tab (onboarding entry point)')

    console.log('[capture] Closing app...')
    await app.close()
  } finally {
    cleanupSampleData(backupInfo)
  }

  console.log('\n[capture] All screenshots captured.')
}

main().catch((err) => {
  console.error('[capture] Error:', err)
  try { cleanupSampleData({ configDir: getConfigDir(), backedUpFiles: [], createdMemoryDirs: [], projectsRenamed: true }) } catch {}
  process.exit(1)
})
