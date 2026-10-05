import { ipcMain, BrowserWindow } from 'electron'
import {
  runInsights,
  runCodexInsights,
  runCrossAccountInsights,
  getCatalogue,
  getInsightsReport,
  getInsightsKpis,
  getLatestRun,
  isRunning,
  isValidRunId,
  cleanupStuckRuns
} from '../insights-runner'
import { isValidProfileId } from '../account-profiles'
import { isOpaqueId } from '../../shared/providers'
import { appWindowSender } from './trusted-sender'

/** What main answers a run request it does not take (WP2 PR 4, P4.7): the
 *  same shape as a refused agent request (CloudAgentRequestRejected), which
 *  the Insights page shows as is. Answered, never thrown. */
export const INSIGHTS_REJECTED_UNTRUSTED = { rejected: 'This request did not come from the app window.' } as const
export const INSIGHTS_REJECTED_INVALID = { rejected: 'That Insights request was not valid.' } as const

const ID_MAX = 128
const ALL_MAX = 64

/** A plain object whose own keys are all in `allowed`. */
function onlyKeys(v: unknown, allowed: readonly string[]): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return false
  return Object.keys(v).every((k) => allowed.includes(k))
}

/** A Claude Code profile id, and never an id of the registry's own classes
 *  (the profile shape alone would also take an `acct-` id). */
const isClaudeProfileId = (v: unknown): v is string => typeof v === 'string' && v.length <= ID_MAX && isValidProfileId(v) && !isOpaqueId(v)
/** A Codex account: the registry's account class. */
const isCodexAccountId = (v: unknown): v is string => typeof v === 'string' && v.length <= ID_MAX && isOpaqueId(v, 'account')

/** A checked `insights:run` request. */
export type InsightsRunRequest =
  | { provider: 'claude'; profileId?: string }
  | { provider: 'codex'; accountId: string; acknowledgeRealmOnly?: true }

/**
 * P4.7: the strict check on `insights:run` (the S0 shape, `{ profileId,
 * provider }`, plus a run's per-run confirmation). Absent options, or no
 * provider, are a Claude Code run as before; a Claude Code profile id that
 * is not a valid one is dropped at the boundary as before (the runner then
 * uses the primary). Refused: any key outside the shape, a provider other
 * than Claude Code or Codex, a registry id on a Claude Code run (a
 * mismatched provider), anything but a Codex account id on a Codex run (a
 * wrong id class), and a confirmation that is not exactly true, or on a
 * Claude Code run. Null for a refused request. Never throws.
 */
export function checkInsightsRunRequest(opts: unknown): InsightsRunRequest | null {
  try { return readRunRequest(opts) } catch { return null }
}

function readRunRequest(opts: unknown): InsightsRunRequest | null {
  if (opts === undefined || opts === null) return { provider: 'claude' }
  if (!onlyKeys(opts, ['profileId', 'provider', 'acknowledgeRealmOnly'])) return null
  const provider = opts.provider === undefined ? 'claude' : opts.provider
  if (provider === 'claude') {
    if (opts.acknowledgeRealmOnly !== undefined) return null
    if (opts.profileId === undefined) return { provider: 'claude' }
    if (typeof opts.profileId !== 'string' || isOpaqueId(opts.profileId)) return null
    return isClaudeProfileId(opts.profileId) ? { provider: 'claude', profileId: opts.profileId } : { provider: 'claude' }
  }
  if (provider === 'codex') {
    if (!isCodexAccountId(opts.profileId)) return null
    if (opts.acknowledgeRealmOnly !== undefined && opts.acknowledgeRealmOnly !== true) return null
    return { provider: 'codex', accountId: opts.profileId, ...(opts.acknowledgeRealmOnly === true ? { acknowledgeRealmOnly: true as const } : {}) }
  }
  return null
}

/** P4.7: the check on `insights:runAll`: absent, or `{ profileIds }` whose
 *  every id is a Claude Code profile id or a Codex account id, at most 64.
 *  The runner intersects them with the real accounts, so an id can only
 *  narrow the set. Null for a refused request. Never throws. */
export function checkInsightsRunAllRequest(opts: unknown): { profileIds?: string[] } | null {
  try { return readRunAllRequest(opts) } catch { return null }
}

function readRunAllRequest(opts: unknown): { profileIds?: string[] } | null {
  if (opts === undefined || opts === null) return {}
  if (!onlyKeys(opts, ['profileIds'])) return null
  if (opts.profileIds === undefined) return {}
  if (!Array.isArray(opts.profileIds) || opts.profileIds.length > ALL_MAX) return null
  if (!opts.profileIds.every((id) => isClaudeProfileId(id) || isCodexAccountId(id))) return null
  return opts.profileIds.length > 0 ? { profileIds: [...opts.profileIds] as string[] } : {}
}

export function registerInsightsHandlers(getWindow: () => BrowserWindow | null): void {
  // On startup, mark any stuck runs as failed
  cleanupStuckRuns()
  /** The app's own window, top frame only (trusted-sender.ts). */
  const trusted = appWindowSender(getWindow)
  // The profileId becomes a path component (and the run's HOME) once it reaches
  // resolveInsightsAccount. Drop an invalid one at the boundary rather than
  // forwarding it: the runner then resolves the primary account, which is
  // exactly what already happens for a profileId whose directory is missing.
  // P4.7: a run starts only for the app's own window, and a Codex run names a
  // Codex account (checkInsightsRunRequest).
  ipcMain.handle('insights:run', async (event, opts?: unknown) => {
    if (!trusted(event)) return INSIGHTS_REJECTED_UNTRUSTED
    const req = checkInsightsRunRequest(opts)
    if (!req) return INSIGHTS_REJECTED_INVALID
    if (req.provider === 'codex') {
      return runCodexInsights(getWindow, { accountId: req.accountId, ...(req.acknowledgeRealmOnly ? { acknowledgeRealmOnly: true } : {}) })
    }
    return runInsights(getWindow, req.profileId ? { profileId: req.profileId } : undefined)
  })

  // Cross-account roll-up. The id list is checked here and intersected with
  // the real accounts inside the runner, so a bogus id from the renderer can
  // only ever shrink the target set, never widen it or reach a path.
  ipcMain.handle('insights:runAll', async (event, opts?: unknown) => {
    if (!trusted(event)) return INSIGHTS_REJECTED_UNTRUSTED
    const req = checkInsightsRunAllRequest(opts)
    if (!req) return INSIGHTS_REJECTED_INVALID
    return runCrossAccountInsights(getWindow, req.profileIds ? { profileIds: req.profileIds } : undefined)
  })

  ipcMain.handle('insights:getCatalogue', async () => {
    return getCatalogue()
  })

  // Guarded at the boundary AND inside the runner: the renderer's runId becomes a
  // path component, so a crafted id is rejected before it reaches any join. Two
  // layers on purpose — a future caller of the runner cannot bypass the check by
  // not going through this handler.
  ipcMain.handle('insights:getReport', async (_event, runId: string) => {
    if (!isValidRunId(runId)) return null
    return getInsightsReport(runId)
  })

  ipcMain.handle('insights:getKpis', async (_event, runId: string) => {
    if (!isValidRunId(runId)) return null
    return getInsightsKpis(runId)
  })

  ipcMain.handle('insights:getLatest', async () => {
    return getLatestRun()
  })

  ipcMain.handle('insights:isRunning', async () => {
    return isRunning()
  })
}
