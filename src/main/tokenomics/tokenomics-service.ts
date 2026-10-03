import { join } from 'node:path'
import { homedir } from 'node:os'
import { TokenomicsSupervisor } from './tk-supervisor'
import { forkTokenomicsWorker } from './fork-tokenomics-worker'
import { getAllPricing, fetchModelPricing } from './tk-pricing'
import { readConfig } from '../config-manager'
import { onRegistryReload } from '../model-registry-service'
import { getDataDirectory, getResourcesDirectory } from '../data-paths'
import type { TkConfigDim, TkSessionsRoot } from './tk-types'
import { TK_CODEX_EXTERNAL, tkAccountKey } from './tk-types'
import { getAccountsService } from '../provider-accounts'
import { logError } from '../debug-logger'

/**
 * Reserved attribution id for the Ask Conductor help session (#465). Its spend
 * is real but it is not project work, so it must not pollute the "External /
 * no config" bucket the cost views use for unrecognised spend. The help
 * session's cwd is the staged `<resources>/help` workspace, so a synthetic
 * config dim pointing there lets the ordinary cwd->config matcher file it
 * under its own labeled row. Saved-config ids are crypto-random hex
 * (shared/id.ts), so this literal can never collide with one.
 */
export const TK_HELP_CONFIG_ID = '__ask-help__'

let _sup: TokenomicsSupervisor | null = null
let _unsubReload: (() => void) | null = null
let _unsubAccounts: (() => void) | null = null

/** Whose sessions a Codex folder holds (usage track MP9): this computer's own
 *  home is `codex:external`, an account's realm `codex:<accountId>`, and a
 *  realm no account owns yet is not recorded. */
export function codexSessionsRoot(r: { dir: string; accountId: string | null; external: boolean }): TkSessionsRoot {
  return { dir: r.dir, accountKey: r.external ? TK_CODEX_EXTERNAL : tkAccountKey('codex', r.accountId) }
}

/** WP2 (plan A13): each Codex account runs in its own realm and writes its
 *  transcripts there, so the index follows those folders as accounts are
 *  added, removed or signed out, beside the user's own ~/.codex. Each folder
 *  goes with its account's key (MP9). */
function followCodexRealmDirs(): void {
  const svc = getAccountsService()
  // MP9 round 1 (Q-4): the index settles its one-off attribution only once
  // it has been told the account folders, so it is told "none" when there
  // is no accounts service to ask.
  if (!svc) { _sup?.setCodexRealmSessionsDirs([]); return }
  let lastKey = ''
  let running = false
  let again = false
  const refresh = async (): Promise<void> => {
    if (running) { again = true; return }
    running = true
    try {
      do {
        again = false
        const roots = await svc.sessionsRoots('codex')
        // The registry not read yet: nothing is named until it is (lens B).
        if (roots === null) continue
        const dirs = roots.map(codexSessionsRoot)
        const key = JSON.stringify(dirs)
        if (key !== lastKey) { lastKey = key; _sup?.setCodexRealmSessionsDirs(dirs) }
      } while (again)
    } catch (err) {
      logError(`[tokenomics] Codex account folders not refreshed: ${(err as Error)?.message ?? err}`)
      // Never named yet: none for now (Q-4), so the index is not held back;
      // a later refresh names them.
      if (lastKey === '') { lastKey = '[]'; _sup?.setCodexRealmSessionsDirs([]) }
    } finally {
      running = false
    }
  }
  _unsubAccounts = svc.subscribe(() => { void refresh() })
  void refresh()
}

// Minimal shape of a saved config we attribute usage to. Defined locally rather
// than importing the renderer-store `TerminalConfig` (main must not import from
// the renderer; only these three fields are needed here).
interface SavedConfigRecord { id: string; label: string; workingDirectory?: string }

function loadConfigDims(): TkConfigDim[] {
  const configs = readConfig<SavedConfigRecord[]>('configs') ?? []
  const dims = configs
    .filter((c): c is SavedConfigRecord & { workingDirectory: string } => !!c.workingDirectory)
    .map((c) => ({ configId: c.id, label: c.label, workingDirectory: c.workingDirectory }))
  // Ask Conductor 'help' bucket (#465). The matcher is longest-prefix, so this
  // synthetic dim only ever claims spend from inside `<resources>/help` itself;
  // it cannot shadow a real config (and getResourcesDirectory never throws —
  // it falls back under the data directory before the user picks one). Known
  // edge, shared with every saved config: the worker's isJunkCwd runs first,
  // so a resources dir under a junk-flagged segment (temp/, windows/) sends
  // this spend to "External / no config" instead. Fails safe, never wrong.
  dims.push({ configId: TK_HELP_CONFIG_ID, label: 'Ask Conductor', workingDirectory: join(getResourcesDirectory(), 'help') })
  return dims
}

export function initTokenomics(opts: { emit: (channel: string, payload: unknown) => void }): void {
  if (_sup) return
  // Best-effort pricing refresh (LiteLLM 24h cache); never block startup.
  void fetchModelPricing().catch(() => {})
  const sup = new TokenomicsSupervisor({
    forkChild: forkTokenomicsWorker,
    dbPath: join(getDataDirectory(), 'tokenomics.db'),
    pricing: getAllPricing(),
    configs: loadConfigDims(),
    claudeProjectsDir: join(homedir(), '.claude', 'projects'),
    codexSessionsDir: join(homedir(), '.codex', 'sessions'),
    emit: opts.emit,
  })
  sup.start()
  _sup = sup
  // Once the LiteLLM fetch settles, push refreshed pricing into the worker.
  void fetchModelPricing().then(() => { _sup?.setPricing(getAllPricing()) }).catch(() => {})
  // Registry hot-reload must reach the worker's pricing CTE (spec §4 consumer 2).
  _unsubReload = onRegistryReload(() => { _sup?.setPricing(getAllPricing()) })
  followCodexRealmDirs()
}

export function getTokenomicsSupervisor(): TokenomicsSupervisor | null { return _sup }

/** Push the current saved-config dimension to the worker (call after config edits). */
export function refreshTokenomicsConfigs(): void { _sup?.setConfigs(loadConfigDims()) }

export function shutdownTokenomics(): void {
  _sup?.shutdown(); _sup = null
  _unsubReload?.(); _unsubReload = null
  _unsubAccounts?.(); _unsubAccounts = null
}
