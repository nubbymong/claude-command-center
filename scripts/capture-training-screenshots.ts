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
// Setting CAPTURE_NO_PLATFORM_SUFFIX=1 forces no -mac suffix even on darwin,
// useful when you want the Mac run to produce the canonical filenames the
// README + training-steps.ts reference (no-suffix). Defaults preserve the
// historical platform tagging so the per-platform reconcile flow stays
// untouched.
const PLATFORM_SUFFIX =
  process.env.CAPTURE_NO_PLATFORM_SUFFIX === '1'
    ? ''
    : process.platform === 'darwin'
      ? '-mac'
      : ''
const WIDTH = 1280
const HEIGHT = 800
const JPEG_QUALITY = 85

// P8.18: redact account identity during capture so generated screenshots
// don't leak the user's email. Forces a stable placeholder colour for
// visual consistency across captured environments.
function redactAccountInStatusline(sl: any) {
  if (sl) {
    sl.accountEmail = 'you@example.com'
    sl.accountColour = 'periwinkle'
  }
}

// ── Config directory resolution ──

function readRegistryValue(name: 'ResourcesDirectory' | 'DataDirectory'): string | null {
  if (process.platform !== 'win32') return null
  for (const key of ['Software\\Claude Command Center', 'Software\\Claude Conductor']) {
    try {
      const result = execSync(`reg query "HKCU\\${key}" /v ${name}`, { encoding: 'utf-8', timeout: 5000, windowsHide: true })
      const match = result.match(new RegExp(`${name}\\s+REG_SZ\\s+(.+)`))
      if (match) return match[1].trim()
    } catch { /* try next */ }
  }
  return null
}

function getResourcesDir(): string {
  const fromReg = readRegistryValue('ResourcesDirectory')
  if (fromReg) return fromReg
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude Conductor')
  }
  const fallbackFile = path.join(os.homedir(), '.claude-conductor', 'platform-config.json')
  try {
    if (fs.existsSync(fallbackFile)) {
      const config = JSON.parse(fs.readFileSync(fallbackFile, 'utf-8'))
      if (config.ResourcesDirectory) return config.ResourcesDirectory
      if (config.DataDirectory) return config.DataDirectory
    }
  } catch {}
  return path.join(os.homedir(), 'Library', 'Application Support', 'Claude Conductor')
}

function getDataDir(): string {
  const fromReg = readRegistryValue('DataDirectory')
  if (fromReg) return fromReg
  // Defaults match getDefaultDataDir() in src/main/ipc/setup-handlers.ts
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude Conductor')
  }
  const fallbackFile = path.join(os.homedir(), '.claude-conductor', 'platform-config.json')
  try {
    if (fs.existsSync(fallbackFile)) {
      const config = JSON.parse(fs.readFileSync(fallbackFile, 'utf-8'))
      if (config.DataDirectory) return config.DataDirectory
      if (config.ResourcesDirectory) return config.ResourcesDirectory
    }
  } catch {}
  return path.join(os.homedir(), 'Library', 'Application Support', 'Claude Conductor')
}

function getConfigDir(): string {
  return path.join(getResourcesDir(), 'CONFIG')
}

// ── Sample data ──

// Use sanitized paths — never expose real OS username in screenshots
const homePath = process.platform === 'win32'
  ? 'C:\\Users\\developer\\Projects'
  : '/Users/developer/Projects'

// All demo configs use shellOnly so capture works on hosts without claude.exe
// installed. Demo-mobile has a partnerTerminalPath set so the combined-mode
// screenshot can render both panes side-by-side.
const PARTNER_SHELL = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'

