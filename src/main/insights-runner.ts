import { join } from 'path'
import { homedir } from 'os'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  readdirSync,
  statSync
} from 'fs'
import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { logInfo, logWarn, logError } from './debug-logger'
import { resolveClaudeForPty, withProfileHome } from './pty-manager'
import { spawnClaudeHeadless } from './claude-headless'
import { getProfileConfigDir, getPrimaryProfileId, setupProfileLinks, listProfiles } from './account-profiles'
import { getProjectRootPath, getInstallPath } from './update-watcher'
import { getResourcesDirectory } from './ipc/setup-handlers'

// Source locations (Claude CLI output). `/insights` writes report.html under the
// running account's HOME (~/.claude/usage-data); with per-account isolation the
// HOME is the profile's fake home, so these are resolved against the spawn home
// rather than a fixed ~/.claude.
export function usageDataDir(home: string | null): string { return join(home ?? homedir(), '.claude', 'usage-data') }
export function claudeReportPath(home: string | null): string { return join(usageDataDir(home), 'report.html') }
export function claudeFacetsDir(home: string | null): string { return join(usageDataDir(home), 'facets') }

// Dynamic paths based on data directory
function getInsightsDir(): string { return join(getResourcesDirectory(), 'insights') }
function getCatalogueFile(): string { return join(getInsightsDir(), 'catalogue.json') }

export interface InsightsRun {
  id: string            // timestamp-based: '2026-02-06-143022'
  timestamp: number     // Date.now()
  status: 'running' | 'extracting_kpis' | 'complete' | 'failed'
  statusMessage?: string  // e.g. "Step 1/3: Generating report..."
  error?: string
  /** Account this run was generated for (multi-account). Undefined = default. */
  accountEmail?: string
  profileId?: string
  /** Run completed but KPI extraction failed: report is viewable, no kpis.json. */
  kpisUnavailable?: boolean
}

/**
 * Resolve which account a run executes under. Mirrors the cloud-agent path: an
 * explicit (and existing) profile wins; otherwise fall back to the captured
 * primary so a run is never silently attributed to the bare global login when
 * multi-account is active. Single-account users (no profiles) get home=null →
 * the global ~/.claude, unchanged.
 */
function resolveInsightsAccount(profileId?: string): { home: string | null; profileId?: string; accountEmail?: string } {
  let resolved: string | null = null
  if (profileId && existsSync(getProfileConfigDir(profileId))) {
    resolved = profileId
  } else {
    if (profileId) logWarn(`[insights] profile dir missing for ${profileId}; falling back to primary/default`)
    const primary = getPrimaryProfileId()
    if (primary && existsSync(getProfileConfigDir(primary))) resolved = primary
  }
  if (!resolved) return { home: null }
  try { setupProfileLinks(resolved) } catch (e) { logWarn(`[insights] home refresh failed for ${resolved}: ${e}`) }
  const accountEmail = listProfiles().find(p => p.id === resolved)?.accountEmail || undefined
  return { home: getProfileConfigDir(resolved), profileId: resolved, accountEmail }
}

export interface InsightsCatalogue {
  runs: InsightsRun[]
}

