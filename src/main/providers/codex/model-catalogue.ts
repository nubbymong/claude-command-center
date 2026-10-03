// The models the installed Codex CLI offers in its own picker, read from the
// CLI itself (P3.9, row 39): `codex debug models --bundled`, which prints the
// catalogue shipped in the binary as JSON (each model's slug, display name,
// visibility, reasoning levels and priority) with no sign-in and no network
// (P3.1 evidence, addenda 12 and 13). Sentinel compares the model registry
// with this list, so its Codex check follows the version actually installed
// rather than the list shipped with this build.
//
// The read runs the executable discovery last proved, re-verified just before
// and after the run (a file replaced meanwhile gives no list), and only for a
// version the managed flows may use. It runs in a FRESH, EMPTY Codex home made
// for it and removed after it, never an account's folder: in a signed-in home
// Codex refreshes its model list from the account over the network, and
// writes there (its model cache). The argv is the runner's constant
// (cli-runner.ts, `models`), the environment the allowlist (cli-env.ts), the
// working folder the executable's own (the runner's rule). The output is
// capped, and read strictly: one JSON object with a `models` list, each model
// an object; only the models the picker lists (`visibility: "list"`), each
// with a slug the app accepts as a Codex model id; anything else is no list.
import type { ModelCatalogueEntry, ModelCatalogueResult, ModelCatalogueFailureCode } from '../core'
import { isCodexModelId } from '../../../shared/model-registry'
import { stripSpoofableText } from '../../../shared/safe-text'
import { codexCommandLine, codexShellEnv } from './cli-runner'
import type { CodexCommand, CodexRunOptions, CodexRunResult } from './cli-runner'
import { codexCliEnv } from './cli-env'
import { verifyCodexExecutable, codexCompatibilityAllowsUse } from './discovery'
import type { CodexDiscovery, CodexDiscoveryDeps } from './discovery'

/** How long the read may take. */
export const CODEX_CATALOGUE_TIMEOUT_MS = 15_000
/** The most output kept (characters); more is no list. The 0.153.4 catalogue
 *  is about half a megabyte (each model carries its own instructions). */
export const CODEX_CATALOGUE_MAX_CHARS = 4 * 1024 * 1024
/** The most catalogue entries read; more is no list. */
export const CODEX_CATALOGUE_MAX_MODELS = 256
/** A display name longer than this is cut. */
export const CODEX_CATALOGUE_LABEL_MAX = 64

export interface CodexCatalogueDeps {
  /** The CLI discovery last proved: the package's own record, never a caller's. */
  proven(): CodexDiscovery | null
  /** Re-resolving and re-reading the executable, as a launch does. */
  executablePorts: Pick<CodexDiscoveryDeps, 'resolve' | 'realpath' | 'stat' | 'platform'>
  /** The environment the allowlist is taken from (the login shell's PATH on macOS and Linux). */
  baseEnv(): Promise<Readonly<Record<string, string | undefined>>>
  run(cmd: CodexCommand, opts: CodexRunOptions): Promise<CodexRunResult>
  /** A fresh, empty Codex home for this read alone, removed by `dispose`. */
  scratchHome(): { home: string; dispose(): void }
}

const own = (o: object, k: string): unknown => (Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined)
const isRecord = (v: unknown): v is object => !!v && typeof v === 'object' && !Array.isArray(v)

/** The picker's models from `codex debug models` output, in the catalogue's
 *  priority order, or null when the output is not a catalogue this app reads
 *  (fail closed: no list is never read as "no models"). Exported for the test. */
