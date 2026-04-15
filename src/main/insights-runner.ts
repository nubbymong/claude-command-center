import { join } from 'path'
import { homedir } from 'os'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  statSync
} from 'fs'
import { spawn } from 'child_process'
import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { logInfo, logError } from './debug-logger'
import { resolveClaudeForPty } from './pty-manager'
import { getProjectRootPath, getInstallPath } from './update-watcher'
import { getResourcesDirectory } from './ipc/setup-handlers'
import { readConfig } from './config-manager'

// Source locations (Claude CLI output)
const CLAUDE_REPORT = join(homedir(), '.claude', 'usage-data', 'report.html')
const CLAUDE_FACETS = join(homedir(), '.claude', 'usage-data', 'facets')

// Dynamic paths based on data directory
function getInsightsDir(): string { return join(getResourcesDirectory(), 'insights') }
function getCatalogueFile(): string { return join(getInsightsDir(), 'catalogue.json') }

export interface InsightsRun {
  id: string            // timestamp-based: '2026-02-06-143022'
  timestamp: number     // Date.now()
  status: 'running' | 'extracting_kpis' | 'complete' | 'failed'
  statusMessage?: string  // e.g. "Step 1/3: Generating report..."
  error?: string
}

export interface InsightsCatalogue {
  runs: InsightsRun[]
}

let running = false

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function generateRunId(): string {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function loadCatalogue(): InsightsCatalogue {
  try {
    const catalogueFile = getCatalogueFile()
    if (existsSync(catalogueFile)) {
      return JSON.parse(readFileSync(catalogueFile, 'utf-8'))
    }
  } catch { /* ignore */ }
  return { runs: [] }
}

function saveCatalogue(catalogue: InsightsCatalogue): void {
  ensureDir(getInsightsDir())
  writeFileSync(getCatalogueFile(), JSON.stringify(catalogue, null, 2))
}

function notifyRenderer(getWindow: () => BrowserWindow | null, run: InsightsRun): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('insights:statusChanged', run)
  }
}

function copyReportToArchive(archiveDir: string): boolean {
  try {
    if (!existsSync(CLAUDE_REPORT)) {
      logError('[insights] report.html not found at ' + CLAUDE_REPORT)
      return false
    }
    copyFileSync(CLAUDE_REPORT, join(archiveDir, 'report.html'))

    // Copy facets if they exist
    if (existsSync(CLAUDE_FACETS)) {
      const facetsTarget = join(archiveDir, 'facets')
      ensureDir(facetsTarget)
      const files = readdirSync(CLAUDE_FACETS)
      for (const file of files) {
        if (file.endsWith('.json')) {
          copyFileSync(join(CLAUDE_FACETS, file), join(facetsTarget, file))
        }
      }
    }
    return true
  } catch (err) {
    logError('[insights] Failed to copy report:', err)
    return false
  }
}

/**
 * Strip ANSI escape sequences for reliable text detection.
 * Handles CSI (including private mode ?), OSC, charset selection, and other sequences.
 */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[\x20-\x3f]*[0-9;]*[\x20-\x7e]/g, '')  // CSI sequences (including ?...)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')       // OSC sequences
    .replace(/\x1b[()][A-Z0-9]/g, '')                          // Character set selection
    .replace(/\x1b[>=]/g, '')                                   // Keypad/cursor mode
}

/**
 * Find a working directory that Claude already trusts.
 * Prefers: install path (already in ~/.claude/projects/) > source path (dev) > homedir
 */
function findTrustedCwd(): string {
  // 1. Try the install path — already trusted by Claude in production
  const installPath = getInstallPath()
  if (installPath && existsSync(installPath)) {
    logInfo(`[insights] Using install path as CWD: ${installPath}`)
    return installPath
  }

  // 2. Try the app's source path (dev mode — user has definitely used Claude here)
  const sourcePath = getProjectRootPath()
  if (sourcePath && existsSync(sourcePath)) {
    logInfo(`[insights] Using source path as CWD: ${sourcePath}`)
    return sourcePath
  }

  // 3. Fallback to homedir
  logInfo('[insights] No trusted CWD found, using homedir')
  return homedir()
}

/**
 * Spawn Claude interactively via node-pty, type /insights, wait for report.html to update, then /exit.
 * This is needed because /insights is a TUI slash command, not a CLI argument.
 */
