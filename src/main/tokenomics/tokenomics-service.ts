import { join } from 'node:path'
import { homedir } from 'node:os'
import { TokenomicsSupervisor } from './tk-supervisor'
import { forkTokenomicsWorker } from './fork-tokenomics-worker'
import { getAllPricing, fetchModelPricing } from './tk-pricing'
import { readConfig } from '../config-manager'
import { getDataDirectory } from '../data-paths'
import type { TerminalConfig } from '../../shared/types'
import type { TkConfigDim } from './tk-types'

let _sup: TokenomicsSupervisor | null = null

function loadConfigDims(): TkConfigDim[] {
  const configs = readConfig<TerminalConfig[]>('configs') ?? []
  return configs
    .filter((c) => c.workingDirectory)
    .map((c) => ({ configId: c.id, label: c.label, workingDirectory: c.workingDirectory }))
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
}

export function getTokenomicsSupervisor(): TokenomicsSupervisor | null { return _sup }

/** Push the current saved-config dimension to the worker (call after config edits). */
export function refreshTokenomicsConfigs(): void { _sup?.setConfigs(loadConfigDims()) }

export function shutdownTokenomics(): void { _sup?.shutdown(); _sup = null }