const SAMPLE_CONFIGS = [
  { id: 'demo-webapp', label: 'Web App', workingDirectory: path.join(homePath, 'web-app'), model: '', color: '#89B4FA', sessionType: 'local', shellOnly: true },
  { id: 'demo-api', label: 'API Server', workingDirectory: path.join(homePath, 'api-server'), model: '', color: '#A6E3A1', sessionType: 'local', shellOnly: true },
  { id: 'demo-mobile', label: 'Mobile App', workingDirectory: path.join(homePath, 'mobile'), model: '', color: '#F9E2AF', sessionType: 'local', shellOnly: true, partnerTerminalPath: PARTNER_SHELL },
  { id: 'demo-infra', label: 'Infrastructure', workingDirectory: path.join(homePath, 'infra'), model: '', color: '#CBA6F7', sessionType: 'local', shellOnly: true },
  { id: 'demo-gpu', label: 'GPU Server', workingDirectory: '/home/developer/ml-pipeline', model: '', color: '#F38BA8', sessionType: 'ssh', shellOnly: true, sshConfig: { host: '10.0.1.50', port: 22, username: 'developer', remotePath: '/home/developer/ml-pipeline' } },
  // Codex provider demo. shellOnly so capture works on hosts without codex
  // installed; the Edit dialog renders CodexFormFields based purely on the
  // saved provider/codexOptions, no live spawn required for the screenshot.
  { id: 'demo-codex', label: 'Codex Provider', workingDirectory: path.join(homePath, 'codex-demo'), color: '#F9E2AF', sessionType: 'local', shellOnly: true, provider: 'codex', codexOptions: { model: 'gpt-5.5', reasoningEffort: 'medium', permissionsPreset: 'standard' } },
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
    linkedIssues: true,
    notifications: true,
    localGit: true,
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
const LOCK_FILENAME = '.capture.lock'

interface BackupInfo {
  configDir: string
  backedUpFiles: string[]      // orig existed; backed up to .capture-bak; needs restore
  createdDemoFiles: string[]   // orig didn't exist; we wrote demo data; safe to delete
  createdMemoryDirs: string[]
  projectsRenamed: boolean
  codexSessionsRenamed: boolean
  insightsRenamed: boolean
  logsRenamed: boolean
  lockPath: string
}

// Module-level state so the top-level error handler can clean up partial work
// even if seedSampleData throws mid-flight. Assigned at the START of seed,
// then mutated in place as each backup/write succeeds.
let activeBackupInfo: BackupInfo | null = null

// Demo content fingerprints — IDs and markers we know are unique to demo data.
// cleanupSampleData uses these to verify a file is demo content BEFORE deleting,
// so a misclassified file can never be unlinked.
const DEMO_FINGERPRINTS: Record<string, string[]> = {
  'configs.json': ['demo-webapp', 'demo-api', 'demo-mobile'],
  'commands.json': ['demo-cmd-review', 'demo-cmd-test'],
  'command-sections.json': ['demo-section-dev'],
  'cloud-agents.json': ['demo-agent-1', 'demo-agent-2'],
  'tokenomics.json': ['demo-s1', 'demo-s2'],
  'github-config.json': ['demo-github-profile'],
  'settings.json': ['Dev Workstation', 'Mac Mini'],
  'app-meta.json': ['"setupVersion": "99.99.99"'],
}

function isDemoContent(filePath: string, content: string): boolean {
  const filename = path.basename(filePath)
  const markers = DEMO_FINGERPRINTS[filename] ?? []
  if (markers.length === 0) return false
  return markers.some(m => content.includes(m))
}

function acquireCaptureLock(configDir: string): string {
  const lockPath = path.join(configDir, LOCK_FILENAME)
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
    return lockPath
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      let holder = '?'
      try { holder = fs.readFileSync(lockPath, 'utf-8') } catch {}
      throw new Error(
        `[capture] Lock held by PID ${holder} at ${lockPath}. ` +
        `Another capture is already running. If you are CERTAIN it is not, ` +
        `delete the lock file manually and retry.`
      )
    }
    throw err
  }
}

function releaseCaptureLock(lockPath: string): void {
  try {
    if (fs.existsSync(lockPath)) {
      const holder = fs.readFileSync(lockPath, 'utf-8')
      // Only release if WE hold it — never delete another process's lock
      if (holder === String(process.pid)) fs.unlinkSync(lockPath)
    }
  } catch {}
}