function spawnClaudeInsights(timeoutMs = 600000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const { cmd } = resolveClaudeForPty()
    const cwd = findTrustedCwd()
    logInfo(`[insights] Spawning Claude PTY for /insights: ${cmd} in ${cwd}`)

    const proc = pty.spawn(cmd, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: process.env as Record<string, string>,
      useConpty: false
    })

    let output = ''
    let resolved = false
    let trustHandled = false
    let commandSent = false
    let exitSent = false
    let dataChunks = 0
    let trustEnterAttempts = 0

    // Record initial mtime of report.html (0 if doesn't exist yet)
    let initialMtime = 0
    try {
      if (existsSync(CLAUDE_REPORT)) {
        initialMtime = statSync(CLAUDE_REPORT).mtimeMs
      }
    } catch { /* ignore */ }
    logInfo(`[insights] Initial report.html mtime: ${initialMtime}`)

    const cleanup = () => {
      clearTimeout(timeout)
      clearTimeout(startupFallback)
      clearInterval(pollInterval)
    }

    const sendInsights = () => {
      if (commandSent || resolved) return
      commandSent = true
      pollStartTime = Date.now()
      clearTimeout(startupFallback)
      logInfo('[insights] Sending /insights to PTY')
      proc.write('/insights\r')
    }

    const acceptTrustPrompt = () => {
      if (commandSent || resolved) return
      trustEnterAttempts++
      logInfo(`[insights] Accepting trust prompt (attempt ${trustEnterAttempts})...`)
      // Send Enter to confirm the pre-selected "Yes" option
      proc.write('\r')
      // If first attempt doesn't work, try again after a delay
      if (trustEnterAttempts < 3) {
        setTimeout(() => {
          if (!commandSent && !resolved) {
            acceptTrustPrompt()
          }
        }, 1500)
      }
    }

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        cleanup()
        logError(`[insights] PTY timed out after ${timeoutMs / 1000}s`)
        logError(`[insights] Last output: ${stripAnsi(output).slice(-500)}`)
        try { proc.kill() } catch { /* ignore */ }
        resolve({ code: 1, output: output + '\nTimed out after ' + (timeoutMs / 1000) + 's' })
      }
    }, timeoutMs)

    // Fallback: if prompt not detected within 20 seconds, send /insights anyway
    const startupFallback = setTimeout(() => {
      if (!commandSent && !resolved) {
        logInfo(`[insights] Startup fallback (20s), sending /insights regardless (got ${dataChunks} data chunks, trustHandled=${trustHandled})`)
        sendInsights()
      }
    }, 20000)

    // Poll for report.html changes (every 3 seconds, starting 5s after command sent)
    let pollStartTime = 0
    const pollInterval = setInterval(() => {
      if (!commandSent || exitSent || resolved) return
      if (Date.now() - pollStartTime < 5000) return // wait at least 5s after sending command

      try {
        if (existsSync(CLAUDE_REPORT)) {
          const currentMtime = statSync(CLAUDE_REPORT).mtimeMs
          if (currentMtime > initialMtime) {
            logInfo('[insights] report.html updated! Waiting 2s then sending /exit...')
            exitSent = true
            // Give it a moment to finish writing, then exit
            setTimeout(() => {
              try {
                logInfo('[insights] Sending /exit to Claude PTY')
                proc.write('/exit\r')
              } catch { /* ignore */ }
              // If it doesn't exit within 10s, kill it
              setTimeout(() => {
                if (!resolved) {
                  logInfo('[insights] Force killing PTY after /exit timeout')
                  resolved = true
                  cleanup()
                  try { proc.kill() } catch { /* ignore */ }
                  resolve({ code: 0, output })
                }
              }, 10000)
            }, 2000)
          }
        }
      } catch { /* ignore */ }
    }, 3000)

    // Accumulate full output for better prompt/trust detection
    let fullClean = ''

    proc.onData((data) => {
      output += data
      dataChunks++
      const clean = stripAnsi(data)
      fullClean += clean

      // Log first 20 chunks and then every 50th for diagnostics
      if (dataChunks <= 20 || dataChunks % 50 === 0) {
        const readable = clean.replace(/\s+/g, ' ').trim()
        if (readable.length > 0) {
          logInfo(`[insights] PTY chunk #${dataChunks}: "${readable.slice(0, 200)}"`)
        }
      }

      // Step 1: Detect trust prompt and auto-accept it
      if (!trustHandled && !commandSent) {
        const lower = fullClean.toLowerCase()
        if (lower.includes('trust') && (lower.includes('folder') || lower.includes('directory'))) {
          trustHandled = true
          logInfo('[insights] Trust prompt detected, accepting...')
          // Wait for the TUI selection to fully render, then press Enter
          setTimeout(() => acceptTrustPrompt(), 1000)
          return
        }
        // Also detect "Enter to confirm" which means the selection UI is ready
        if (lower.includes('enter to confirm')) {
          trustHandled = true
          logInfo('[insights] "Enter to confirm" detected, pressing Enter...')
          setTimeout(() => acceptTrustPrompt(), 500)
          return
        }
      }

      // Step 2: Detect the actual ">" prompt to send /insights
      if (!commandSent) {
        // Claude Code's TUI shows "> " as the input prompt
        // Check the accumulated clean text for the prompt
        const lastChunk = clean.trim()
        if (lastChunk.endsWith('>') || lastChunk.includes('> ') || />\s*$/.test(lastChunk)) {
          // If we just handled trust, wait longer for Claude to fully initialize
          const delay = trustHandled ? 3000 : 1000
          logInfo(`[insights] Prompt ">" detected (trustHandled=${trustHandled}), sending /insights in ${delay}ms...`)
          setTimeout(sendInsights, delay)
        }
      }
    })

    proc.onExit(({ exitCode }) => {
      if (!resolved) {
        resolved = true
        cleanup()
        logInfo(`[insights] PTY exited with code ${exitCode}`)
        resolve({ code: exitCode, output })
      }
    })
  })
}