export function parseCodexModelCatalogue(stdout: string): ModelCatalogueEntry[] | null {
  if (typeof stdout !== 'string' || stdout.length > CODEX_CATALOGUE_MAX_CHARS) return null
  let doc: unknown
  try { doc = JSON.parse(stdout.trim()) } catch { return null }
  if (!isRecord(doc)) return null
  const models = own(doc, 'models')
  if (!Array.isArray(models) || models.length === 0 || models.length > CODEX_CATALOGUE_MAX_MODELS) return null
  const listed: Array<ModelCatalogueEntry & { priority: number; index: number }> = []
  const seen = new Set<string>()
  for (let index = 0; index < models.length; index++) {
    const m: unknown = models[index]
    if (!isRecord(m)) return null
    const visibility = own(m, 'visibility')
    if (typeof visibility !== 'string') return null
    if (visibility !== 'list') continue
    const id = own(m, 'slug')
    if (!isCodexModelId(id) || seen.has(id)) return null
    seen.add(id)
    const name = own(m, 'display_name')
    const label = typeof name === 'string' ? stripSpoofableText(name, CODEX_CATALOGUE_LABEL_MAX).trim() : ''
    const p = own(m, 'priority')
    listed.push({ id, label: label || id, priority: typeof p === 'number' && Number.isFinite(p) ? p : Number.POSITIVE_INFINITY, index })
  }
  if (listed.length === 0) return null
  listed.sort((a, b) => (a.priority === b.priority ? a.index - b.index : a.priority < b.priority ? -1 : 1))
  return listed.map(({ id, label }) => ({ id, label }))
}

const fail = (code: ModelCatalogueFailureCode, detail: string): ModelCatalogueResult => ({ ok: false, code, detail })

/** Read the installed CLI's catalogue. Never throws. */
export async function readCodexModelCatalogue(deps: CodexCatalogueDeps, opts: { signal?: AbortSignal } = {}): Promise<ModelCatalogueResult> {
  let p: CodexDiscovery | null
  try { p = deps.proven() } catch { p = null }
  if (!p || p.state !== 'found' || !p.identity || typeof p.version !== 'string') return fail('not-proven', 'the Codex CLI has not been checked in this run')
  const identity = p.identity
  const version = p.version
  if (!codexCompatibilityAllowsUse(p.compatibility)) return fail('unsupported-version', `Codex ${version} is not a version this app can use`)
  if (opts.signal?.aborted) return fail('failed', 'the read was cancelled')
  const platform = deps.executablePorts.platform
  let base: Readonly<Record<string, string | undefined>>
  try { base = await deps.baseEnv() } catch { return fail('not-started', 'the environment for the Codex CLI could not be prepared') }
  // Checked as late as possible: the file that runs is the one proved.
  const check = verifyCodexExecutable(identity, deps.executablePorts)
  if (!check.ok) return fail('executable-changed', check.detail)
  let scratch: { home: string; dispose(): void }
  try { scratch = deps.scratchHome() } catch { return fail('not-started', 'no empty folder could be made for the read') }
  let kill: Promise<void> | undefined
  try {
    let env: Record<string, string>
    try { env = codexCliEnv(base, scratch.home, platform) } catch { return fail('not-started', 'the environment for the Codex CLI could not be prepared') }
    const cmd = codexCommandLine(check.executable, 'models', platform, codexShellEnv(base, platform))
    if ('refused' in cmd) return fail('not-started', cmd.refused)
    let r: CodexRunResult
    try {
      r = await deps.run(cmd, { env, timeoutMs: CODEX_CATALOGUE_TIMEOUT_MS, maxOutput: CODEX_CATALOGUE_MAX_CHARS, ...(opts.signal ? { signal: opts.signal } : {}) })
    } catch {
      return fail('not-started', 'the Codex CLI could not be started')
    }
    if (r && r.killSettled instanceof Promise) kill = r.killSettled
    if (!r || r.stopped || r.timedOut) return fail('failed', r?.timedOut ? 'the Codex CLI did not answer in time' : 'the read was stopped')
    if (r.spawnError) return fail('not-started', 'the Codex CLI could not be started')
    if (r.exitCode !== 0) return fail('failed', `the Codex CLI exited with code ${r.exitCode}`)
    if (r.truncated) return fail('unreadable', 'the Codex CLI printed more than this app reads')
    // The list is that version's only if the file that answered is still the
    // one proved.
    const after = verifyCodexExecutable(identity, deps.executablePorts)
    if (!after.ok) return fail('executable-changed', after.detail)
    const models = parseCodexModelCatalogue(r.stdout)
    if (!models) return fail('unreadable', 'the Codex CLI did not print a model list this app reads')
    return { ok: true, version, models }
  } finally {
    // A stopped run whose kill is still under way may still be using the
    // home: it is removed once that kill has finished.
    const home = scratch
    const dispose = () => { try { home.dispose() } catch { /* a leftover temp folder is harmless */ } }
    if (kill) void kill.then(dispose, dispose)
    else dispose()
  }
}
