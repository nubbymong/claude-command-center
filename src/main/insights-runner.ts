import { join, basename, dirname, resolve } from 'path'
import { homedir } from 'os'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  copyFileSync,
  readdirSync,
  statSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  rmSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants as fsConstants,
  type Stats,
} from 'fs'
import * as pty from 'node-pty'
import { guardPtyIo } from './pty-input-guard'
import { stripSpoofableText } from '../shared/safe-text'
import { BrowserWindow } from 'electron'
import { logInfo, logWarn, logError } from './debug-logger'
import { resolveClaudeForPty, withProfileHome } from './pty-manager'
import { gateManagedLaunch } from './managed-launch-diagnostics'
import { spawnClaudeHeadless } from './claude-headless'
import { acquireProfileConsumer, waitForProfileRefresh } from './profile-consumers'
import { providerLaunchRefusal, providerProbeRefusal } from './provider-launch-gate'
import type { ProviderLaunchRefused } from '../shared/providers'
import { getProfileConfigDir, getPrimaryProfileId, setupProfileLinks, listProfiles, isValidProfileId, sharedRoot } from './account-profiles'
import { getProjectRootPath, getInstallPath } from './update-watcher'
import { getResourcesDirectory } from './ipc/setup-handlers'
import type { AccountProfile } from '../shared/account-types'
import { isAuthFailure, type ClaudeFailureFacts } from '../shared/claude-auth-errors'
import { readProfileAuthInfo } from './account-auth-info'
import { redactSecrets } from './hooks/hook-payload-redactor'
import { atomicWriteFileSync } from './atomic-write'
import type { InsightsCatalogue, InsightsData, InsightsRun, InsightsRunMember } from '../shared/types'
import { getAccountsService } from './provider-accounts'
import { sweepStaleFolders } from './stale-folder-sweep'
import { isOpaqueId } from '../shared/providers'
import type { AccountsSnapshot, ProviderId } from '../shared/providers'
import { tryGetProviderPackage } from './providers/core'
import type { ProviderInsightsOperations } from './providers/core'
import {
  CODEX_INSIGHTS_READ_TIME_LIMIT_MS,
  CODEX_INSIGHTS_RUNS_DIRNAME,
  CODEX_INSIGHTS_RUN_PREFIX,
  buildCodexDigest,
  buildCodexInsightsPrompt,
  codexInsightsKpis,
  codexMemberLabel,
  codexPreviousFigures,
  codexStoredReport,
  countCodexSessions,
  parseCodexInsightsReply,
  readCodexSessions,
} from './insights-codex'
import { CODEX_REPORT_MAX_BYTES, type CodexStoredReport } from '../shared/insights-codex-report'
import {
  CROSS_ACCOUNT_MAX_PARALLEL,
  CROSS_ACCOUNT_MIN_ACCOUNTS,
  CROSS_ACCOUNT_SYNTHESIS_ENV,
  assembleCrossAccount,
  buildCrossAccountPromptFrom,
  buildCrossAccountSpawnArgs,
  crossAccountLabel,
  describeCrossAccountFanout,
  mapWithLimit,
  parseCrossAccountNarrative,
  plainCrossAccountNarrative,
  withNarrative,
  type CrossAccountMember
} from './insights-cross-account'

// The run/catalogue shapes live in shared/types (the renderer reads them too);
// re-exported here so existing `from './insights-runner'` type imports keep
// working and the two copies can't drift.
export type { InsightsCatalogue, InsightsRun }

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

/**
 * Resolve which account a run executes under. Mirrors the cloud-agent path: an
 * explicit (and existing) profile wins; otherwise fall back to the captured
 * primary so a run is never silently attributed to the bare global login when
 * multi-account is active. Single-account users (no profiles) get home=null →
 * the global ~/.claude, unchanged.
 */
function resolveInsightsAccount(profileId?: string): { home: string | null; profileId?: string; accountEmail?: string } {
  let resolved: string | null = null
  // The profileId is renderer-supplied and becomes a PATH COMPONENT below (and
  // the HOME of the spawned run). Validate before the join so a crafted id takes
  // the fall-back branch rather than resolving outside the profiles root.
  if (profileId && isValidProfileId(profileId) && existsSync(getProfileConfigDir(profileId))) {
    resolved = profileId
  } else {
    if (profileId) logWarn(`[insights] profile dir missing or invalid for ${profileId}; falling back to primary/default`)
    const primary = getPrimaryProfileId()
    if (primary && existsSync(getProfileConfigDir(primary))) resolved = primary
  }
  if (!resolved) return { home: null }
  try { setupProfileLinks(resolved) } catch (e) { logWarn(`[insights] home refresh failed for ${resolved}: ${e}`) }
  const accountEmail = listProfiles().find(p => p.id === resolved)?.accountEmail || undefined
  return { home: getProfileConfigDir(resolved), profileId: resolved, accountEmail }
}

// Per-account in-flight lock: keyed by resolved profileId so two DIFFERENT
// accounts can run concurrently, while the same account can't double-run.
// Catalogue integrity across concurrent runs is preserved by upsertRun's
// synchronous read-modify-write (it re-reads the on-disk catalogue each call).
const inFlight = new Set<string>()
function accountKey(profileId?: string): string {
  return profileId ?? '(default)'
}

// A cross-account fan-out takes its own lock so two overlapping roll-ups can't
// both drive the same member accounts. It is deliberately a SEPARATE key from
// every accountKey(): the fan-out holds this one while each member run takes and
// releases its own, so the aggregate lock can never collide with a member's.
const CROSS_ACCOUNT_KEY = '(cross-account)'