function spawnClaude(args: string[], timeoutMs = 600000, stdinData?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Use native CLI (claude.exe) or npm wrapper (claude.cmd) — 'claude' with shell:true finds either
    logInfo(`[insights] Spawning: claude ${args.join(' ')}${stdinData ? ' (with stdin)' : ''}`)

    const proc = spawn('claude', args, {
      shell: true,
      windowsHide: true,
      env: { ...process.env }
    })

    // Pipe prompt via stdin if provided
    if (stdinData && proc.stdin) {
      proc.stdin.write(stdinData)
      proc.stdin.end()
    }

    let stdout = ''
    let stderr = ''
    let resolved = false

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        logError(`[insights] Timed out after ${timeoutMs / 1000}s`)
        proc.kill()
        resolve({ code: 1, stdout, stderr: stderr + '\nTimed out after ' + (timeoutMs / 1000) + 's' })
      }
    }, timeoutMs)

    proc.stdout?.on('data', (data) => { stdout += data.toString() })
    proc.stderr?.on('data', (data) => { stderr += data.toString() })

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        logError('[insights] Spawn error:', err.message)
        resolve({ code: 1, stdout, stderr: stderr + '\n' + err.message })
      }
    })

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        logInfo(`[insights] Process exited with code ${code}`)
        resolve({ code: code ?? 1, stdout, stderr })
      }
    })
  })
}

const KPI_EXTRACTION_PROMPT = `Read the HTML file at {reportPath}. Extract ALL quantifiable metrics and produce an analysis.

{previousContext}

Output a JSON object with EXACTLY this structure (no markdown fences, ONLY raw JSON):

{
  "period": { "start": "string", "end": "string", "days": number },
  "summary": {
    "improvements": ["Short bullet point about something that improved or is going well"],
    "regressions": ["Short bullet point about something that got worse or needs attention"],
    "suggestions": ["Short actionable suggestion for improving workflow"]
  },
  "kpis": {
    "CategoryName": {
      "metricKey": {
        "value": number,
        "label": "Human Readable Label",
        "format": "number|percent|duration",
        "goodDirection": "up|down|neutral"
      }
    }
  },
  "lists": {
    "Top Tools": [{ "name": "ToolName", "count": 42 }],
    "Top Languages": [{ "name": "Language", "count": 10 }],
    "Top Goals": [{ "name": "Goal", "count": 5 }]
  }
}

Rules:
- "summary" MUST have 2-5 items per array. Be specific, cite numbers. If comparing to previous data, reference the change.
- "kpis" categories: Volume, Outcomes, Satisfaction, Friction, Performance, Session Types, Multi-Clauding, and any others you find.
- Each metric includes label, format, and goodDirection so the UI can render without hardcoded metadata.
- "format": "number" for counts, "percent" for rates (0-1 scale), "duration" for milliseconds.
- "lists": include top 5-8 entries for tools, languages, goals, and any other ranked lists you find.
- If no previous data provided, base summary purely on current metrics (highlight extremes, anomalies, notable patterns).
- If previous data IS provided, focus summary on what changed — improved metrics, worsened metrics, and what to do differently.
- Output ONLY valid JSON. No explanation, no markdown.`