function seedSampleData(): BackupInfo {
  const configDir = getConfigDir()
  fs.mkdirSync(configDir, { recursive: true })
  console.log(`[capture] Config dir: ${configDir}`)

  // Acquire the exclusive capture lock. If another capture is already running
  // (e.g. accidental concurrent invocation) this throws BEFORE any backup or
  // write. Without this guard, two captures would race in cleanup and could
  // delete each other's restored originals.
  const lockPath = acquireCaptureLock(configDir)
  console.log(`[capture] Acquired lock: ${lockPath}`)

  // Initialize state immediately so the top-level error handler can clean up
  // whatever partial work is done by the time anything below throws.
  activeBackupInfo = {
    configDir,
    backedUpFiles: [],
    createdDemoFiles: [],
    createdMemoryDirs: [],
    projectsRenamed: false,
    codexSessionsRenamed: false,
    insightsRenamed: false,
    logsRenamed: false,
    lockPath,
  }

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
    // Mark seed complete + recent lastSync so seedTokenomics/syncTokenomics
    // skip the project-folder scan that would otherwise pull in real
    // Claude/Codex history (and overwrite tokenomics.json with 15+MB of it).
    seedComplete: true,
    lastSyncTimestamp: now,
    totalCostUsd: 4.46,
  }

  // P8.18: scrub any account identity baked into the seeded sessions before
  // they hit disk. The helper is idempotent and sets the field if absent so
  // it's safe to call on every record.
  for (const session of sampleTokenomics.sessions) {
    redactAccountInStatusline(session)
  }

  const fileMap: Record<string, unknown> = {
    'configs.json': SAMPLE_CONFIGS,
    'commands.json': SAMPLE_COMMANDS,
    'command-sections.json': SAMPLE_SECTIONS,
    'settings.json': { localMachineName: 'Demo Workstation', terminalFontSize: 14, updateChannel: 'stable', colourMigrationNoticeDismissed: true, colourMigrationNoticePending: false },
    'app-meta.json': { setupVersion: '99.99.99', lastTrainingVersion: '99.99.99', lastWhatsNewVersion: '99.99.99', lastSeenVersion: '99.99.99' },
    'cloud-agents.json': SAMPLE_CLOUD_AGENTS,
    'tokenomics.json': sampleTokenomics,
    'github-config.json': SAMPLE_GITHUB_CONFIG,
  }

  for (const [filename, data] of Object.entries(fileMap)) {
    const filePath = path.join(configDir, filename)
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, filePath + BACKUP_SUFFIX)
      activeBackupInfo.backedUpFiles.push(filePath)
      console.log(`[capture] Backed up: ${filename}`)
    } else {
      // No prior file — we're creating fresh demo content. Track so cleanup
      // can safely delete it (and ONLY it, after fingerprint verification).
      activeBackupInfo.createdDemoFiles.push(filePath)
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  // Temporarily hide real projects so only demo ones appear in screenshots.
  // Rename ~/.claude/projects/ → ~/.claude/projects-real-bak/ during capture.
  // Fail loudly if a leftover backup exists -- silently continuing would let
  // real session data leak into screenshots (and confuse the cleanup step).
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  const projectsBackup = projectsDir + '-real-bak'
  if (fs.existsSync(projectsBackup)) {
    throw new Error(
      `[capture] Refusing to start: ${projectsBackup} already exists from a prior crashed capture. ` +
      `Move its contents back into ${projectsDir} (or delete it if you don't need them) before re-running.`
    )
  }
  if (fs.existsSync(projectsDir)) {
    fs.renameSync(projectsDir, projectsBackup)
    activeBackupInfo.projectsRenamed = true
    console.log('[capture] Hid real projects directory')
  }
  fs.mkdirSync(projectsDir, { recursive: true })

  // Same treatment for Codex history -- seedTokenomics scans ~/.codex/sessions/
  // and would otherwise pull all real Codex transcripts into screenshots.
  const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions')
  const codexSessionsBackup = codexSessionsDir + '-real-bak'
  if (fs.existsSync(codexSessionsBackup)) {
    throw new Error(
      `[capture] Refusing to start: ${codexSessionsBackup} already exists from a prior crashed capture. ` +
      `Move its contents back into ${codexSessionsDir} (or delete it if you don't need them) before re-running.`
    )
  }
  if (fs.existsSync(codexSessionsDir)) {
    fs.renameSync(codexSessionsDir, codexSessionsBackup)
    activeBackupInfo.codexSessionsRenamed = true
    console.log('[capture] Hid real Codex sessions directory')
  }

  // Insights reports live at <RESOURCES>/insights/ as one dir per run -- the
  // Insights page renders the latest report. Without hiding, real KPIs and
  // project names from the user's history leak into screenshots.
  const insightsDir = path.join(getResourcesDir(), 'insights')
  const insightsBackup = insightsDir + '-real-bak'
  if (fs.existsSync(insightsBackup)) {
    throw new Error(
      `[capture] Refusing to start: ${insightsBackup} already exists from a prior crashed capture. ` +
      `Move its contents back into ${insightsDir} (or delete it if you don't need them) before re-running.`
    )
  }
  if (fs.existsSync(insightsDir)) {
    fs.renameSync(insightsDir, insightsBackup)
    activeBackupInfo.insightsRenamed = true
    console.log('[capture] Hid real Insights directory')
  }

  // Session logs live at <DATA>/logs/<configLabel>/<sessionId>/ -- the Logs
  // page renders the configLabel folders, leaking real session names.
  const logsDir = path.join(getDataDir(), 'logs')
  const logsBackup = logsDir + '-real-bak'
  if (fs.existsSync(logsBackup)) {
    throw new Error(
      `[capture] Refusing to start: ${logsBackup} already exists from a prior crashed capture. ` +
      `Move its contents back into ${logsDir} (or delete it if you don't need them) before re-running.`
    )
  }
  if (fs.existsSync(logsDir)) {
    // Best-effort: if the live CCC instance has open handles in logs/ (it
    // streams session logs continuously), the rename will EPERM on Windows.
    // We don't want that to abort the whole capture -- accept the leak,
    // record nothing renamed, and proceed.
    try {
      fs.renameSync(logsDir, logsBackup)
      activeBackupInfo.logsRenamed = true
      console.log('[capture] Hid real session logs directory')
    } catch (err: any) {
      if (err && err.code === 'EPERM') {
        console.warn('[capture] Could not hide session logs directory (live CCC holding handles). Logs page screenshot may show real session names.')
      } else {
        throw err
      }
    }
  }

  for (const project of SAMPLE_MEMORY_PROJECTS) {
    const memoryDir = path.join(projectsDir, project.projectDir, 'memory')
    fs.mkdirSync(memoryDir, { recursive: true })
    activeBackupInfo.createdMemoryDirs.push(path.join(projectsDir, project.projectDir))
    const indexLines = project.files.map(f => `- [${f.filename.replace('.md', '')}](${f.filename})`).join('\n')
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), `# Memory Index\n\n${indexLines}\n`, 'utf-8')
    for (const file of project.files) fs.writeFileSync(path.join(memoryDir, file.filename), file.content, 'utf-8')
    console.log(`[capture] Seeded memory: ${project.projectDir}`)
  }

  return activeBackupInfo
}