// P4.7: a Codex report's lock, per Codex account (its registry id), kept apart
// from Claude's so neither assistant's runs are counted as the other's in use.
const codexInFlight = new Set<string>()
// Codex runs past the launch check that hold no account lease yet: counted as
// Codex in use (countCodexInsightsRunsUnleased) until the lease is held, and
// through the lease from then on, as a Codex cloud agent is (provider-in-use.ts).
const codexUnleased = new Set<string>()
// The assistants the roll-up in flight runs (set with CROSS_ACCOUNT_KEY): it
// counts as each one's in use for its whole length, as Claude's roll-up always has.
let crossAccountProviders: ReadonlySet<ProviderId> = new Set()

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
  // Atomic, and retried past the Windows rename race this file was the first to
  // hit (#213). Staging, exclusive create, retry and cleanup now live in
  // atomic-write.ts (#233) -- this was the prototype, not a special case.
  atomicWriteFileSync(getCatalogueFile(), JSON.stringify(catalogue, null, 2))
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
export function stripAnsiCodes(str: string): string {
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
async function spawnClaudeInsights(home: string | null, timeoutMs = 600000): Promise<{ code: number; output: string }> {
  const { cmd } = resolveClaudeForPty()
  const cwd = findTrustedCwd()
  // The project gate, before the PTY exists: the run happens in `cwd`, whose
  // own settings files are gated like any other launch's. A refusal throws
  // from withProfileHome below and rejects this promise.
  const projectGate = home ? await gateManagedLaunch(cwd) : null
  return new Promise((resolve) => {
    const reportPath = claudeReportPath(home)
    logInfo(`[insights] Spawning Claude PTY for /insights: ${cmd} in ${cwd} (home=${home ?? 'default'})`)

    const proc = pty.spawn(cmd, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: withProfileHome(process.env as Record<string, string>, home, { launchId: 'insights', cwd, probe: false, projectGate })
    })
    // P3.15 round 4 (P2): an error on this PTY's input (the app types
    // /insights into it) or output never quits the app; the run settles on its
    // exit or its time limit.
    guardPtyIo(proc, (side, err) => logError(`[insights] PTY ${side} failed (${stripSpoofableText(String(err?.code ?? err?.message ?? err), 120)})`))

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
    // P4.7: and of the SAME assistant (absent reads as Claude Code's), so a
    // Codex run is compared only with that Codex account's last run.
    const currentProvider = current?.provider ?? 'claude'
    // Aggregates are excluded explicitly: a cross-account roll-up has no
    // profileId, so `(r.profileId ?? null) === currentAccount` would otherwise
    // match it against every DEFAULT-account run and hand a roll-up to a single
    // account as its "previous run".
    const completeRuns = catalogue.runs.filter(
      r =>
        r.status === 'complete' &&
        r.kind !== 'aggregate' &&
        r.id !== currentRunId &&
        (r.profileId ?? null) === currentAccount &&
        (r.provider ?? 'claude') === currentProvider
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
 *
 * `--strict-mcp-config` and `--tools Read` are the cost fix, and they are not a
 * micro-optimisation. A headless `claude -p` loads the account's whole mirrored
 * global config: measured on a real profile, 10 MCP servers (azure, m365,
 * atlassian, grafana, ...) plus 41 skills. A real 4-account run showed
 * `cache_read 134,038 + cache_creation 58,814 = 192,852` context tokens per
 * extraction, against a payload of roughly 31k — so ~162k of pure overhead, at
 * $0.77 a call.
 *
 * Measured with the same trivial prompt: overhead is 41,714 tokens with
 * `--strict-mcp-config` (no `--mcp-config` alongside it means no servers load),
 * and 14,395 with `--tools Read` as well. The remaining 27k is the default
 * built-in toolset's schemas, which `--allowedTools` does NOT unload — that flag
 * only gates the permission prompt. `--tools` is the one that decides which tool
 * DEFINITIONS enter context, so both are needed and they do different jobs.
 *
 * Neither value contains a space or is empty, which is why they can be passed at
 * all: spawnClaudeHeadless runs with `shell: true`, which concatenates argv
 * without quoting, so an empty or spaced argument would vanish and let the
 * preceding flag swallow the next one. `--tools ""` for the no-tools case and
 * `--settings '{...}'` for the skills/CLAUDE.md overhead are blocked on that.
 */
export function buildKpiSpawnArgs(): string[] {
  return ['-p', '--strict-mcp-config', '--tools', 'Read', '--allowedTools', 'Read', '--output-format', 'json']
}

/**
 * Pull the usage/cost block out of a `claude -p --output-format json` reply and
 * render it for the log. Pure + exported for testing.
 *
 * Every token figure for this feature has so far been an ESTIMATE derived from
 * file sizes. The CLI already reports the real numbers in the envelope and the
 * code discarded them. Logging turns the next optimisation pass into measurement
 * instead of arithmetic. Field names are read defensively (both snake_case and
 * camelCase) because they are not part of any contract we control.
 */
export function describeClaudeUsage(stdout: string): string | null {
  let envelope: any
  try {
    envelope = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (!envelope || typeof envelope !== 'object') return null
  const usage = envelope.usage
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = usage?.[k]
      if (typeof v === 'number' && Number.isFinite(v)) return v
    }
    return undefined
  }
  const parts: string[] = []
  const input = num('input_tokens', 'inputTokens')
  const output = num('output_tokens', 'outputTokens')
  const cacheRead = num('cache_read_input_tokens', 'cacheReadInputTokens')
  const cacheWrite = num('cache_creation_input_tokens', 'cacheCreationInputTokens')
  if (input != null) parts.push(`in=${input}`)
  if (output != null) parts.push(`out=${output}`)
  if (cacheRead != null) parts.push(`cacheRead=${cacheRead}`)
  if (cacheWrite != null) parts.push(`cacheWrite=${cacheWrite}`)
  const cost = envelope.total_cost_usd ?? envelope.totalCostUsd
  if (typeof cost === 'number' && Number.isFinite(cost)) parts.push(`cost=$${cost.toFixed(4)}`)
  const durationMs = envelope.duration_ms ?? envelope.durationMs
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) parts.push(`${Math.round(durationMs / 1000)}s`)
  return parts.length > 0 ? parts.join(' ') : null
}

/**
 * Human-readable reason from a `claude -p --output-format json` reply that failed
 * before producing anything. Pure + exported for testing.
 *
 * The hard-failure envelope carries the actual explanation in `result` (or
 * `error`), and the code used to log 500 characters of the raw envelope — which is
 * mostly the zeroed `usage` block — so the reason never reached the UI or the log.
 * Observed shape of such a failure: `is_error:true, duration_api_ms:0, num_turns:1`
 * with every token count at 0, i.e. the API was never called.
 */
/**
 * Extract the non-prose facts from a failure envelope so the auth classifier can
 * gate on them. `apiReached` is the important one: if any token was counted or the
 * API call took time, the envelope's `result` is MODEL OUTPUT and must never be
 * read as an auth verdict. See isAuthFailure.
 */
export function readClaudeFailureFacts(stdout: string, reason: string | null): ClaudeFailureFacts {
  let envelope: any
  try {
    envelope = JSON.parse(stdout.trim())
  } catch {
    // Unparseable output tells us nothing structural; treat the API as reached so
    // the auth path stays closed and the raw reason is surfaced instead.
    return { isError: true, apiReached: true, reason }
  }
  const usage = envelope?.usage ?? {}
  const counters = [
    'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
    'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'
  ]
  const apiMs = envelope?.duration_api_ms ?? envelope?.durationApiMs

  // A field that is PRESENT but not a finite number tells us nothing, and
  // "nothing" must fail CLOSED — treat the API as reached, exactly like
  // unparseable stdout does. The first cut coerced such a field to zero, which
  // failed OPEN: `{"usage":{"input_tokens":"500"},"duration_api_ms":"5000"}` read
  // as no-tokens-no-time and let model prose back through the gate.
  //
  // `undefined` means the key is genuinely ABSENT, which is fine: the real auth
  // envelope carries every counter at zero, and a missing counter honestly means
  // nothing was spent. `null` is NOT absent — it is an explicitly present value we
  // cannot read, i.e. the schema drift this guard exists for, so it is excluded
  // from this filter and caught below. (It is also what `NaN` becomes after a JSON
  // round-trip, so it is the only form that case can reach us in.)
  const present = [...counters.map((k) => usage[k]), apiMs].filter((v) => v !== undefined)
  const unreadable = present.some((v) => typeof v !== 'number' || !Number.isFinite(v))
  if (unreadable) {
    return { isError: envelope?.is_error === true || envelope?.isError === true, apiReached: true, reason }
  }

  const tokensSpent = counters.some((k) => typeof usage[k] === 'number' && usage[k] > 0)
  const tookApiTime = typeof apiMs === 'number' && apiMs > 0
  return {
    isError: envelope?.is_error === true || envelope?.isError === true,
    apiReached: tokensSpent || tookApiTime,
    reason
  }
}

export function describeClaudeError(stdout: string): string | null {
  let envelope: any
  try {
    envelope = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (!envelope || typeof envelope !== 'object') return null
  if (envelope.is_error !== true && envelope.isError !== true) return null

  const parts: string[] = []
  if (typeof envelope.subtype === 'string' && envelope.subtype.trim()) parts.push(envelope.subtype.trim())
  const message =
    (typeof envelope.result === 'string' && envelope.result.trim()) ||
    (typeof envelope.error === 'string' && envelope.error.trim()) ||
    (typeof envelope.error?.message === 'string' && envelope.error.message.trim())
  if (message) parts.push(String(message).slice(0, 400))
  const apiMs = envelope.duration_api_ms ?? envelope.durationApiMs
  if (apiMs === 0) parts.push('the API was never reached (duration_api_ms=0)')
  if (typeof envelope.stop_reason === 'string') parts.push(`stop_reason=${envelope.stop_reason}`)
  return parts.length > 0 ? parts.join('; ') : 'claude reported is_error with no message'
}

/**
 * Scan a balanced JSON object starting at `start`, honouring strings and escapes.
 * Returns the object's source text, or null when it never closes — which is the
 * signature of output truncated mid-object.
 */
function scanBalancedObject(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/** How many candidate opening braces to try. Bounds the scan on a large reply. */
const MAX_OBJECT_STARTS = 8

/**
 * Recover a JSON object from model output that may be fenced, prefaced with prose,
 * or followed by commentary. Pure + exported for testing.
 *
 * Replaces a greedy `/\{[\s\S]*\}/` match, which fails outright whenever anything
 * after the object contains a `}` (the greedy match then runs past the real
 * closing brace) or whenever prose before it contains a `{`. That failure mode was
 * not theoretical: a real run produced 4,788 output tokens costing $0.77, and the
 * greedy match returned nothing, so the whole reply was discarded.
 *
 * Strategy: strip code fences, then try successive opening braces with a balanced
 * scan, and keep the LONGEST candidate that parses — prose can contain a small
 * valid object (`{"note": 1}`), and the payload is always the big one.
 */
export function extractJsonObject(text: string): unknown | null {
  const stripped = text.replace(/```[a-zA-Z0-9]*/g, '').trim()
  const first = stripped.indexOf('{')
  if (first === -1) return null

  // If the FIRST object never closes, the reply was cut off. Bail out rather than
  // searching on: the next complete object would be one of its NESTED children,
  // and returning `{"days":3}` out of a truncated KPI payload writes a
  // plausible-looking wrong artifact to disk. A visible failure plus the saved raw
  // reply beats a quiet fragment.
  //
  // Accepted cost: a stray unclosed `{` in leading prose makes the whole reply
  // unrecoverable. That is the safe direction to fail in.
  if (scanBalancedObject(stripped, first) === null) return null

  let best: { source: string; value: unknown } | null = null
  let attempts = 0
  for (let i = first; i !== -1 && attempts < MAX_OBJECT_STARTS; i = stripped.indexOf('{', i + 1)) {
    attempts++
    const candidate = scanBalancedObject(stripped, i)
    if (!candidate) continue
    try {
      const value = JSON.parse(candidate)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (!best || candidate.length > best.source.length) best = { source: candidate, value }
      }
    } catch {
      // Not a valid object from this brace; try the next one.
    }
  }
  return best?.value ?? null
}

/** True when the text opens a JSON object that never closes — i.e. cut off. */
export function looksTruncated(text: string): boolean {
  const stripped = text.replace(/```[a-zA-Z0-9]*/g, '').trim()
  const first = stripped.indexOf('{')
  return first !== -1 && scanBalancedObject(stripped, first) === null
}

/**
 * Parse the KPI JSON out of a `claude -p --output-format json` reply. Pure +
 * exported for testing. Handles: a direct JSON object; the `{result:"<json>"}`
 * envelope; and a result/raw string with fences or prose around the JSON.
 * Returns null if no JSON object is recoverable.
 */
export function parseKpiOutput(stdout: string): unknown | null {
  const trimmed = stdout.trim()
  let outer: unknown = null
  try {
    outer = JSON.parse(trimmed)
  } catch {
    // stdout was not clean JSON (a prefix, a fence, trailing text). Recover the
    // object rather than giving up — the old code's greedy match gave up here.
    outer = extractJsonObject(trimmed)
  }
  if (outer == null || typeof outer !== 'object' || Array.isArray(outer)) return null

  // Unwrap the `--output-format json` envelope. This has to happen on BOTH paths:
  // recovering the envelope from noisy stdout and then returning it would write
  // the CLI's own metadata to kpis.json as if it were the metrics.
  const result = (outer as { result?: unknown }).result
  if (typeof result === 'string') {
    try {
      return JSON.parse(result)
    } catch {
      return extractJsonObject(result)
    }
  }
  return outer
}

/** Outcome of a KPI extraction. The reason travels so the UI can name a dead
 *  account instead of showing a bare "KPI extraction failed", and `authFailed`
 *  lets Insights offer the re-auth action rather than just reporting a problem. */
interface KpiExtractionResult {
  ok: boolean
  reason?: string
  authFailed?: boolean
}

async function extractKpis(
  archiveDir: string,
  runId: string,
  home: string | null = null
): Promise<KpiExtractionResult> {
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

  // Another Claude Code run: not started once Claude Code has been switched
  // off since the run began. The report stays; the KPIs say why they are not
  // there.
  const refused = providerLaunchRefusal('claude')
  if (refused) return { ok: false, reason: refused.message }

  // Pipe the prompt via stdin — passing multi-KB prompts with embedded JSON
  // as shell arguments is unreliable on Windows (quoting/escaping breaks).
  const result = await spawnClaudeHeadless(spawnArgs, 600000, prompt, home)

  const usage = describeClaudeUsage(result.stdout)
  if (usage) logInfo(`[insights] KPI extraction usage: ${usage}`)

  if (result.code !== 0) {
    // The hard-failure envelope carries the real reason in `result`; the previous
    // 500-char slice of the raw envelope showed only the zeroed usage block.
    const reason = describeClaudeError(result.stdout)
    logError(
      `[insights] KPI extraction failed (code ${result.code}): ${reason ?? (result.stderr.slice(0, 400) || 'no reason reported')}`
    )
    saveExtractionFailure(archiveDir, spawnArgs, result, reason)
    return {
      ok: false,
      reason: reason ?? `claude exited ${result.code}`,
      // Structural gate, not a phrase match: an auth failure spends no tokens and
      // reaches no API, so a reason containing MODEL prose can never be read as
      // one. stderr is excluded too — it carries proxy, DNS and TLS noise from the
      // whole network path, and this flag drives a UI action that opens a login
      // shell.
      authFailed: isAuthFailure(readClaudeFailureFacts(result.stdout, reason))
    }
  }

  const kpiData = parseKpiOutput(result.stdout)
  if (kpiData == null) {
    // A parse failure here means the model was PAID FOR and its answer thrown
    // away, so the full reply is persisted beside the report for post-mortem.
    const truncated = looksTruncated(result.stdout)
    logError(
      `[insights] Failed to parse KPI output${truncated ? ' (reply looks truncated mid-object)' : ''}` +
      `${usage ? ` — this run was billed: ${usage}` : ''}`
    )
    const reason = truncated ? 'the analysis reply was cut off mid-object' : 'no JSON object could be recovered from the reply'
    saveExtractionFailure(archiveDir, spawnArgs, result, reason)
    return { ok: false, reason }
  }

  try {
    // kpis.json holds the account's analysed usage data; write it owner-only
    // through the shared atomic helper (0600), not a bare 0644 writeFileSync.
    atomicWriteFileSync(join(archiveDir, 'kpis.json'), JSON.stringify(kpiData, null, 2), { mode: 0o600 })
    logInfo('[insights] KPIs extracted and saved')
    return { ok: true }
  } catch (err) {
    logError('[insights] Failed to write kpis.json:', err)
    return { ok: false, reason: 'kpis.json could not be written' }
  }
}

/**
 * Persist everything about a failed extraction next to the report it was for.
 *
 * A real 4-account run billed $0.77 for a reply of 4,788 output tokens, failed to
 * parse it, logged 500 characters of the envelope, and discarded the rest — so
 * there was nothing left to diagnose from. The archive already holds report.html;
 * this puts the reply beside it. Written best-effort: a failure to record a
 * failure must never mask the original one.
 */
/**
 * Cap on each captured stream. A failure record exists to be read by a human, and
 * a truncated 19KB reply diagnoses just as well as an unbounded one. Also bounds
 * how much of the prompt's embedded previous-run KPI data can be duplicated onto
 * disk by a single failure.
 */
const FAILURE_CAPTURE_LIMIT = 20000

/** Truncate AND redact. Redaction first, so a secret straddling the cut is still
 *  matched as a whole before anything is dropped. */
function capture(text: string): string {
  const clean = redactSecrets(text ?? '')
  return clean.length <= FAILURE_CAPTURE_LIMIT
    ? clean
    : clean.slice(0, FAILURE_CAPTURE_LIMIT) + `\n…[truncated, ${clean.length} chars total]`
}

function saveExtractionFailure(
  archiveDir: string,
  spawnArgs: string[],
  result: { code: number; stdout: string; stderr: string },
  reason: string | null
): void {
  try {
    const target = join(archiveDir, 'kpi-extraction-failure.json')
    // 0o600 on POSIX. This file holds the verbatim reply to a prompt that embeds
    // the previous run's full kpis.json, so it routinely persists a copy of the
    // user's analysed usage data, and it must not land 0o644 under the default
    // umask.
    //
    // Through the shared atomic write, not a bare writeFileSync + chmod (#233).
    // The old shape was GHSA-pwfw-2ggq-569x exactly: a mode passed to open(2)
    // applies only on CREATE, so writing into an existing inode inherited its
    // permissions, and the compensating chmod followed a link to harden someone
    // else's file. Exclusive create means the file is always new, so the mode
    // always applies and the re-assert is no longer needed.
    atomicWriteFileSync(
      target,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          exitCode: result.code,
          reason,
          usage: describeClaudeUsage(result.stdout),
          spawnArgs,
          stdout: capture(result.stdout),
          stderr: capture(result.stderr)
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
    logError(`[insights] Full failed reply saved to ${target}`)
  } catch (err) {
    logError('[insights] Could not save the extraction failure record:', err)
  }
}

export async function runInsights(getWindow: () => BrowserWindow | null, opts?: { profileId?: string }): Promise<string | ProviderLaunchRefused> {
  // WP2: an insights run is a Claude Code run, so none starts while Claude
  // Code is off -- refused here, before a run record or a lock exists
  // (provider-launch-gate.ts). Answered, never thrown: the Insights page
  // says why. Each later step that starts Claude asks again (a switch-off
  // mid-run stops the run at its next step instead of starting it anyway).
  const refused = providerLaunchRefusal('claude')
  if (refused) return { refused }
  const account = resolveInsightsAccount(opts?.profileId)
  const key = accountKey(account.profileId)
  if (inFlight.has(key)) throw new Error('Insights already running for this account')
  inFlight.add(key)


  const id = generateRunId()
  const archiveDir = join(getInsightsDir(), id)
  const run: InsightsRun = { id, timestamp: Date.now(), status: 'running', accountEmail: account.accountEmail, profileId: account.profileId }

  // Everything that can touch the disk lives inside the try, because only its
  // `finally` releases the lock. ensureDir and the first upsertRun used to run
  // above it, so a transient failure there (a scanner losing us the catalogue
  // rename, a full disk) left `key` in `inFlight` forever and every later run
  // for that account reported "Insights already running" with nothing running.
  let releaseAccount: (() => void) | null = null
  try {
    ensureDir(archiveDir)
    upsertRun(run)
    notifyRenderer(getWindow, run)
    logInfo(`[insights] Run ${id} account=${account.accountEmail ?? '(default)'} home=${account.home ?? 'global'}`)

    // #48/#49: the whole run -- the interactive /insights PTY and the headless
    // KPI extraction -- reads this account's credential home. Hold the profile
    // as a consumer from here to the `finally` (which always runs, so the ref
    // needs no leak clock); THEN, if the usage page is rotating this token
    // right now, wait for the new lineage to land before the first read.
    // Acquire before the wait, not after (adversarial pass on #598): the hold
    // is what stops a NEW rotation from starting, and the microtask between the
    // in-flight one settling and a late acquire was a gap in which one could.
    // Both AFTER the catalogue publish above, which callers observe
    // synchronously (the run is "running" the instant it is asked for).
    if (account.profileId) {
      releaseAccount = acquireProfileConsumer(account.profileId, { maxAgeMs: Infinity })
      await waitForProfileRefresh(account.profileId)
    }

    // Step 1: Run /insights via interactive PTY -- unless Claude Code was
    // switched off while the run waited above.
    const stepRefused = providerLaunchRefusal('claude')
    if (stepRefused) {
      run.status = 'failed'
      run.error = stepRefused.message
      upsertRun(run)
      notifyRenderer(getWindow, run)
      return id
    }
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

    const kpi = await extractKpis(archiveDir, id, account.home)
    if (!kpi.ok) {
      // KPI extraction is non-fatal — the report is still viewable. Flag it so
      // the UI shows "report ready, KPIs unavailable" instead of silently
      // hiding the sidebar with no explanation. The reason rides along on
      // `error`: a real run failed with "OAuth session expired and could not be
      // refreshed", which is a one-click fix the user can only act on if told.
      logError('[insights] KPI extraction failed, report is still available')
      run.kpisUnavailable = true
      if (kpi.reason) run.error = kpi.reason
      if (kpi.authFailed) {
        run.authFailed = true
        // Snapshot the refresh-token expiry in force right now, so the warning can
        // only be retired by a login that issues a LATER one — not by credential
        // reconciliation rewriting the file.
        if (account.profileId) {
          run.authFailedRefreshExpiry = readProfileAuthInfo(account.profileId).refreshTokenExpiresAt
        }
        logError(`[insights] ${account.accountEmail ?? 'this account'} needs to sign in again`)
      }
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
    releaseAccount?.()
    inFlight.delete(key)
  }

  return id
}

// -- A Codex account's report (WP2 PR 4, P4.7, row 68) --

/** A run's working folder older than this is a leftover (a crash or a
 *  quit mid-run; a run ends well inside it). */
const STALE_CODEX_RUN_FOLDER_MS = 2 * 60 * 60 * 1000

/** Real paths compared as the platform does (Windows: case-insensitive). */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** The folders an Insights model run is made a working folder in: a runs
 *  folder inside the insights folder (a dot name, so it is never read as a
 *  run), and the prefix each run's own folder starts with. `marker`: an
 *  empty `.git` file makes the folder a project root of its own (Codex). */
interface RunFolders { dirname: string; prefix: string; marker: boolean }
/** A Codex model run's (a report, or a roll-up's written analysis on Codex). */
const CODEX_RUN_FOLDERS: RunFolders = { dirname: CODEX_INSIGHTS_RUNS_DIRNAME, prefix: CODEX_INSIGHTS_RUN_PREFIX, marker: true }
/** The roll-up's written analysis on Claude Code (as Sentinel's Claude Code
 *  analysis folder, no marker). */
const CLAUDE_SYNTHESIS_FOLDERS: RunFolders = { dirname: '.insights-claude-runs', prefix: 'ccc-insights-claude-', marker: false }

/**
 * Whether `parent` is still the runs folder it was checked to be: `insights`
 * and it real folders (never links), its real path
 * `<real resources>/insights/<runs folder>`, and on POSIX both this user's
 * and the runs folder writable by no one else. Asked before any launch,
 * again just before the stale sweep, and again just before a run's folder
 * is removed, so nothing is ever swept or removed through a link. Never
 * throws.
 */
function runsFolderHolds(parent: string, kind: RunFolders): boolean {
  try {
    const insights = getInsightsDir()
    if (!samePath(resolve(parent), resolve(insights, kind.dirname))) return false
    const posix = typeof process.getuid === 'function'
    for (const dir of [insights, parent]) {
      const st = lstatSync(dir)
      if (st.isSymbolicLink() || !st.isDirectory()) return false
      if (posix && st.uid !== process.getuid!()) return false
      if (posix && dir === parent && (st.mode & 0o022) !== 0) return false
    }
    const expected = join(realpathSync.native(dirname(insights)), basename(insights), kind.dirname)
    return samePath(realpathSync.native(parent), expected)
  } catch {
    return false
  }
}

/** The runs folder of `kind`, made owner-only (0700) when it is not there
 *  yet; null when it cannot be, or does not hold (runsFolderHolds). The
 *  insights folder is checked before anything is made in it: a link there
 *  is refused, never made through. */
function runsParentFor(kind: RunFolders): string | null {
  const insights = getInsightsDir()
  const parent = join(insights, kind.dirname)
  try {
    let st: Stats | null = null
    try { st = lstatSync(insights) } catch (e) { if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') return null }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) return null
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    return runsFolderHolds(parent, kind) ? parent : null
  } catch {
    return null
  }
}

/** The parent of every Codex model run's working folder (CODEX_RUN_FOLDERS). */
function codexRunsParent(): string | null {
  return runsParentFor(CODEX_RUN_FOLDERS)
}

/** A fresh, empty working folder for one run, as Sentinel makes its
 *  analysis folder: the runs folder is checked again first (runsFolderHolds;
 *  one that no longer holds is refused, and nothing in it is swept);
 *  leftovers of earlier runs go next; once made, the folder's real path must
 *  be `<resources>/insights/<runs folder>/<it>` under the resources folder's
 *  own real path, so neither `insights` nor the runs folder became a link
 *  between the check and the make (one that did is removed, it is empty,
 *  and refused); for Codex an empty `.git` file makes it a project root of
 *  its own, so nothing above it is read. */
function makeRunFolder(parent: string, kind: RunFolders): string {
  if (!runsFolderHolds(parent, kind)) throw new Error('the runs folder is not the one checked')
  sweepStaleFolders(parent, kind.prefix, { maxAgeMs: STALE_CODEX_RUN_FOLDER_MS })
  const dir = mkdtempSync(join(parent, kind.prefix))
  let ok = false
  try {
    const insights = getInsightsDir()
    const expected = join(realpathSync.native(dirname(insights)), basename(insights), kind.dirname, basename(dir))
    ok = samePath(resolve(parent), resolve(insights, kind.dirname)) && samePath(realpathSync.native(dir), expected)
  } catch { ok = false }
  if (!ok) {
    try { rmdirSync(dir) } catch { /* not empty, or gone: leave it */ }
    throw new Error('the report folder is not where it was made')
  }
  if (!kind.marker) return dir
  try {
    writeFileSync(join(dir, '.git'), '', { flag: 'wx' })
  } catch (err) {
    removeRunFolder(dir, parent, kind)
    throw err
  }
  return dir
}

/** Removes a folder makeRunFolder made, and nothing else: its name has the
 *  prefix, its parent is the runs folder, and the runs folder still holds
 *  (runsFolderHolds; when it does not, nothing is removed and a later run's
 *  sweep finds the leftover). */
function removeRunFolder(dir: string, parent: string, kind: RunFolders): void {
  const name = basename(dir)
  if (!name.startsWith(kind.prefix) || name.length === kind.prefix.length) return
  if (!samePath(resolve(dirname(dir)), resolve(parent))) return
  if (!runsFolderHolds(parent, kind)) return
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* a leftover is swept by a later run */ }
}

/** A fresh, empty working folder for one Codex model run (makeRunFolder). */
function makeCodexRunFolder(parent: string): string {
  return makeRunFolder(parent, CODEX_RUN_FOLDERS)
}

/** Removes a folder makeCodexRunFolder made, and nothing else (removeRunFolder). */
function removeCodexRunFolder(dir: string, parent: string): void {
  removeRunFolder(dir, parent, CODEX_RUN_FOLDERS)
}

/** What a Codex model run needs before the account is launched: the
 *  registered Codex package's Insights port (reached through the registry,
 *  as a Cloud Agent's run is, never by import), and the runs folder. Asked
 *  before any lease is taken or any session is read. */
function codexRunPrerequisites(): { ok: true; port: ProviderInsightsOperations; parent: string } | { ok: false; message: string } {
  const port = tryGetProviderPackage('codex')?.insights
  if (!port || typeof port.run !== 'function') return { ok: false, message: 'Codex does not write Insights reports in this version of the app.' }
  const parent = codexRunsParent()
  if (!parent) return { ok: false, message: 'no empty folder could be made for it.' }
  return { ok: true, port, parent }
}

/** The accounts snapshot, or null when it cannot be read. */
function accountsSnapshot(): AccountsSnapshot | null {
  try {
    const svc = getAccountsService() as { snapshot?: () => AccountsSnapshot } | null
    return svc && typeof svc.snapshot === 'function' ? svc.snapshot() : null
  } catch {
    return null
  }
}

/** A Codex account's name for a run and a roll-up: this computer's own
 *  sign-in, else its friendly name, else the provider's label, with
 *  "(Codex)" after it; and its email when the provider gave one. */
function codexAccountInfo(snapshot: AccountsSnapshot | null, accountId: string): { label: string; email?: string } {
  const a = snapshot?.accounts.find((x) => x.id === accountId && x.providerId === 'codex')
  const providerLabel = a?.providerLabel?.trim() ?? ''
  const email = providerLabel.includes('@') ? stripSpoofableText(providerLabel, 254).trim() || undefined : undefined
  const friendly = snapshot?.identities.find((i) => i.id === a?.identityId)?.friendlyName?.trim() ?? ''
  const name = a?.external ? "This computer's Codex" : friendly || providerLabel || 'Codex account'
  return { label: codexMemberLabel(name), ...(email ? { email } : {}) }
}

/** What a Codex report says when the reply fails the check (mockup D14). */
export function codexReplyFailedMessage(reason: string): string {
  return `Codex's reply was not a report the page can show, so nothing was kept. Try New run again. (${stripSpoofableText(reason, 200).trim()})`
}

/** A Codex model run on one account, from a launch the accounts service
 *  prepared (its lease held until the run, and any kill still under way,
 *  has ended). Used by a report and by a roll-up's written analysis on
 *  Codex; the caller has checked codexRunPrerequisites first. */
async function withCodexLaunch<T>(
  accountId: string,
  ownerId: string,
  acknowledgeRealmOnly: boolean,
  onLeased: () => void,
  body: (launch: { executable: string; env: Record<string, string>; sessionsDir: string }) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; message: string; signedOut: boolean }> {
  const svc = getAccountsService()
  if (!svc || typeof svc.prepareLaunch !== 'function') return { ok: false, message: 'accounts are not ready yet. Try again in a moment.', signedOut: false }
  let prepared: Awaited<ReturnType<typeof svc.prepareLaunch>>
  try {
    prepared = await svc.prepareLaunch({
      kind: 'background', providerId: 'codex', ownerId, remote: false, providerAccountId: accountId,
      // An acknowledgement counts only with the account it names (main's rule).
      ...(acknowledgeRealmOnly ? { acknowledgeRealmOnly: true } : {}),
    })
  } catch {
    return { ok: false, message: 'the launch could not be prepared.', signedOut: false }
  }
  if (!prepared.ok) {
    const signedOut = prepared.code === 'not-signed-in' || prepared.state === 'signed-out' || prepared.state === 'expired'
    return { ok: false, message: prepared.message, signedOut }
  }
  const launch = prepared
  onLeased()
  try {
    return { ok: true, value: await body({ executable: launch.executable, env: launch.env, sessionsDir: launch.sessionsDir }) }
  } finally {
    try { launch.lease.release() } catch { /* a release never throws the run away */ }
  }
}

/** One Codex model run in a fresh folder under `parent`; the folder goes after.
 *  The run is the Codex package's Insights port (codexRunPrerequisites), on
 *  the launch's own environment: the account's realm, and nothing of this
 *  app's own. */
async function codexModelRun(launch: { executable: string; env: Record<string, string> }, parent: string, port: ProviderInsightsOperations, prompt: string): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  let folder: string
  try { folder = makeCodexRunFolder(parent) } catch { return { ok: false, message: 'no empty folder could be made for it.' } }
  try {
    // A text-only run: any git the CLI runs stops at the runs folder, never
    // prompts, and takes no optional lock (Sentinel's analysis, round 2).
    const env = { ...launch.env, GIT_CEILING_DIRECTORIES: parent, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    const out = await port.run({ executable: launch.executable, env, cwd: folder, prompt })
    if (!out.ok && out.killSettled instanceof Promise) await out.killSettled
    return out.ok ? { ok: true, text: out.text } : { ok: false, message: out.message }
  } finally {
    removeCodexRunFolder(folder, parent)
  }
}

/** What a Codex report says when its sessions read did not end in time
 *  (CODEX_INSIGHTS_READ_TIME_LIMIT_MS). */
const CODEX_SESSIONS_READ_TOO_SLOW = "This account's Codex sessions could not be read in time, so nothing was sent to Codex. Try New run again."

/**
 * A Codex account's Insights report (mockup screens 1 to 9, approved on the
 * Agent Canvas 2026-10-05). Refused while Codex is off, before a run record
 * or a lock exists (as runInsights for Claude Code). One run per account at
 * a time. Counted as Codex in use from the launch check: until the account's
 * lease is held here, and through the lease from then on. The account must
 * be a Codex registry account; main's launch rule refuses another
 * provider's, a blocked or inactive one, and one that needs this run's own
 * confirmation unless `acknowledgeRealmOnly` names it (mockup D12).
 *
 * Steps: read and count the account's own sessions; one text-only `codex
 * exec` for the cards and the judged figures; check the reply (a reply that
 * fails the check fails the run, D14); keep report.json and kpis.json
 * (owner-only) and the run, with provider 'codex', in the catalogue.
 * Resolves with the run's id whether or not it completed.
 */
export async function runCodexInsights(
  getWindow: () => BrowserWindow | null,
  opts: { accountId: string; acknowledgeRealmOnly?: boolean },
): Promise<string | ProviderLaunchRefused> {
  const refused = providerLaunchRefusal('codex')
  if (refused) return { refused }
  const accountId = opts?.accountId
  if (!isOpaqueId(accountId, 'account')) throw new Error('That is not a Codex account.')
  if (codexInFlight.has(accountId)) throw new Error('Insights already running for this account')
  codexInFlight.add(accountId)
  codexUnleased.add(accountId)

  const id = generateRunId()
  const archiveDir = join(getInsightsDir(), id)
  const run: InsightsRun = { id, timestamp: Date.now(), status: 'running', provider: 'codex', profileId: accountId }
  const publish = (): void => {
    upsertRun(run)
    notifyRenderer(getWindow, run)
  }
  const failRun = (reason: string, authFailed = false): void => {
    // Plain prose before it is kept or logged: a failure can carry the CLI's
    // own text (shared/safe-text).
    const why = stripSpoofableText(reason, 2000)
    run.status = 'failed'
    run.statusMessage = undefined
    run.error = why
    if (authFailed) run.authFailed = true
    publish()
    logError(`[insights] Codex run ${id} failed: ${why}`)
  }
  try {
    ensureDir(archiveDir)
    const info = codexAccountInfo(accountsSnapshot(), accountId)
    if (info.email) run.accountEmail = info.email
    run.statusMessage = 'Step 1/3: Reading the sessions...'
    publish()
    logInfo(`[insights] Codex run ${id} account=${accountId}`)
    // Before the account is launched: the package's Insights port and the
    // runs folder (no lease is taken, and no session read, without both).
    const ready = codexRunPrerequisites()
    if (!ready.ok) {
      failRun(`This report could not be written: ${ready.message}`)
      return id
    }
    const { port, parent } = ready
    const launched = await withCodexLaunch(accountId, `insights:${id}`, opts.acknowledgeRealmOnly === true, () => { codexUnleased.delete(accountId) }, async (launch): Promise<{ failed: string } | { stored: CodexStoredReport; kpis: InsightsData }> => {
      const read = await readCodexSessions(launch.sessionsDir, { runsParent: parent, timeLimitMs: CODEX_INSIGHTS_READ_TIME_LIMIT_MS })
      if (read.timedOut) return { failed: CODEX_SESSIONS_READ_TOO_SLOW }
      if (read.sessions.length === 0) {
        // A link is never followed (a moved sessions folder): say so, rather
        // than that the account has no sessions (review F5).
        return {
          failed: read.folderIsLink || read.linksSkipped > 0
            ? "This account has no Codex sessions from the last 30 days that the app can read: its sessions folder, or a folder in it, is a link, which the app does not follow."
            : 'This account has no Codex sessions from the last 30 days to report on.',
        }
      }
      const counts = countCodexSessions(read.sessions)
      const digest = buildCodexDigest(read.sessions)
      // The previous run's figures as numbers only, never its words.
      const prompt = buildCodexInsightsPrompt(counts, digest, codexPreviousFigures(loadPreviousKpis(id)), read)
      logInfo(`[insights] Codex run ${id}: ${counts.sessions} sessions (${read.filesFound} files, ${read.filesNotRead} not read at the byte limit, ${read.skippedLines} oversized lines skipped, ${read.linksSkipped} links not followed), digest ${digest.included} sessions, prompt ${prompt.length} chars`)
      run.statusMessage = 'Step 2/3: Writing the report...'
      publish()
      // The launch rule once more, right before Codex starts: switched off
      // since the launch was prepared, or while the sessions were read.
      const offNow = providerLaunchRefusal('codex')
      if (offNow) return { failed: offNow.message }
      const out = await codexModelRun(launch, parent, port, prompt)
      if (!out.ok) return { failed: `This report could not be written: ${out.message}` }
      run.statusMessage = 'Step 3/3: Checking the report...'
      publish()
      const parsed = parseCodexInsightsReply(out.text)
      if (!parsed.ok) return { failed: codexReplyFailedMessage(parsed.reason) }
      const stored = codexStoredReport(counts, parsed.reply)
      if (!stored) return { failed: codexReplyFailedMessage('its cards did not check') }
      return { stored, kpis: codexInsightsKpis(counts, parsed.reply) }
    })
    if (!launched.ok) {
      failRun(`This report could not start: ${launched.message}`, launched.signedOut)
      return id
    }
    const r = launched.value
    if ('failed' in r) {
      failRun(r.failed)
      return id
    }
    // Owner-only atomic writes (0600): both hold the account's analysed usage.
    atomicWriteFileSync(join(archiveDir, 'report.json'), JSON.stringify(r.stored, null, 2), { mode: 0o600 })
    atomicWriteFileSync(join(archiveDir, 'kpis.json'), JSON.stringify(r.kpis, null, 2), { mode: 0o600 })
    run.status = 'complete'
    run.statusMessage = undefined
    publish()
  } catch (err: any) {
    failRun(err?.message || 'Unknown error')
  } finally {
    codexUnleased.delete(accountId)
    codexInFlight.delete(accountId)
  }
  return id
}

// ── Cross-account roll-up ────────────────────────────────────────────────────

/**
 * Accounts a roll-up will target: the signed-in profiles whose on-disk dir
 * actually exists (a profile with a missing dir would silently fall back to the
 * primary inside runInsights and get counted twice). An explicit id list is
 * intersected with that set rather than trusted.
 */
export function resolveCrossAccountTargets(profileIds?: string[]): AccountProfile[] {
  const present = listProfiles().filter(p => existsSync(getProfileConfigDir(p.id)))
  if (!profileIds || profileIds.length === 0) return present
  const wanted = new Set(profileIds)
  return present.filter(p => wanted.has(p.id))
}

/** A Codex account a roll-up names (P4.7, mockup C1 A). */
export interface CodexRollupTarget {
  id: string
  label: string
  accountEmail?: string
}

/** Why a roll-up leaves out an account whose runs need their own
 *  confirmation (mockup D12): it is named, never run without one. */
export const CODEX_NEEDS_OWN_CONFIRMATION = 'needs its own confirmation: run it on its own'

/** Why a roll-up leaves out an account whose sign-in check failed (its row
 *  in Settings, Accounts reads "Needs attention", and nothing runs on it
 *  until it is confirmed there): it is named with this reason, never run, as
 *  a Claude Code account whose sign-in fails is named with its reason. */
export const CODEX_NEEDS_ATTENTION = 'needs attention: signed in a different way than before; confirm it in Settings, Accounts'

/**
 * P4.7 (mockup C1 A): the Codex accounts a roll-up names, from the accounts
 * snapshot: the active ones. Each is run, or LEFT OUT and named under "Left
 * out of this comparison" with its reason, never run: one whose sign-in
 * check failed (blocked) needs attention first; one marked "confirm at
 * launch" (this computer's own Codex sign-in, or an unverified one) needs a
 * per-run confirmation a roll-up cannot carry. An explicit id list is
 * intersected with the active set, never trusted; a left-out account never
 * counts toward the accounts a roll-up needs. No snapshot: none.
 */
export function resolveCodexCrossAccountTargets(accountIds?: string[]): { run: CodexRollupTarget[]; leftOut: Array<CodexRollupTarget & { reason: string }> } {
  const snapshot = accountsSnapshot()
  if (!snapshot) return { run: [], leftOut: [] }
  const wanted = accountIds && accountIds.length > 0 ? new Set(accountIds) : null
  const out = { run: [] as CodexRollupTarget[], leftOut: [] as Array<CodexRollupTarget & { reason: string }> }
  const accounts = snapshot.accounts
    .filter((a) => a.providerId === 'codex' && a.lifecycle === 'active' && isOpaqueId(a.id, 'account'))
    .filter((a) => !wanted || wanted.has(a.id))
    // The provider default first, then by name (the New session dialog's order).
    .sort((x, y) => Number(y.isProviderDefault) - Number(x.isProviderDefault) || codexAccountInfo(snapshot, x.id).label.localeCompare(codexAccountInfo(snapshot, y.id).label))
  for (const a of accounts) {
    const info = codexAccountInfo(snapshot, a.id)
    const t: CodexRollupTarget = { id: a.id, label: info.label, ...(info.email ? { accountEmail: info.email } : {}) }
    if (a.operationalState === 'blocked') out.leftOut.push({ ...t, reason: CODEX_NEEDS_ATTENTION })
    else if (a.external || a.unverified) out.leftOut.push({ ...t, reason: CODEX_NEEDS_OWN_CONFIRMATION })
    else out.run.push(t)
  }
  return out
}

/** True while a cross-account fan-out holds the aggregate lock. */
export function isCrossAccountRunning(): boolean {
  return inFlight.has(CROSS_ACCOUNT_KEY)
}

/**
 * Generate every targeted account's report, then synthesize ONE cross-account
 * roll-up from the results.
 *
 * The roll-up is a first-class catalogue entry (`kind: 'aggregate'`) so it shows
 * up in the run picker alongside account runs, but it has no report.html — its
 * only artifact is a kpis.json holding CrossAccountInsights.
 *
 * Failure is per-member, not global: an account whose run fails (or which is
 * already running under its own lock) is recorded in `members` and left out of
 * the synthesis. The roll-up itself only fails when fewer than
 * CROSS_ACCOUNT_MIN_ACCOUNTS accounts produced KPIs, because below that there is
 * nothing to compare.
 */
export async function runCrossAccountInsights(
  getWindow: () => BrowserWindow | null,
  opts?: { profileIds?: string[] }
): Promise<string | ProviderLaunchRefused> {
  // P4.7 (mockup C1 A, approved 2026-10-05): one roll-up over every account of
  // both assistants that is on. Claude Code's accounts are refused while it
  // is off, as before; Codex's are named only while Codex is on (each member
  // run asks again). With neither assistant giving an account, the answer is
  // Claude Code's refusal, as it always was.
  const refused = providerLaunchRefusal('claude')
  const codexOff = providerProbeRefusal('codex')
  const ids = opts?.profileIds
  const codexIds = ids?.filter((x) => isOpaqueId(x, 'account'))
  const claudeIds = ids?.filter((x) => !isOpaqueId(x, 'account'))
  // An explicit list naming no Claude Code account names none (an empty list
  // would otherwise read as "all of them").
  const claudeTargets = refused || (ids && ids.length > 0 && claudeIds!.length === 0) ? [] : resolveCrossAccountTargets(claudeIds)
  const codexTargets = codexOff || (ids && ids.length > 0 && codexIds!.length === 0) ? { run: [], leftOut: [] } : resolveCodexCrossAccountTargets(codexIds)
  // With Claude Code off and no Codex account that can run, there is no
  // roll-up to make: the answer is Claude Code's refusal, as it always was.
  if (refused && codexTargets.run.length === 0) return { refused }
  type Target = { provider: ProviderId; id: string; accountEmail?: string; label: string }
  const targets: Target[] = [
    ...claudeTargets.map((t): Target => ({ provider: 'claude', id: t.id, accountEmail: t.accountEmail, label: crossAccountLabel(t) })),
    ...codexTargets.run.map((t): Target => ({ provider: 'codex', id: t.id, accountEmail: t.accountEmail, label: t.label })),
  ]
  if (targets.length < CROSS_ACCOUNT_MIN_ACCOUNTS) {
    throw new Error(
      `A cross-account report needs at least ${CROSS_ACCOUNT_MIN_ACCOUNTS} signed-in accounts (found ${targets.length})`
    )
  }
  if (inFlight.has(CROSS_ACCOUNT_KEY)) throw new Error('A cross-account report is already being generated')
  inFlight.add(CROSS_ACCOUNT_KEY)
  crossAccountProviders = new Set(targets.map((t) => t.provider))

  const id = generateRunId()
  const archiveDir = join(getInsightsDir(), id)

  const run: InsightsRun = {
    id,
    timestamp: Date.now(),
    status: 'running',
    kind: 'aggregate',
    statusMessage: describeCrossAccountFanout(0, targets.length),
    memberRunIds: [],
    members: [
      ...targets.map<InsightsRunMember>(t => ({
        profileId: t.id,
        accountEmail: t.accountEmail,
        label: t.label,
        status: 'running'
      })),
      // Named, never run, each with its reason: it needs attention first, or
      // its own per-run confirmation (D12).
      ...codexTargets.leftOut.map<InsightsRunMember>(t => ({
        profileId: t.id,
        accountEmail: t.accountEmail,
        label: t.label,
        status: 'failed',
        error: t.reason
      }))
    ]
  }
  const publish = (): void => {
    upsertRun(run)
    notifyRenderer(getWindow, run)
  }
  const patchMember = (profileId: string, patch: Partial<InsightsRunMember>): void => {
    const row = run.members?.find(m => m.profileId === profileId)
    if (row) Object.assign(row, patch)
  }
  // Same reason as runInsights: ensureDir and the opening publish() have to be
  // inside the try, or a transient disk failure there strands CROSS_ACCOUNT_KEY
  // in `inFlight` and every later roll-up reports "already being generated".
  try {
    ensureDir(archiveDir)
    publish()
    logInfo(`[insights] Cross-account run ${id} over ${targets.length} accounts`)

    // Step 1: fan out one normal per-account run each, bounded so a wide
    // multi-account setup doesn't put N interactive Claude PTYs on the machine.
    let done = 0
    await mapWithLimit(targets, CROSS_ACCOUNT_MAX_PARALLEL, async (target) => {
      try {
        const started = target.provider === 'codex'
          ? await runCodexInsights(getWindow, { accountId: target.id })
          : await runInsights(getWindow, { profileId: target.id })
        // Its assistant switched off during the fan-out: this member never ran.
        if (typeof started !== 'string') {
          patchMember(target.id, { status: 'failed', error: started.refused.message })
          return
        }
        const memberRunId = started
        // runInsights resolves with the id even when the run failed, so the
        // outcome has to be read back off the catalogue rather than inferred.
        const memberRun = loadCatalogue().runs.find(r => r.id === memberRunId)
        patchMember(target.id, {
          runId: memberRunId,
          status: memberRun?.status === 'complete' ? 'complete' : 'failed',
          // Copied unconditionally: a member that COMPLETED but produced no KPIs
          // carries its reason here (e.g. an expired OAuth session), and that is
          // exactly the case the roll-up needs to explain.
          error: memberRun?.error,
          kpisUnavailable: memberRun?.kpisUnavailable,
          authFailed: memberRun?.authFailed
        })
      } catch (err: any) {
        // The per-account lock rejecting (that account is already running) lands
        // here, as does anything thrown before a run entry existed.
        patchMember(target.id, { status: 'failed', error: err?.message || 'Run could not be started' })
      } finally {
        done++
        run.statusMessage = describeCrossAccountFanout(done, targets.length)
        publish()
      }
    })

    // Step 2: collect the members that actually produced KPIs.
    const members: CrossAccountMember[] = []
    targets.forEach((target, i) => {
      const row = run.members?.find(m => m.profileId === target.id)
      if (!row || row.status !== 'complete' || !row.runId) return
      const kpis = getInsightsKpis(row.runId) as InsightsData | null
      if (!kpis) {
        patchMember(target.id, { kpisUnavailable: true })
        return
      }
      members.push({
        key: `A${i + 1}`,
        runId: row.runId,
        profileId: target.id,
        accountEmail: target.accountEmail,
        label: target.label,
        kpis,
        ...(target.provider === 'codex' ? { provider: 'codex' as const } : {})
      })
    })

    if (members.length < CROSS_ACCOUNT_MIN_ACCOUNTS) {
      run.status = 'failed'
      run.statusMessage = undefined
      run.error =
        `Only ${members.length} of ${targets.length} accounts produced KPIs; ` +
        `a cross-account report needs at least ${CROSS_ACCOUNT_MIN_ACCOUNTS}`
      publish()
      logError(`[insights] Cross-account run ${id} aborted: ${run.error}`)
      return id
    }

    run.status = 'extracting_kpis'
    run.statusMessage = describeCrossAccountFanout(targets.length, targets.length)
    publish()

    // The synthesis pass needs a signed-in identity to run at all, but reads
    // nothing from that account's disk — the comparison travels on stdin.
    //
    // Use a member whose OWN extraction just succeeded, because that is proof its
    // credentials work right now. Using the primary unconditionally cost a real
    // run its entire written analysis: the primary account's OAuth session had
    // expired, so the synthesis failed with 0 tokens and the roll-up degraded to
    // numbers-only even though two other accounts had authenticated fine seconds
    // earlier. Prefer the primary WHEN it is among the working members, so the
    // roll-up is still not attributed to an arbitrary account without cause.
    const primaryId = getPrimaryProfileId()
    // P4.7: the primary is a Claude Code profile; no Codex account id can
    // equal it, so with Claude Code off the first member is a Codex account.
    const synthesisMember = members.find(m => m.profileId === primaryId) ?? members[0]
    logInfo(
      `[insights] Cross-account synthesis running under ${synthesisMember.label}` +
      `${synthesisMember.profileId === primaryId ? ' (primary)' : ' (primary unavailable or did not produce KPIs)'}`
    )
    // Compute the roll-up ONCE and build the prompt from it, so the model reasons
    // over exactly the table the user will see — including its label conflicts and
    // its suppressed totals. Sending the computed comparison rather than each
    // member's raw kpis.json also cuts this prompt by ~88% (measured on real
    // archives: 30,477 -> 3,619 bytes for two accounts).
    const baseline = assembleCrossAccount(members, null)
    // The assistants of the members that produced figures (a roll-up whose
    // Claude Code members all failed compares Codex accounts only).
    const prompt = buildCrossAccountPromptFrom(baseline, new Set(members.map((m) => m.provider ?? 'claude')))
    logInfo(
      `[insights] Cross-account synthesis payload: ${prompt.length} chars, ` +
      `${baseline.comparison.length} shared / ${baseline.uniqueMetrics.length} unique metrics, ` +
      `windowsComparable=${baseline.windowsComparable}`
    )
    if (synthesisMember.provider === 'codex') {
      // P4.7: the written analysis runs on a Codex account (the first that
      // produced figures, when the primary did not): one text-only `codex
      // exec` on that account's allowance and lease, as its report runs
      // (read-only, no tools, the comparison on stdin as data). Not started
      // once Codex has been switched off (numbers only, and why), and checked
      // before the account is launched (codexRunPrerequisites).
      const codexRefused = providerLaunchRefusal('codex')
      const ready = codexRefused ? null : codexRunPrerequisites()
      const written = !ready || !ready.ok
        ? null
        : await withCodexLaunch(synthesisMember.profileId!, `insights:${id}:synthesis`, false, () => {}, (launch) => codexModelRun(launch, ready.parent, ready.port, prompt))
      // Codex's prose is kept as plain text (controls and spoofing characters replaced).
      const parsed = written && written.ok && written.value.ok ? parseCrossAccountNarrative(written.value.text) : null
      const narrative = parsed ? plainCrossAccountNarrative(parsed) : null
      if (codexRefused) {
        run.error = `No written analysis. ${codexRefused.message}`
      } else if (!written) {
        run.error = `No written analysis: ${ready && !ready.ok ? ready.message : 'it could not be started.'}`
      } else if (!narrative) {
        const why = stripSpoofableText(!written.ok ? written.message : !written.value.ok ? written.value.message : 'the written analysis did not return usable output', 500)
        logError(`[insights] Cross-account synthesis on Codex unusable: ${why}; falling back to a numbers-only roll-up`)
        run.error = !written.ok && written.signedOut
          ? `No written analysis: ${synthesisMember.label} needs to sign in again (${why})`
          : `No written analysis: ${why}`
        if (!written.ok && written.signedOut) run.authFailed = true
      }
      const data = withNarrative(baseline, narrative)
      atomicWriteFileSync(join(archiveDir, 'kpis.json'), JSON.stringify(data, null, 2), { mode: 0o600 })
      run.status = 'complete'
      run.statusMessage = undefined
      run.memberRunIds = members.map(m => m.runId)
      publish()
      logInfo(`[insights] Cross-account run ${id} complete: ${members.length} accounts, ${data.comparison.length} shared metrics, synthesis=${data.synthesis} (Codex)`)
      return id
    }
    const home = synthesisMember.profileId
      ? getProfileConfigDir(synthesisMember.profileId)
      : resolveInsightsAccount(undefined).home
    // The synthesis is another Claude Code run: not started once Claude Code
    // has been switched off since the roll-up began (numbers only, and why).
    // It holds no tools and loads no settings file, memory file or MCP
    // server, keeps no transcript (buildCrossAccountSpawnArgs,
    // CROSS_ACCOUNT_SYNTHESIS_ENV), and runs in an empty folder made for it
    // and removed after, never this app's own folder (ADR-013 section 5).
    const synthesisRefused = providerLaunchRefusal('claude')
    let result: { code: number; stdout: string; stderr: string } | null = null
    let noFolder = false
    if (!synthesisRefused) {
      const parent = runsParentFor(CLAUDE_SYNTHESIS_FOLDERS)
      let folder: string | null = null
      try { folder = parent ? makeRunFolder(parent, CLAUDE_SYNTHESIS_FOLDERS) : null } catch { folder = null }
      if (!parent || !folder) {
        noFolder = true
      } else {
        try {
          result = await spawnClaudeHeadless(buildCrossAccountSpawnArgs(), 600000, prompt, home, undefined, {
            cwd: folder, env: CROSS_ACCOUNT_SYNTHESIS_ENV, transportEnv: synthesisTransportEnv(home),
          })
        } finally {
          removeRunFolder(folder, parent, CLAUDE_SYNTHESIS_FOLDERS)
        }
      }
    }

    const usage = result ? describeClaudeUsage(result.stdout) : null
    if (usage) logInfo(`[insights] Cross-account synthesis usage: ${usage}`)

    const narrative = result && result.code === 0 ? parseCrossAccountNarrative(result.stdout) : null
    if (!result && noFolder) {
      logInfo('[insights] Cross-account synthesis not started (no empty folder); numbers-only roll-up')
      run.error = 'No written analysis: no empty folder could be made for it.'
    } else if (!result) {
      // Nothing ran: no exit code or output to report, only the reason.
      logInfo(`[insights] Cross-account synthesis not started (${synthesisRefused!.code}); numbers-only roll-up`)
      run.error = `No written analysis. ${synthesisRefused!.message}`
    } else if (!narrative) {
      // Record WHY there is no written analysis. Degrading silently to
      // numbers-only left a real run looking like the model had nothing to say,
      // when in fact the synthesis account's sign-in had expired.
      const synthesisReason = describeClaudeError(result.stdout)
      const authFailed = isAuthFailure(readClaudeFailureFacts(result.stdout, synthesisReason))
      logError(
        `[insights] Cross-account synthesis unusable (code ${result.code}): ` +
        `${synthesisReason ?? 'no reason reported'}; falling back to a numbers-only roll-up`
      )
      logError('[insights] Raw synthesis output:', result.stdout.slice(0, 500))
      run.error = authFailed
        ? `No written analysis: ${synthesisMember.label} needs to sign in again (${synthesisReason ?? 'authentication failed'})`
        : `No written analysis: ${synthesisReason ?? 'the synthesis pass did not return usable output'}`
      if (authFailed) run.authFailed = true
    }

    const data = withNarrative(baseline, narrative)
    // Owner-only atomic write (0600): this kpis.json carries cross-account usage.
    atomicWriteFileSync(join(archiveDir, 'kpis.json'), JSON.stringify(data, null, 2), { mode: 0o600 })

    run.status = 'complete'
    run.statusMessage = undefined
    run.memberRunIds = members.map(m => m.runId)
    publish()
    logInfo(
      `[insights] Cross-account run ${id} complete: ${members.length} accounts, ` +
      `${data.comparison.length} shared metrics, synthesis=${data.synthesis}`
    )
  } catch (err: any) {
    run.status = 'failed'
    run.statusMessage = undefined
    run.error = err?.message || 'Unknown error'
    publish()
  } finally {
    inFlight.delete(CROSS_ACCOUNT_KEY)
    crossAccountProviders = new Set()
  }

  return id
}

export function getCatalogue(): InsightsCatalogue {
  return loadCatalogue()
}

// Run ids are renderer-supplied and used as a PATH COMPONENT under the insights
// dir. Reject anything outside a strict charset so a crafted id can never escape
// that directory. A charset allowlist is used rather than a shape-specific regex
// because the id format has already changed once (older archives are
// `YYYY-MM-DD-HHMMSS`, newer ones carry a `-mmmNNN` suffix) — this cannot break a
// past or future format, while admitting no `.`, `/` or `\`.
// Mirrors isValidNoteId in ipc/notes-handlers.ts, which exists for the same reason.
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/
export function isValidRunId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && RUN_ID_RE.test(id)
}

/** A Codex run's report.json, as main hands it to the page: a regular file
 *  (never a link or a folder; on POSIX opened without following one, and
 *  the open file the same one lstat saw), at most the page's own cap
 *  (CODEX_REPORT_MAX_BYTES); anything else is no report. Never throws. */
function readCodexReportFile(file: string): string | null {
  try {
    const st = lstatSync(file)
    if (!st.isFile() || st.size > CODEX_REPORT_MAX_BYTES) return null
    const fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    try {
      const open = fstatSync(fd)
      if (!open.isFile() || open.dev !== st.dev || open.ino !== st.ino) return null
      // One byte past the cap tells a file that grew since from one that fits.
      const buf = Buffer.alloc(CODEX_REPORT_MAX_BYTES + 1)
      let got = 0
      for (let n = 1; n > 0 && got < buf.length; got += n) n = readSync(fd, buf, got, buf.length - got, got)
      return got > CODEX_REPORT_MAX_BYTES ? null : buf.subarray(0, got).toString('utf-8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** The network settings (proxies, certificates: only what the Claude
 *  package keeps as transport) the written analysis's account sets in its
 *  settings file, handed to the run as variables, since it loads no
 *  settings file (as Sentinel's analysis does). None when there is no such
 *  file, it is too large, or the package cannot say. Never throws. */
function synthesisTransportEnv(home: string | null): Readonly<Record<string, string>> {
  try {
    const pick = tryGetProviderPackage('claude')?.managedLaunch?.transportSettingsEnv
    if (typeof pick !== 'function') return {}
    const file = join(home ? join(home, '.claude') : sharedRoot(), 'settings.json')
    const st = statSync(file)
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return {}
    return pick(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

export function getInsightsReport(runId: string): string | null {
  if (!isValidRunId(runId)) return null
  // P4.7: a Codex run keeps its report as data (report.json), which the page
  // checks and draws as text (shared/insights-codex-report.ts); it never has
  // a report.html, and its report.json is never handed over as one.
  if (loadCatalogue().runs.find((r) => r.id === runId)?.provider === 'codex') {
    return readCodexReportFile(join(getInsightsDir(), runId, 'report.json'))
  }
  const reportPath = join(getInsightsDir(), runId, 'report.html')
  if (!existsSync(reportPath)) return null
  return readFileSync(reportPath, 'utf-8')
}

export function getInsightsKpis(runId: string): unknown | null {
  if (!isValidRunId(runId)) return null
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
  if (profileId) return inFlight.has(accountKey(profileId)) || codexInFlight.has(profileId)
  return inFlight.size > 0 || codexInFlight.size > 0
}

/** WP2: Claude Code's insights runs in flight (each account's, and a
 *  cross-account roll-up that runs Claude Code), counted as Claude Code in
 *  use for the switch-off rule (provider-in-use.ts). A run takes its lock in
 *  the same step as the launch check, and releases it in its finally. A Codex
 *  report is never counted here (P4.7): it is Codex in use. */
export function countInsightsRunsInFlight(): number {
  const crossNotClaude = inFlight.has(CROSS_ACCOUNT_KEY) && !crossAccountProviders.has('claude') ? 1 : 0
  return inFlight.size - crossNotClaude
}

/** P4.7: Codex's insights runs that hold no account lease, counted as Codex
 *  in use (provider-in-use.ts): a Codex report from its launch check until
 *  its account's lease is held (then the lease counts it, as a Codex cloud
 *  agent's), and a cross-account roll-up that runs Codex, for its length. */
export function countCodexInsightsRunsUnleased(): number {
  const crossCodex = inFlight.has(CROSS_ACCOUNT_KEY) && crossAccountProviders.has('codex') ? 1 : 0
  return codexUnleased.size + crossCodex
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
