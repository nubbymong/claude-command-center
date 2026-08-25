import { join } from 'node:path'
import { homedir } from 'node:os'
import { TokenomicsSupervisor } from './tk-supervisor'
import { forkTokenomicsWorker } from './fork-tokenomics-worker'
import { getAllPricing, fetchModelPricing } from './tk-pricing'
import { readConfig } from '../config-manager'
import { onRegistryReload } from '../model-registry-service'
import { getDataDirectory, getResourcesDirectory } from '../data-paths'
import type { TkConfigDim } from './tk-types'

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
  // it falls back under the data directory before the user picks one).
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
}

export function getTokenomicsSupervisor(): TokenomicsSupervisor | null { return _sup }

/** Push the current saved-config dimension to the worker (call after config edits). */
export function refreshTokenomicsConfigs(): void { _sup?.setConfigs(loadConfigDims()) }

export function shutdownTokenomics(): void { _sup?.shutdown(); _sup = null; _unsubReload?.(); _unsubReload = null }