function cleanupSampleData(info: BackupInfo | null): void {
  if (info === null) {
    console.log('[capture] No active backup state — nothing to clean up')
    return
  }
  console.log('[capture] Cleaning up...')

  // Restore each file we explicitly backed up. info.backedUpFiles is the
  // single source of truth — never iterate over a hardcoded filename list.
  for (const filePath of info.backedUpFiles) {
    const backupPath = filePath + BACKUP_SUFFIX
    try {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, filePath)
        fs.unlinkSync(backupPath)
      } else {
        // Backup is missing for whatever reason. NEVER delete the orig as a
        // fallback — the user's real data may still be there. Just log and
        // leave it alone; the worst case is demo data sticks around.
        console.warn(`[capture] Backup missing for ${filePath} — leaving file untouched (real data may still be present)`)
      }
    } catch (err) {
      console.error(`[capture] Failed to restore ${filePath}:`, err)
    }
  }

  // Delete files we created where there was no prior orig. We tracked these
  // in createdDemoFiles, so deletion is bounded — but verify content matches
  // a known demo fingerprint before unlinking. Defensive: if the file has
  // somehow been replaced with non-demo content (e.g. user wrote to it during
  // the capture window), leave it.
  for (const filePath of info.createdDemoFiles) {
    try {
      if (!fs.existsSync(filePath)) continue
      const content = fs.readFileSync(filePath, 'utf-8')
      if (isDemoContent(filePath, content)) {
        fs.unlinkSync(filePath)
      } else {
        console.warn(`[capture] Refusing to delete ${filePath} — content does not match demo fingerprint`)
      }
    } catch (err) {
      console.error(`[capture] Failed to delete demo file ${filePath}:`, err)
    }
  }

  // Restore real projects directory
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  const projectsBackup = projectsDir + '-real-bak'
  if (info.projectsRenamed) {
    try {
      if (!fs.existsSync(projectsBackup)) {
        console.warn('[capture] projects-real-bak directory missing; skipping restore to protect real data')
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
    // We only created demo projects (no real ones to restore) — clean those up
    for (const dir of info.createdMemoryDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }

  // Restore real Codex sessions directory
  if (info.codexSessionsRenamed) {
    const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions')
    const codexSessionsBackup = codexSessionsDir + '-real-bak'
    try {
      if (!fs.existsSync(codexSessionsBackup)) {
        console.warn('[capture] codex sessions-real-bak missing; skipping restore to protect real data')
      } else {
        if (fs.existsSync(codexSessionsDir)) fs.rmSync(codexSessionsDir, { recursive: true, force: true })
        fs.renameSync(codexSessionsBackup, codexSessionsDir)
        console.log('[capture] Restored real Codex sessions directory')
      }
    } catch (err) {
      console.error('[capture] WARNING: Failed to restore Codex sessions directory!', err)
      console.error(`[capture] Your real Codex sessions are at: ${codexSessionsBackup}`)
    }
  }

  // Restore real Insights directory
  if (info.insightsRenamed) {
    const insightsDir = path.join(getResourcesDir(), 'insights')
    const insightsBackup = insightsDir + '-real-bak'
    try {
      if (!fs.existsSync(insightsBackup)) {
        console.warn('[capture] insights-real-bak missing; skipping restore to protect real data')
      } else {
        if (fs.existsSync(insightsDir)) fs.rmSync(insightsDir, { recursive: true, force: true })
        fs.renameSync(insightsBackup, insightsDir)
        console.log('[capture] Restored real Insights directory')
      }
    } catch (err) {
      console.error('[capture] WARNING: Failed to restore Insights directory!', err)
      console.error(`[capture] Your real Insights are at: ${insightsBackup}`)
    }
  }

  // Restore real session logs directory
  if (info.logsRenamed) {
    const logsDir = path.join(getDataDir(), 'logs')
    const logsBackup = logsDir + '-real-bak'
    try {
      if (!fs.existsSync(logsBackup)) {
        console.warn('[capture] logs-real-bak missing; skipping restore to protect real data')
      } else {
        if (fs.existsSync(logsDir)) fs.rmSync(logsDir, { recursive: true, force: true })
        fs.renameSync(logsBackup, logsDir)
        console.log('[capture] Restored real session logs directory')
      }
    } catch (err) {
      console.error('[capture] WARNING: Failed to restore logs directory!', err)
      console.error(`[capture] Your real logs are at: ${logsBackup}`)
    }
  }

  // Release lock LAST so a crashed / aborted cleanup can't free the lock for
  // a parallel capture that would then race against half-restored files.
  releaseCaptureLock(info.lockPath)
  activeBackupInfo = null

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
  // First pass: Escape covers the dialogs that wire one in.
  for (let i = 0; i < 4; i++) { await window.keyboard.press('Escape'); await window.waitForTimeout(400) }
  // Second pass: the What's New modal does not bind Escape; it needs an
  // explicit click on its "Got it" button (or any "Close" / "Skip" / "X"
  // button on similar one-shot modals). Walk visible buttons and click
  // anything that looks like a dismiss action; the demo seed sets
  // lastWhatsNewVersion to 99.99.99 so this should rarely fire, but the
  // setupVersion bump cycle can still re-trigger it.
  for (let i = 0; i < 3; i++) {
    const clicked = await window.evaluate(() => {
      const targets = ['Got it', 'Close', 'Skip', 'Dismiss', 'OK']
      const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]
      for (const b of buttons) {
        const text = (b.textContent || '').trim()
        if (b.offsetParent !== null && targets.includes(text)) {
          b.click()
          return true
        }
      }
      return false
    })
    if (!clicked) break
    await window.waitForTimeout(400)
  }
}

/** Launch a session by clicking the Launch button on the matching config
 *  row. Each ConfigRow has hover-revealed Launch / Pin / Edit / Delete
 *  buttons, all titled identically — we find the right one by walking
 *  from the label span up to the row container, then querying within. */
async function launchSessionFromSidebar(window: any, label: string): Promise<void> {
  const launched = await window.evaluate((l: string) => {
    const spans = Array.from(document.querySelectorAll('span'))
    for (const s of spans) {
      if (s.textContent?.trim() !== l) continue
      // Walk up to the config row container (the hoverable parent)
      let row: HTMLElement | null = s as HTMLElement
      for (let i = 0; i < 8 && row; i++) {
        if (row.querySelector('button[title="Launch"]')) break
        row = row.parentElement
      }
      if (!row) continue
      const launchBtn = row.querySelector('button[title="Launch"]') as HTMLElement | null
      if (launchBtn) { launchBtn.click(); return true }
    }
    return false
  }, label)
  if (!launched) console.log(`[capture] WARNING: config "${label}" not found in sidebar`)
  else console.log(`[capture] Launched session: ${label}`)
  // Wait for terminal to mount + xterm to render the prompt
  await window.waitForTimeout(2500)
}

/** Click a button in the active session's toolbar by its title attribute. */
async function clickToolbarButton(window: any, titleStartsWith: string): Promise<boolean> {
  return await window.evaluate((tp: string) => {
    const buttons = Array.from(document.querySelectorAll('button'))
    for (const btn of buttons) {
      if (btn.title?.startsWith(tp) && btn.offsetParent !== null) {
        btn.click()
        return true
      }
    }
    return false
  }, titleStartsWith)
}

/** Close all open sessions to reset state between captures. */
async function closeAllSessions(window: any): Promise<void> {
  await window.evaluate(() => {
    // Hover each session tab and click the × close button
    const closeButtons = Array.from(document.querySelectorAll('button[title="Close session"], button[title^="Close"]'))
    for (const btn of closeButtons) (btn as HTMLElement).click()
  })
  await window.waitForTimeout(500)
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
  // v1.5.13 README hero block - dedicated asset so the in-app tour for
  // dynamic-workflows can point at the right surface rather than aliasing
  // step-agent-hub.jpg.
  'step-dynamic-workflows.jpg': 'dynamic-workflows.jpg',
  'v2-shell-hero.jpg': 'v2-shell-hero.jpg',
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
    // v1.5.13: seed the dialog state so the captured screenshot actually
    // shows the Claude controls (Opus 4.8 model, Ultracode effort). The Edit
    // dialog opened on a "shellOnly:true" config so the Claude options are
    // hidden by default - we have to uncheck Shell only FIRST (the Claude
    // controls are conditionally rendered).
    // All DOM mutation must live in a single inline anonymous arrow
    // because esbuild/tsx names const-assigned arrows which triggers
    // __name in the evaluate context.
    await window.evaluate(() => {
      const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'))
      for (const cb of cbs) {
        const lbl = cb.closest('label')?.textContent || ''
        if (lbl.includes('Shell only')) {
          if ((cb as HTMLInputElement).checked) (cb as HTMLInputElement).click()
          break
        }
      }
    })
    await window.waitForTimeout(400)
    await window.evaluate(() => {
      // Native value setter trick - React 18 reads value via the prototype
      // descriptor, so a plain sel.value = 'opus' will not fire onChange.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
      const selects = Array.from(document.querySelectorAll('select'))
      let modelSel: HTMLSelectElement | null = null
      let effortSel: HTMLSelectElement | null = null
      for (const s of selects) {
        const labelText = (s.previousElementSibling?.textContent || '') + ' ' + (s.closest('div')?.textContent || '')
        if (!modelSel && /Model override/i.test(labelText)) modelSel = s as HTMLSelectElement
        if (!effortSel && /Effort level/i.test(labelText)) effortSel = s as HTMLSelectElement
      }
      if (modelSel && setter) {
        setter.call(modelSel, 'opus')
        modelSel.dispatchEvent(new Event('change', { bubbles: true }))
      }
      if (effortSel && setter) {
        setter.call(effortSel, 'ultracode')
        effortSel.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    await window.waitForTimeout(500)
    await capture(window, 'step-session-options.jpg', 'Session config dialog (Opus 4.8 + Ultracode)')
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

    // Step 1b: Codex Provider -- open Edit on the Codex demo config so the
    // SessionDialog surfaces ProviderSegmentedControl + CodexFormFields
    // (model dropdown, permissions preset, reasoning effort). Right-click
    // the config label to get the context menu, then click Edit. Mirrors
    // the fallback path used above for Web App / API Server.
    await window.evaluate(() => {
      const spans = document.querySelectorAll('span')
      for (const s of spans) {
        if (s.textContent === 'Codex Provider') {
          s.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 }))
          return
        }
      }
    })
    await window.waitForTimeout(800)
    await window.evaluate(() => {
      const items = document.querySelectorAll('[role="menuitem"], button')
      for (const el of items) { if (el.textContent?.trim() === 'Edit') { (el as HTMLElement).click(); return } }
    })
    await window.waitForTimeout(800)
    await capture(window, 'step-codex.jpg', 'Codex provider edit dialog (CodexFormFields visible)')
    // Close dialog
    await window.keyboard.press('Escape')
    await window.waitForTimeout(300)
    await window.keyboard.press('Escape')
    await window.waitForTimeout(300)
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

    // Step 5: Insights (sidebar nav, distinct from Tokenomics)
    await clickNav(window, 'Insights')
    await window.waitForTimeout(800)
    await capture(window, 'step-insights.jpg', 'Insights page')

    // Step 6: Memory
    await clickNav(window, 'Memory')
    await window.waitForTimeout(3000) // async scan
    await capture(window, 'step-memory.jpg', 'Memory Visualiser')

    // Step 7: Logs (no historical sessions seeded — empty state still shows
    // the chrome which is what we want for the tour shot)
    await clickNav(window, 'Logs')
    await window.waitForTimeout(800)
    await capture(window, 'step-logs.jpg', 'Logs page')

    // Step 8: Settings (Security)
    await clickNav(window, 'Settings')
    await window.waitForTimeout(500)
    await capture(window, 'step-security.jpg', 'Settings page')

    // Step 8a (v1.5.13): Dynamic Workflows toggle - on the Settings General
    // tab, scroll the Security section into view so the "Disable Claude Code
    // dynamic workflows" checkbox is centered. Capture as dedicated asset
    // so the dynamic-workflows tour step stops aliasing step-agent-hub.jpg.
    await clickTab(window, 'General')
    await window.waitForTimeout(400)
    await window.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label'))
      const target = labels.find((l) => (l.textContent || '').includes('Disable Claude Code dynamic workflows'))
      if (target) target.scrollIntoView({ block: 'center' })
    })
    await window.waitForTimeout(500)
    await capture(window, 'step-dynamic-workflows.jpg', 'Settings General - Disable Claude Code dynamic workflows toggle')

    // Step 9: Tips (Shortcuts tab)
    await clickTab(window, 'Shortcuts')
    await window.waitForTimeout(500)
    await capture(window, 'step-tips.jpg', 'Shortcuts tab')

    // Step 10: GitHub sidebar (Settings > GitHub tab)
    // Captured here because the full panel needs a running sync and cached
    // PR/CI data that we can't reliably seed without network access. The
    // Settings page is the user's entry point per the onboarding modal and
    // tips — most visually meaningful no-network shot for the tour.
    await clickTab(window, 'GitHub')
    await window.waitForTimeout(600)
    await capture(window, 'github-panel.jpg', 'Settings > GitHub tab (onboarding entry point)')

    // ── Session-required captures (Excalidraw / Snap / Combined) ──
    // Launch the simpler "Web App" config first so its toolbar is the
    // active one. Excalidraw + Snap buttons live in CommandBar inside
    // TerminalView and only render for the active session.
    await launchSessionFromSidebar(window, 'Web App')
    await window.waitForTimeout(1500)

    // Debug: list visible button titles so we can see what actually rendered
    const visibleButtons = await window.evaluate(() => {
      return Array.from(document.querySelectorAll('button'))
        .filter((b) => (b as HTMLElement).offsetParent !== null)
        .map((b) => b.title)
        .filter((t) => t)
        .slice(0, 60)
    })
    console.log('[capture] Visible buttons:', visibleButtons.join(' | '))

    // Snap — click Snap button to surface the dropdown menu (Rectangle /
    // Window). Capture the dropdown, NOT the rectangle overlay (which is
    // a separate Electron window).
    const snapClicked = await clickToolbarButton(window, 'Take Screenshot')
    if (snapClicked) {
      await window.waitForTimeout(500)
      await capture(window, 'step-snap.jpg', 'Snap dropdown menu')
      await window.keyboard.press('Escape')
      await window.waitForTimeout(300)
    } else {
      console.log('[capture] WARNING: Snap button not found, skipping')
    }

    // Excalidraw — click Draw button to swap terminal for the canvas
    const drawClicked = await clickToolbarButton(window, 'Open Excalidraw')
    if (drawClicked) {
      await window.waitForTimeout(1500) // canvas mount + welcome state
      await capture(window, 'step-excalidraw.jpg', 'Excalidraw scratchpad')
      // Toggle off
      await clickToolbarButton(window, 'Hide Excalidraw')
      await window.waitForTimeout(400)
    } else {
      console.log('[capture] WARNING: Excalidraw button not found, skipping')
    }

    // Combined mode: launch the partner-enabled "Mobile App" config.
    // The split-view renders both Claude pane + partner shell side-by-side.
    await launchSessionFromSidebar(window, 'Mobile App')
    await window.waitForTimeout(2500)
    await capture(window, 'step-combined.jpg', 'Combined mode (Claude + partner)')

    // v1.5.13 V2 README hero: capture the full shell with multiple live
    // sessions in the sidebar, the active terminal in the main pane, and
    // the statusline strip lit. Launches an additional "API Server" on
    // top of the already-running Web App + Mobile App so the sidebar
    // shows a three-deep active list. Active focus stays on API Server
    // (the most recently launched) - the previous version re-launched
    // Web App to "switch focus" but that created a duplicate sidebar
    // entry.
    await launchSessionFromSidebar(window, 'API Server')
    await window.waitForTimeout(2500)
    await capture(window, 'v2-shell-hero.jpg', 'V2 hero - multi-session shell + active terminal + statusline')

    // Webview is intentionally skipped — requires a real URL that loads,
    // and the WebContentsView overlay does not surface in Playwright
    // screenshots reliably. Tour falls back to the legacy bullet view.

    console.log('[capture] Closing app...')
    // app.close() opens a graceful-shutdown race; if Electron does not
    // exit within ~5s we SIGKILL the underlying node-spawned process so
    // it does not leave a window hanging on the user's screen. Playwright
    // exposes the child via app.process().
    const child = app.process()
    let closed = false
    await Promise.race([
      app.close().then(() => { closed = true }),
      new Promise<void>((r) => setTimeout(r, 5000)),
    ])
    if (!closed) {
      console.warn('[capture] app.close() did not finish in 5s -- SIGKILL')
      try { child.kill('SIGKILL') } catch {}
    }
  } finally {
    cleanupSampleData(backupInfo)
  }

  console.log('\n[capture] All screenshots captured.')
}

main().catch((err) => {
  console.error('[capture] Error:', err)
  // Use the real activeBackupInfo populated incrementally by seedSampleData.
  // Never fabricate one here — a fabricated info with no backedUpFiles would
  // have caused the old cleanup to iterate a hardcoded filename list and
  // destructively unlink files we never owned. With activeBackupInfo, cleanup
  // only touches what seedSampleData actually backed up or created.
  try { cleanupSampleData(activeBackupInfo) } catch {}
  process.exit(1)
})