function loadPreviousKpis(currentRunId: string): string | null {
  try {
    const catalogue = loadCatalogue()
    const completeRuns = catalogue.runs.filter(r => r.status === 'complete' && r.id !== currentRunId)
    if (completeRuns.length === 0) return null

    const prevRun = completeRuns[completeRuns.length - 1]
    const prevKpiPath = join(getInsightsDir(), prevRun.id, 'kpis.json')
    if (!existsSync(prevKpiPath)) return null

    return readFileSync(prevKpiPath, 'utf-8')
  } catch {
    return null
  }
}

async function extractKpis(archiveDir: string, runId: string): Promise<boolean> {
  const reportPath = join(archiveDir, 'report.html').replace(/\\/g, '/')

  // Build previous context for comparison
  const prevKpis = loadPreviousKpis(runId)
  let previousContext = 'There is no previous data to compare against. Base your summary on current metrics only.'
  if (prevKpis) {
    previousContext = `PREVIOUS RUN DATA (compare against this):\n${prevKpis}\n\nCompare current metrics to previous and highlight changes in the summary.`
  }

  const prompt = KPI_EXTRACTION_PROMPT
    .replace('{reportPath}', reportPath)
    .replace('{previousContext}', previousContext)

  logInfo('[insights] Starting KPI extraction for ' + reportPath + (prevKpis ? ' (with comparison)' : ' (no previous data)'))

  // Read setting to decide whether to include --dangerously-skip-permissions
  const settings = readConfig<{ skipPermissionsForAgents?: boolean }>('settings')
  const skipPerms = settings?.skipPermissionsForAgents !== false // default true

  const spawnArgs = [
    '-p',
    '--allowedTools', 'Read',
    ...(skipPerms ? ['--dangerously-skip-permissions'] : []),
    '--output-format', 'json'
  ]

  // Pipe the prompt via stdin — passing multi-KB prompts with embedded JSON
  // as shell arguments is unreliable on Windows (quoting/escaping breaks).
  const result = await spawnClaude(spawnArgs, 600000, prompt)

  if (result.code !== 0) {
    logError('[insights] KPI extraction failed (code ' + result.code + '):', result.stderr)
    logError('[insights] stdout:', result.stdout.slice(0, 500))
    return false
  }

  try {
    // Claude with --output-format json wraps in a JSON object with "result" key
    let kpiData: unknown
    const trimmed = result.stdout.trim()

    // Try parsing directly first
    try {
      const parsed = JSON.parse(trimmed)
      // If it has a "result" key that's a string, parse that
      if (parsed.result && typeof parsed.result === 'string') {
        kpiData = JSON.parse(parsed.result)
      } else {
        kpiData = parsed
      }
    } catch {
      // Try extracting JSON from the output (might have text around it)
      const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        kpiData = JSON.parse(jsonMatch[0])
      } else {
        throw new Error('No JSON found in output')
      }
    }

    writeFileSync(join(archiveDir, 'kpis.json'), JSON.stringify(kpiData, null, 2))
    logInfo('[insights] KPIs extracted and saved')
    return true
  } catch (err) {
    logError('[insights] Failed to parse KPI output:', err)
    logError('[insights] Raw output:', result.stdout.slice(0, 500))
    return false
  }
}