// Per-account in-flight lock: keyed by resolved profileId so two DIFFERENT
// accounts can run concurrently, while the same account can't double-run.
// Catalogue integrity across concurrent runs is preserved by upsertRun's
// synchronous read-modify-write (it re-reads the on-disk catalogue each call).
const inFlight = new Set<string>()
function accountKey(profileId?: string): string {
  return profileId ?? '(default)'
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

let runCounter = 0
function generateRunId(): string {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  const pad3 = (n: number) => n.toString().padStart(3, '0')
  // Millisecond + a monotonic counter keep IDs unique when two accounts run
  // concurrently within the same second (per-account concurrency, Unit 3 W6).
  runCounter = (runCounter + 1) % 1000
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad3(now.getMilliseconds())}${pad3(runCounter)}`
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
  // Atomic: write a tmp then rename over the target so a crash mid-write can't
  // truncate catalogue.json (which loadCatalogue would then read as an empty
  // catalogue, hiding every run).
  const file = getCatalogueFile()
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(catalogue, null, 2))
  renameSync(tmp, file)
}

/** Read-modify-write a single run into the CURRENT on-disk catalogue (replace by
 *  id, else append). Avoids persisting a stale whole-catalogue snapshot held
 *  across long awaits (extractKpis runs a headless claude for up to 10 min), so a
 *  concurrent mutation (another run, a delete, cleanupStuckRuns) is never erased. */
function upsertRun(run: InsightsRun): void {
  const catalogue = loadCatalogue()
  const idx = catalogue.runs.findIndex((r) => r.id === run.id)
  if (idx >= 0) catalogue.runs[idx] = run
  else catalogue.runs.push(run)
  saveCatalogue(catalogue)
}

function notifyRenderer(getWindow: () => BrowserWindow | null, run: InsightsRun): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('insights:statusChanged', run)
  }
}

function copyReportToArchive(archiveDir: string, home: string | null): boolean {
  try {
    const report = claudeReportPath(home)
    const facets = claudeFacetsDir(home)
    if (!existsSync(report)) {
      logError('[insights] report.html not found at ' + report)
      return false
    }
    copyFileSync(report, join(archiveDir, 'report.html'))

    // Copy facets if they exist
    if (existsSync(facets)) {
      const facetsTarget = join(archiveDir, 'facets')
      ensureDir(facetsTarget)
      const files = readdirSync(facets)
      for (const file of files) {
        if (file.endsWith('.json')) {
          copyFileSync(join(facets, file), join(facetsTarget, file))
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
function stripAnsiCodes(str: string): string {
  return str
    .replace(/\x1b\[[\x20-\x3f]*[0-9;]*[\x20-\x7e]/g, '')  // CSI sequences (including ?...)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')       // OSC sequences
    .replace(/\x1b[()][A-Z0-9]/g, '')                          // Character set selection
    .replace(/\x1b[>=]/g, '')                                   // Keypad/cursor mode
}

/**
 * Human-readable reason for a /insights PTY timeout, by how far it got. Pure, so
 * it's unit-testable without the live PTY. The detail flows into run.error and is
 * surfaced in the Insights UI (Unit 3 W7). NOTE: a content-based *fast-exit* for
 * the no-usage-data case is deferred to live-QA — capturing the exact empty-state
 * string needs a real no-data run, and a blind timing cutoff risks killing a
 * slow-but-working generation on a heavy account (real-data gate).
 */
export function describeInsightsTimeout(commandSent: boolean, timeoutSec: number): string {
  return commandSent
    ? `/insights did not produce a report within ${timeoutSec}s (likely no usage data yet, or the trust prompt was not accepted)`
    : `Claude did not reach an interactive prompt within ${timeoutSec}s`
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
function spawnClaudeInsights(home: string | null, timeoutMs = 600000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const { cmd } = resolveClaudeForPty()
    const cwd = findTrustedCwd()
    const reportPath = claudeReportPath(home)
    logInfo(`[insights] Spawning Claude PTY for /insights: ${cmd} in ${cwd} (home=${home ?? 'default'})`)

    const proc = pty.spawn(cmd, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: withProfileHome(process.env as Record<string, string>, home)
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
      if (existsSync(reportPath)) {
        initialMtime = statSync(reportPath).mtimeMs
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
        const reason = describeInsightsTimeout(commandSent, timeoutMs / 1000)
        logError(`[insights] PTY timed out: ${reason}`)
        logError(`[insights] Last output: ${stripAnsiCodes(output).slice(-500)}`)
        try { proc.kill() } catch { /* ignore */ }
        resolve({ code: 1, output: output + '\n' + reason })
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
        if (existsSync(reportPath)) {
          const currentMtime = statSync(reportPath).mtimeMs
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
      const clean = stripAnsiCodes(data)
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

export function loadPreviousKpis(currentRunId: string): string | null {
  try {
    const catalogue = loadCatalogue()
    // Compare against the previous COMPLETE run of the SAME account — otherwise a
    // multi-account setup diffs account A's run against account B's (nonsense
    // "what changed"). profileId is the stable key; single-account runs have it
    // undefined so they all match (unchanged behaviour). (Unit 3 W5)
    const current = catalogue.runs.find(r => r.id === currentRunId)
    const currentAccount = current?.profileId ?? null
    const completeRuns = catalogue.runs.filter(
      r => r.status === 'complete' && r.id !== currentRunId && (r.profileId ?? null) === currentAccount
    )
    if (completeRuns.length === 0) return null

    const prevRun = completeRuns[completeRuns.length - 1]
    const prevKpiPath = join(getInsightsDir(), prevRun.id, 'kpis.json')
    if (!existsSync(prevKpiPath)) return null

    return readFileSync(prevKpiPath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Build the headless `claude` args for KPI extraction. Read-only: the step only
 * reads one archived HTML report (absolute path embedded in the prompt). No
 * `--dangerously-skip-permissions` — `-p` already skips the workspace-trust
 * dialog and `--allowedTools Read` pre-authorizes the only tool needed. Verified
 * on the VM: an out-of-cwd absolute Read succeeds with zero permission denials
 * and no dangerous flag. See specs/2026-06-15-unit3-insights-review-design.md W1.
 */
export function buildKpiSpawnArgs(): string[] {
  return ['-p', '--allowedTools', 'Read', '--output-format', 'json']
}

async function extractKpis(archiveDir: string, runId: string, home: string | null = null): Promise<boolean> {
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

  const spawnArgs = buildKpiSpawnArgs()

  // Pipe the prompt via stdin — passing multi-KB prompts with embedded JSON
  // as shell arguments is unreliable on Windows (quoting/escaping breaks).
  const result = await spawnClaudeHeadless(spawnArgs, 600000, prompt, home)

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
      // If it has a "result" key that's a string, extract KPI JSON from it
      if (parsed.result && typeof parsed.result === 'string') {
        const resultStr = parsed.result
        try {
          kpiData = JSON.parse(resultStr)
        } catch {
          // Result has text preamble before JSON -- extract the JSON object
          const jsonMatch = resultStr.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            kpiData = JSON.parse(jsonMatch[0])
          } else {
            throw new Error('No JSON found in result string')
          }
        }
      } else {
        kpiData = parsed
      }
    } catch {
      // Try extracting JSON from the raw output
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

export async function runInsights(getWindow: () => BrowserWindow | null, opts?: { profileId?: string }): Promise<string> {
  const account = resolveInsightsAccount(opts?.profileId)
  const key = accountKey(account.profileId)
  if (inFlight.has(key)) throw new Error('Insights already running for this account')
  inFlight.add(key)


  const id = generateRunId()
  const archiveDir = join(getInsightsDir(), id)
  ensureDir(archiveDir)

  const run: InsightsRun = { id, timestamp: Date.now(), status: 'running', accountEmail: account.accountEmail, profileId: account.profileId }
  upsertRun(run)
  notifyRenderer(getWindow, run)
  logInfo(`[insights] Run ${id} account=${account.accountEmail ?? '(default)'} home=${account.home ?? 'global'}`)

  try {
    // Step 1: Run /insights via interactive PTY
    run.statusMessage = 'Step 1/3: Generating report...'
    upsertRun(run)
    notifyRenderer(getWindow, run)
    logInfo('[insights] Running /insights via PTY...')
    const result = await spawnClaudeInsights(account.home)

    if (result.code !== 0) {
      run.status = 'failed'
      run.error = 'claude /insights failed: ' + stripAnsiCodes(result.output).slice(-200)
      upsertRun(run)
      notifyRenderer(getWindow, run)
      return id
    }

    // Step 2: Copy report to archive
    run.statusMessage = 'Step 2/3: Archiving report...'
    upsertRun(run)
    notifyRenderer(getWindow, run)
    if (!copyReportToArchive(archiveDir, account.home)) {
      run.status = 'failed'
      run.error = 'Failed to copy report files'
      upsertRun(run)
      notifyRenderer(getWindow, run)
      return id
    }

    // Step 3: Extract KPIs
    run.status = 'extracting_kpis'
    run.statusMessage = 'Step 3/3: Extracting KPIs...'
    upsertRun(run)
    notifyRenderer(getWindow, run)

    const kpiSuccess = await extractKpis(archiveDir, id, account.home)
    if (!kpiSuccess) {
      // KPI extraction is non-fatal — the report is still viewable. Flag it so
      // the UI shows "report ready, KPIs unavailable" instead of silently
      // hiding the sidebar with no explanation.
      logError('[insights] KPI extraction failed, report is still available')
      run.kpisUnavailable = true
    }

    run.status = 'complete'
    upsertRun(run)
    notifyRenderer(getWindow, run)
  } catch (err: any) {
    run.status = 'failed'
    run.error = err.message || 'Unknown error'
    upsertRun(run)
    notifyRenderer(getWindow, run)
  } finally {
    inFlight.delete(key)
  }

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

export function isRunning(profileId?: string): boolean {
  return profileId ? inFlight.has(accountKey(profileId)) : inFlight.size > 0
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