export async function runInsights(getWindow: () => BrowserWindow | null): Promise<string> {
  if (running) throw new Error('Insights already running')
  running = true

  const id = generateRunId()
  const archiveDir = join(getInsightsDir(), id)
  ensureDir(archiveDir)

  const catalogue = loadCatalogue()
  const run: InsightsRun = { id, timestamp: Date.now(), status: 'running' }
  catalogue.runs.push(run)
  saveCatalogue(catalogue)
  notifyRenderer(getWindow, run)

  try {
    // Step 1: Run /insights via interactive PTY
    run.statusMessage = 'Step 1/3: Generating report...'
    saveCatalogue(catalogue)
    notifyRenderer(getWindow, run)
    logInfo('[insights] Running /insights via PTY...')
    const result = await spawnClaudeInsights()

    if (result.code !== 0) {
      run.status = 'failed'
      run.error = 'claude /insights failed: ' + stripAnsi(result.output).slice(-200)
      saveCatalogue(catalogue)
      notifyRenderer(getWindow, run)
      running = false
      return id
    }

    // Step 2: Copy report to archive
    run.statusMessage = 'Step 2/3: Archiving report...'
    saveCatalogue(catalogue)
    notifyRenderer(getWindow, run)
    if (!copyReportToArchive(archiveDir)) {
      run.status = 'failed'
      run.error = 'Failed to copy report files'
      saveCatalogue(catalogue)
      notifyRenderer(getWindow, run)
      running = false
      return id
    }

    // Step 3: Extract KPIs
    run.status = 'extracting_kpis'
    run.statusMessage = 'Step 3/3: Extracting KPIs...'
    saveCatalogue(catalogue)
    notifyRenderer(getWindow, run)

    const kpiSuccess = await extractKpis(archiveDir, id)
    if (!kpiSuccess) {
      // KPI extraction is non-fatal — report is still viewable
      logError('[insights] KPI extraction failed, report is still available')
    }

    run.status = 'complete'
    saveCatalogue(catalogue)
    notifyRenderer(getWindow, run)
  } catch (err: any) {
    run.status = 'failed'
    run.error = err.message || 'Unknown error'
    saveCatalogue(catalogue)
    notifyRenderer(getWindow, run)
  } finally {
    running = false
  }

  return id
}

// Seed: copy existing report.html into the archive and extract KPIs in background.
// KPI extraction is cheap (just reads the HTML, ~$0.20) and needed for trend comparison.
export async function seedFromExisting(getWindow: () => BrowserWindow | null): Promise<string | null> {
  if (!existsSync(CLAUDE_REPORT)) return null

  const id = generateRunId()
  const archiveDir = join(getInsightsDir(), id)
  ensureDir(archiveDir)

  if (!copyReportToArchive(archiveDir)) {
    logError('[insights] seedFromExisting: failed to copy report')
    return null
  }

  const catalogue = loadCatalogue()
  const run: InsightsRun = { id, timestamp: Date.now(), status: 'extracting_kpis' }
  catalogue.runs.push(run)
  saveCatalogue(catalogue)
  notifyRenderer(getWindow, run)

  logInfo('[insights] Seeded archive from existing report, extracting KPIs...')

  // Extract KPIs (cheap — just reads the HTML file)
  const kpiSuccess = await extractKpis(archiveDir, id)
  if (!kpiSuccess) {
    logError('[insights] Seed KPI extraction failed, report still viewable')
  }

  run.status = 'complete'
  saveCatalogue(catalogue)
  notifyRenderer(getWindow, run)

  return id
}

export function getCatalogue(): InsightsCatalogue {
  return loadCatalogue()
}

export function getInsightsReport(runId: string): string | null {
  const reportPath = join(getInsightsDir(), runId, 'report.html')
  if (!existsSync(reportPath)) return null
  return readFileSync(reportPath, 'utf-8')
}

export function getInsightsKpis(runId: string): unknown | null {
  const kpiPath = join(getInsightsDir(), runId, 'kpis.json')
  if (!existsSync(kpiPath)) return null
  try {
    return JSON.parse(readFileSync(kpiPath, 'utf-8'))
  } catch {
    return null
  }
}

export function getLatestRun(): InsightsRun | null {
  const catalogue = loadCatalogue()
  if (catalogue.runs.length === 0) return null
  // Find latest complete run
  for (let i = catalogue.runs.length - 1; i >= 0; i--) {
    if (catalogue.runs[i].status === 'complete') return catalogue.runs[i]
  }
  // Or just the latest
  return catalogue.runs[catalogue.runs.length - 1]
}

export function isRunning(): boolean {
  return running
}

// On startup, mark any stuck 'running' or 'extracting_kpis' entries as 'failed'
// since they clearly didn't complete if the app restarted
export function cleanupStuckRuns(): void {
  const catalogue = loadCatalogue()
  let changed = false
  for (const run of catalogue.runs) {
    if (run.status === 'running' || run.status === 'extracting_kpis') {
      run.status = 'failed'
      run.error = 'Interrupted by app restart'
      changed = true
      logInfo(`[insights] Marked stuck run ${run.id} as failed`)
    }
  }
  if (changed) {
    saveCatalogue(catalogue)
  }
}
