import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { spawnPty, writePty, resizePty, killPty, getSshFlow, endSshRemote, probeTmuxLive, SSHOptions, SshEndTarget } from '../pty-manager'
import { forgetCanvasMarkers } from '../canvas/canvas-marker-delivery'
import { logUserInput, isDebugModeEnabled } from '../debug-capture'
import { logInfo } from '../debug-logger'
import { isVersionInstalled, installVersion } from '../legacy-version-manager'
import { isValidLegacyVersion } from '../../shared/legacy-version'
import { loadCredential } from '../credential-store'
import { readConfig } from '../config-manager'
import { collectCommandSecrets } from '../command-secrets'
import { bindSshToSavedConfig, argSecretAllowed, findSavedConfig } from '../spawn-credential-binding'
import { logWarn } from '../debug-logger'
import { IPC } from '../../shared/ipc-channels'
import { getPtyIntegrityMonitor } from '../services/pty-integrity-monitor'
import type { PtyIntegrityReport } from '../../shared/service-health'
import type { SshRuntime, DetachedRemoteLiveness, HostPingResult, DetachedRemote } from '../../shared/types'
import { detachedDestinationAgrees, type SshDestinationSource } from '../../shared/detached-destination'
import { readDetachedRemotesRegistry } from '../session-state'
import { pingHost } from '../host-ping'
import { noteSessionSpawnForCanvas } from '../canvas/canvas-session-link'
import {
  sanitizeRestoredSpawnOptions,
  PERMISSION_MODES,
  EXTRA_ARGS_MAX,
  EXTRA_ARGS_CHARSET_RE,
  extraArgsRefineOk,
} from '../sanitize-restored-spawn-options'

/** SSH options as received from the renderer (no passwords — only configId) */
interface RendererSSHOptions {
  host: string
  port: number
  username: string
  remotePath: string
  postCommand?: string
  /** #242 tier 5: true when this spawn respawns a session that had
   *  previously reached claude-running -- set by the renderer session
   *  store (Session.sshReachedClaudeRunning, never persisted). Forwarded
   *  verbatim into SSHOptions.reconnect; see its doc comment in
   *  pty-manager.ts for how it's consumed. */
  reconnect?: boolean
  /** SSH tmux enhancement (item 1): "Detachable" toggle. Only `false`
   *  disables the tmux-persistence ladder; undefined/true = ON. */
  detachable?: boolean
  /** SSH tmux enhancement (item 3): remote OS. 'windows' selects the Windows
   *  setup path; 'auto'/'unix'/undefined use POSIX unchanged. */
  remoteOs?: 'auto' | 'unix' | 'windows'
  /** Structured container runtime (item e). Declared so the type matches what
   *  actually crosses the seam — the parse result is discarded, so this field
   *  reaches spawnPty from the raw request on the no-configId branch. Shape and
   *  bounds are enforced by `sshSchema` below. */
  runtime?: SshRuntime
}

// host/username are fused into `${username}@${host}` and handed to ssh as
// argv[0]. ssh parses any argv entry beginning with `-` as an OPTION, so a
// leading dash (e.g. `-oProxyCommand=...`) is an argument-injection primitive.
// Charset-gate both here — reject a leading `-` and any whitespace — matching
// the remotePath precedent from #188; the ssh-args builder re-asserts the same
// as a sink-side backstop (#265). `[^-\s]` first char excludes a leading dash
// and whitespace; `\S*` keeps IPv6 (`[::1]`), internal `-`, and `DOMAIN\user`.
const sshFieldRe = /^[^-\s]\S*$/
const sshSchema = z.object({
  host: z.string().min(1).regex(sshFieldRe, 'host has invalid characters'),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).regex(sshFieldRe, 'username has invalid characters'),
  // Charset-gated at the IPC boundary (mirrors ssh-shim SAFE_REMOTE_PATH_RE):
  // the remote path is interpolated into the remote setup command, and the
  // shim's own assertSafeRemotePath throws from inside a setTimeout — which the
  // global handler re-throws, crashing main. Rejecting here means a bad stored
  // config fails the spawn cleanly instead of taking the process down
  // (adversarial review, #188).
  remotePath: z.string().min(1).regex(/^[~A-Za-z0-9_./-]+$/, 'remote path has invalid characters'),
  postCommand: z.string().optional(),
  reconnect: z.boolean().optional(),
  detachable: z.boolean().optional(),
  remoteOs: z.enum(['auto', 'unix', 'windows']).optional(),
  // Structured container runtime. Declared here because the parse RESULT is
  // discarded (see the spawn handler) -- `options` itself is forwarded to
  // spawnPty, so an undeclared field is not stripped, it is waved through. On
  // the no-configId branch this block therefore reached the container-command
  // composer and the End kill-command builder straight off the IPC request, with
  // its TypeScript types unenforced: a numeric or array `container` made
  // `(runtime.container ?? '').trim()` throw a TypeError, and in endSshRemote
  // that throw sat OUTSIDE the executor's try -- skipping the whole remote
  // cleanup, container and tmux and sidecars alike (adversarial review, ADR-009).
  //
  // Types and bounds only. The container NAME/DIR charsets stay with
  // composeRuntimeCommand so a bad value fails into the session's
  // `runtimeInvalid` latch (which explains itself in the UI) rather than as a
  // raw IPC rejection. `type` IS enumerated here: an unrecognised value must
  // never reach a code path that could read it as "not a container" and launch
  // on the bare host.
  runtime: z.object({
    type: z.enum(['host', 'container']),
    engine: z.enum(['docker', 'podman']).optional(),
    container: z.string().max(255).optional(),
    mode: z.enum(['exec', 'start']).optional(),
    sudo: z.boolean().optional(),
    containerDir: z.string().max(4096).optional(),
  }).optional(),
}).optional()

export const spawnOptionsSchema = z.object({
  cwd: z.string().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  ssh: sshSchema,
  shellOnly: z.boolean().optional(),
  // Terminal-only launcher: a command the USER authored, typed into their own
  // shell on their own machine — running it IS the feature, so a charset guard
  // would be the wrong control (it is not a privilege boundary being crossed).
  // Bounds are defence-in-depth against an oversized payload. The secret VALUE
  // never appears here: only `hasSecretArg` crosses the IPC seam, and main
  // resolves the value from the OS keychain (see the spawn handler).
  terminalOptions: z.object({
    command: z.string().max(4096).optional(),
    args: z.string().max(4096).optional(),
    hasSecretArg: z.boolean().optional(),
    elevated: z.boolean().optional(),
  }).optional(),
  configId: z.string().optional(),
  configLabel: z.string().max(100).optional(),
  // Ask Conductor's opening question. Bounded, NOT charset-guarded, for the same
  // reason as agentsConfig below: this is a natural-language sentence the user
  // typed, so rejecting metacharacters would break the feature for anyone who
  // writes "what's the $ cost?" while stopping no attack.
  //
  // The real control is that the value never becomes command TEXT: it is placed
  // in the spawn env as CCC_ASK_PROMPT and the launch line carries only
  // `$env:CCC_ASK_PROMPT` / `"$CCC_ASK_PROMPT"` (askPromptRef). That removes the
  // SHELL's parse — but on Windows it does not remove the child's, because
  // PowerShell re-serialises native arguments into one command line and
  // CommandLineToArgvW re-splits it. askPromptEnvValue (terminal-launch-line.ts)
  // is what makes the value survive that, and it is the injection boundary for
  // this field. The bound here is defence in depth against an oversized payload.
  //
  // Guards on this field must REJECT (`.refine`), never sanitise: the spawn
  // handler builds its options from the raw object and discards the parse
  // result, so a `.transform()` here would read as a sanitiser and do nothing.
  askPrompt: z.string().max(8000).optional(),
  // Session kind flag: an Ask Conductor one-shot. Used only to keep a watchdog
  // off that ephemeral surface (#266 MAJOR-5); no spawn coordinate.
  isAsk: z.boolean().optional(),
  // Task 9: per-config logging opt-out (DEFAULT-TRUE; only false disables).
  loggingEnabled: z.boolean().optional(),
  useResumePicker: z.boolean().optional(),
  legacyVersion: z.object({
    enabled: z.boolean(),
    version: z.string(),
  }).refine((lv) => !lv.enabled || isValidLegacyVersion(lv.version), {
    // P0.3: only a legacy-ENABLED session uses the version as a path/spawn
    // coordinate, so only then must it be strict semver. Disabled configs may
    // carry a stale/empty version that is never used — leave those alone.
    path: ['version'],
    message: 'legacyVersion.version must be valid semver when enabled',
  }).optional(),
  // Bounded, not charset-guarded. `prompt` and `description` are free-form
  // natural language -- a metacharacter charset here would break the feature
  // for anyone writing an ordinary English sentence, so it is the wrong control.
  //
  // The real control is that this value never reaches a shell as command TEXT:
  // it is JSON-stringified and single-quote-escaped for the launch shell, and
  // scripts/resume-picker.js re-spawns with shell:false so there is no second,
  // unescaped parse (see buildSpawnTarget there -- shell:true on Windows
  // concatenated argv into a cmd.exe command line, which made this field a
  // command-execution path). These bounds are defence in depth against an
  // oversized payload, not the injection boundary.
  agentsConfig: z.array(z.object({
    name: z.string().max(200),
    description: z.string().max(2000),
    prompt: z.string().max(100_000),
    model: z.string().max(64).optional(),
    tools: z.array(z.string().max(200)).max(200).optional(),
  })).max(200).optional(),
  // PERMISSIVE by design (spec 2026-06-11 §4): a registry-validated enum here
  // re-creates the restore crash — capping at low/medium/high made a restored
  // xhigh/max/ultracode session throw. Unknown levels flow through to the
  // Sentinel observe seam in effort-tracker instead of being rejected at spawn.
  // Charset guard = injection defense: value is shell-interpolated UNQUOTED at
  // spawn (pty-manager.ts:1137 local, :563 SSH) — mirrors the resume.uuid guard.
  effortLevel: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  // Shell-interpolated UNQUOTED at spawn. Constrained to the CLI's own --permission-mode
  // choices (+ 'default'/'' meaning "emit no flag") so an arbitrary string can never
  // reach the shell. 'default'/'' are accepted but not emitted.
  // The value list lives in sanitize-restored-spawn-options.ts so the fail-open
  // sanitizer drops exactly what this parse would reject — never more, never
  // less (#413 review, S2).
  permissionMode: z.enum(PERMISSION_MODES).optional().or(z.literal('')),
  // Advanced escape hatch, shell-interpolated UNQUOTED at spawn. Charset guard blocks
  // every shell metacharacter (; | & $ ` ( ) < > ' " * ? ~ ! % ^ newline), leaving only
  // characters that make up ordinary flags/paths. The refine rejects CCC-managed flags
  // so extraArgs can't clobber --model/--effort/--permission-mode/--settings/etc.
  //
  // The managed-flag refine runs on a BACKSLASH-COLLAPSED copy of the value, not
  // on the raw text. The value is emitted unquoted, and POSIX shells strip
  // unquoted backslashes at word expansion -- so a spelling like `--setting\s`
  // matched no literal flag, passed the refine, and arrived at the CLI as the
  // real `--settings`, substituting CCC's per-session settings file. A Claude
  // settings file carries `hooks`, i.e. arbitrary commands.
  //
  // Collapsing rather than banning the character: Windows users legitimately
  // pass backslash paths through this escape hatch (pinned by an existing test),
  // and on Windows the launch shell is PowerShell, where backslash is not an
  // escape character. So the character is harmless where it is needed and only
  // its shell-stripping behaviour has to be accounted for.
  //
  // BRACKETS ARE BANNED FROM THE CHARSET, not collapsed. The value is emitted
  // unquoted, so a POSIX shell pathname-expands an unquoted bracket group:
  // `--setting[s]` is a glob matching a file literally named `--settings`, and
  // if one exists in the session's cwd -- a cloned repo can ship one -- the
  // shell hands the CLI the real flag. That is the same substitution the
  // backslash collapse closes.
  //
  // Collapsing brackets the way backslashes are collapsed does NOT work, and
  // the difference matters: a backslash is an ESCAPE (deleting it reproduces
  // exactly what the shell yields), whereas a bracket group is a PATTERN, so
  // there is no single normalised string to match against. Verified in a real
  // shell with `--settings` present in cwd -- every one of these expands to
  // `--settings`, while stripping just the bracket characters leaves
  // `--settingr-t` / `--settinga-z` / `--setting!x`, none of which match:
  //     --setting[s]  --setting[r-t]  --setting[a-z]  --setting[!x]
  // Since the charset admits no other glob metacharacter (`*` and `?` are
  // already excluded), dropping `[` and `]` removes pathname expansion from
  // this hatch entirely. A literal bracket in a path is the cost; nothing in
  // an ordinary flag or path needs one.
  // Cap, charset and refine are shared with the fail-open sanitizer (see the
  // permissionMode note above) — the collapse/trailing-backslash analysis
  // stays here, the values live in sanitize-restored-spawn-options.ts.
  extraArgs: z.string().max(EXTRA_ARGS_MAX).regex(EXTRA_ARGS_CHARSET_RE).refine(
    // Collapse backslashes before matching -- see the note above. Also reject a
    // trailing backslash outright: it turns the SSH launch line into a shell
    // line continuation, which hangs the session on a `>` prompt waiting for
    // input that never comes.
    (v) => extraArgsRefineOk(v),
    { message: 'extraArgs must not include an app-managed flag (--model/--effort/--permission-mode/--settings/--mcp-config/--agents/--resume), nor end in a backslash' },
  ).optional(),
  disableAutoMemory: z.boolean().optional(),
  enableCodexReview: z.boolean().optional(),
  // T8b (bug #5): app-relaunch exact-conversation resume target.
  // FIX 4: the uuid is interpolated UNQUOTED into the spawn shell command, so
  // constrain it to the canonical UUID format (not just a bounded string) as a
  // defense-in-depth guard against shell injection. cwd stays a bounded string.
  resume: z.object({
    uuid: z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
    cwd: z.string().min(1).max(4096),
  }).optional(),
  // Single-quoted at BOTH spawn sites via modelFlag() (#144); this charset is
  // defence-in-depth, not the primary control. Line numbers deliberately omitted --
  // the previous comment carried stale ones and said UNQUOTED, the opposite of the code.
  // Legit values: 'opus', 'opus[1m]', 'fable', 'sonnet', 'haiku', or versioned ids like 'claude-opus-4-8'.
  // '' is the DEFAULT for "no override" (sessionStore.model is non-optional; TerminalView
  // passes it verbatim) and must stay accepted — emission already skips empty (`if (options?.model)`).
  model: z.string().max(64).regex(/^[a-zA-Z0-9._[\]-]+$/).optional().or(z.literal('')),
  profileId: z.string().optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  codexOptions: z.object({
    model: z.string().optional(),
    reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    permissionsPreset: z.enum(['read-only', 'standard', 'auto', 'unrestricted']),
  }).optional(),
}).superRefine((opts, ctx) => {
  if (opts?.provider === 'codex' && !opts.codexOptions) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'codexOptions required when provider is "codex"',
      path: ['codexOptions'],
    })
  }
}).optional()

// Charset-gate the session id (#265; independently reached by #242 F2). It is
// interpolated into the remote setup script (base64'd and piped to `node` on the
// remote), into filenames on the remote, and into ssh-shim's statusLine.command
// (a string Claude runs via `sh -c` on every statusline refresh). Real ids are
// CSPRNG hex (src/shared/id.ts), so this only ever rejects a caller that already
// controls the renderer or local config — a defence-in-depth gate, not an
// embargoed bug. ssh-shim re-sanitises via safeSid as a backstop. Exported so the
// boundary contract is unit-tested against the real schema.
export const sessionIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/, 'session id has invalid characters')

// SSH Persistent (resume liveness) input. `configId` matches the credential-key
// charset (the config's own id); `sessionIds` are bounded and each is a CCC id.
// The ids are never interpolated into the remote command — safeSid sanitizes them
// for LOCAL name matching — so this schema is a bound/DoS guard, and the
// argv-injection defence lives at buildSshExecArgs (host/user from the saved
// config only).
// A saved config's own id (CSPRNG hex from shared/id.ts) and the credential-key
// charset. One definition, shared by every handler that turns a renderer-named
// configId into a keychain read + an ssh exec, so they cannot drift apart.
const configIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9]+$/, 'configId has invalid characters')

const checkDetachedLiveSchema = z.object({
  configId: configIdSchema,
  sessionIds: z.array(sessionIdSchema).max(64),
})

// SSH_END_REMOTE input, in two shapes (Phase 3.5).
//
//   'sess-abc'                            — a LIVE session: main already holds
//                                           its target from spawn.
//   { sessionId, configId? }              — a DETACHED remote from the resume
//                                           registry: no live target exists, so
//                                           the handler rebuilds one from the
//                                           SAVED config named by `configId`.
//
// The bare-string form is kept because the End-vs-Leave dialog still sends it;
// a union means one channel, one place the target is resolved, and one surface
// to audit — rather than two handlers that could disagree about what may be
// killed. Neither id ever reaches the remote command: the tmux target is
// derived LOCALLY as `ccc-<safeSid(sessionId)>` (buildRemoteTmuxKillCommand),
// and host/user/port come only from the saved config.
const endRemoteSchema = z.union([
  sessionIdSchema,
  z.object({ sessionId: sessionIdSchema, configId: configIdSchema.optional() }),
])

// SSH Persistent (resume liveness, tier 1) input. A bound/DoS guard only — the
// authoritative host validation is isValidPingHost inside host-ping.ts (charset,
// leading-dash, length), which runs before any spawn and is what the unit tests
// assert against. Both layers reject; neither sanitises-and-continues.
const pingHostSchema = z.object({ host: z.string().min(1).max(255) })

/**
 * The hosts `ssh:pingHost` will probe: the host of some SAVED SSH config, and
 * nothing else (adversarial review, 2026-09-01 — MAJOR/DoS).
 *
 * The charset gate (isValidPingHost) proves a host is safe to put in an argv.
 * It does not answer whether this app has any business dialling it, and the
 * pre-fix handler took the host straight off the renderer — so a compromised
 * renderer had an unauthenticated outbound probe primitive: ICMP echo plus a
 * TCP:22 knock at any address that passes a charset, i.e. an internal port
 * scanner and a beacon, driven from the user's machine and their network
 * position.
 *
 * The trust rule is not new; it is the one both SSH siblings on this channel
 * already apply. `ssh:endRemote` and `ssh:checkDetachedLive` resolve host, user
 * and port ONLY from `readConfig('configs')` — the renderer names an id and
 * never a destination. Ping is keyed by HOST rather than by config id (several
 * configs share one box and one echo serves them all), so it cannot take an id;
 * matching the SET of saved hosts is the same rule expressed for that key.
 *
 * Case-insensitive, because DNS is and the same box may be saved as `Pi.local`
 * in one config and `pi.local` in another. Fails CLOSED on a missing or
 * malformed configs file: an empty allowlist means nothing is probed, which
 * costs a pill and never a packet.
 */
function savedSshPingHosts(): Set<string> {
  const out = new Set<string>()
  const configs = readConfig('configs')
  if (!Array.isArray(configs)) return out
  for (const entry of configs) {
    if (!entry || typeof entry !== 'object') continue
    const cfg = entry as { sessionType?: unknown; sshConfig?: { host?: unknown } | null }
    if (cfg.sessionType !== 'ssh') continue
    const host = cfg.sshConfig?.host
    if (typeof host === 'string' && host.length > 0) out.add(host.toLowerCase())
  }
  return out
}

/**
 * Concurrency ceiling for tier-1 pings, counted across every caller.
 *
 * `pingHost` spawns `ping.exe`/`ping` — a real process, per call — and the
 * pre-fix handler had no bound at all: a renderer loop was thousands of live
 * subprocesses, which is a local DoS on the user's own machine well before it
 * is anything else. Eight is comfortably above the legitimate load (the
 * scheduler pings one DISTINCT HOST per 90s tick; a fleet of eight boxes left
 * running is already an unusual registry) and far below the level at which
 * process creation hurts.
 */
const PING_MAX_IN_FLIGHT = 8

/**
 * In-flight probes, keyed by lowercased host — the dedupe half of the bound.
 *
 * Two callers asking about the same box get the SAME probe rather than two
 * subprocesses, which is both cheaper and more correct (they cannot disagree
 * about one host at one instant). Only when eight DISTINCT hosts are already in
 * flight does the ninth get refused, so the cap can never be reached by
 * hammering one host.
 */
const pingInFlightByHost = new Map<string, Promise<HostPingResult>>()

/** Test seam: the module-level in-flight map outlives a single handler call. */
export function _resetPingInFlightForTest(): void {
  pingInFlightByHost.clear()
}

/**
 * #54: is `sessionId` recorded in the persisted resume registry at a DIFFERENT
 * destination than `ssh` (the saved config, as it is now) reaches? The main-side
 * twin of the renderer's `matchDetachedRemotes` rule, applied where the config
 * id becomes a host to dial: a renderer that names a config whose destination
 * was edited after the session was left running must not have main probe, or
 * kill, on the NEW host under the OLD session's name. A session the registry
 * does not know is not checked -- there is nothing to compare, and the guard is
 * strictly additive to the config-only trust rule. Callers checking several
 * sessions pass one `registry` read so the file is parsed once, not per id.
 */
function recordedDestinationMoved(
  sessionId: string,
  ssh: SshDestinationSource,
  registry: readonly DetachedRemote[] = readDetachedRemotesRegistry(),
): boolean {
  const entry = registry.find((e) => e.sessionId === sessionId)
  return !!entry && !detachedDestinationAgrees(entry, ssh)
}

/**
 * Rebuild an End-remote target from the SAVED config on disk (Phase 3.5).
 *
 * The one place a DETACHED remote's connection details come from, and every
 * field is read from main's own state: host/user/port from the config file,
 * password and sudo password from that config's OWN keychain slots (the same
 * `<id>` / `<id>_sudo` keys pty:spawn uses), the container runtime from the
 * saved SSH block. The caller passes an id; it does not pass a host, a
 * credential, or a command — the same trust rule as bindSshToSavedConfig, and
 * the same shape SSH_CHECK_DETACHED_LIVE already relies on.
 *
 * `undefined` for an unknown id, a non-SSH config, or a config with no SSH
 * block: End then has no target and no-ops, which is the correct fail-closed
 * answer — there is no host to reach, so there is nothing to guess at.
 *
 * The runtime rides along deliberately. Without it a detached CONTAINER
 * session's kill would drop the tmux client and leave claude running inside the
 * container forever — #572's one-hop-deeper orphan, reached by the detached
 * road instead of the live one.
 */
function endTargetFromSavedConfig(configId: string, sessionId: string): SshEndTarget | undefined {
  const saved = findSavedConfig(readConfig('configs'), configId)
  if (!saved || saved.sessionType !== 'ssh' || !saved.sshConfig) return undefined
  const s = saved.sshConfig
  if (recordedDestinationMoved(sessionId, s)) {
    // The config no longer points where this session was left (#54). Ending
    // through it would kill `ccc-<sessionId>` on whatever host it points at NOW
    // -- a different machine -- and leave the real remote running. No target:
    // End no-ops, and the resume surface's orphan dialog says how to end it
    // on the host it is actually on.
    logWarn(`[ssh] endRemote refused for session ${sessionId}: config ${configId} now reaches a different destination than the one the session was left on`)
    return undefined
  }
  // host/user/port and the credential(s) are read for the SAME id here. What
  // keeps the two in agreement is config-handlers' config:save guard: a renderer
  // that rewrites this config's host/username/port has its `<id>` / `<id>_sudo`
  // credentials dropped in that same save, so after a malicious rewrite these
  // loadCredential calls return null and there is nothing to misdirect. No guard
  // is needed HERE (the secret is simply gone); do not weaken that upstream drop.
  return {
    username: s.username,
    host: s.host,
    port: Number(s.port),
    password: loadCredential(configId) ?? undefined,
    runtime: s.runtime,
    sudoPassword: loadCredential(configId + '_sudo') ?? undefined,
  }
}

export function registerPtyHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('pty:spawn', async (_event, sessionId: string, options?: {
    cwd?: string
    cols?: number
    rows?: number
    ssh?: RendererSSHOptions
    shellOnly?: boolean
    terminalOptions?: { command?: string; args?: string; hasSecretArg?: boolean; elevated?: boolean }
    /** Main-process only — resolved from the OS keychain below and explicitly
     *  cleared from whatever the renderer sent. Never accepted from outside. */
    terminalSecret?: string
    /** Main-process only, like terminalSecret: command-button secrets for a
     *  SHELL spawn, keyed by command id. Stripped from whatever the renderer
     *  sent and rebuilt from the keychain below. */
    commandSecrets?: Record<string, string>
    configId?: string
    configLabel?: string
    /** Ask Conductor's opening question (see spawnOptionsSchema.askPrompt). */
    askPrompt?: string
    loggingEnabled?: boolean
    useResumePicker?: boolean
    legacyVersion?: { enabled: boolean; version: string }
    agentsConfig?: Array<{ name: string; description: string; prompt: string; model?: string; tools?: string[] }>
    // Widened to string — the Zod schema's charset guard is the real contract.
    effortLevel?: string
    permissionMode?: string
    extraArgs?: string
    disableAutoMemory?: boolean
    enableCodexReview?: boolean
    resume?: { uuid: string; cwd: string }
    model?: string
    profileId?: string
    provider?: 'claude' | 'codex'
    codexOptions?: {
      model?: string
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
      permissionsPreset: 'read-only' | 'standard' | 'auto' | 'unrestricted'
    }
  }) => {
    // #397 Group 5: repair persisted fields fail-open BEFORE the strict parse, so a
    // corrupt session-state.json cannot abort the whole spawn (the session never
    // launched). Dropped/floored values never reach the shell; the rest still parses.
    options = sanitizeRestoredSpawnOptions(options, logInfo)
    try {
      sessionIdSchema.parse(sessionId)
      spawnOptionsSchema.parse(options)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }

    const win = getWindow()
    if (!win) throw new Error('No window available')

    // Auto-install legacy version before spawn if needed
    if (options?.legacyVersion?.enabled && options.legacyVersion.version) {
      if (!isVersionInstalled(options.legacyVersion.version)) {
        logInfo(`[pty] Auto-installing legacy Claude CLI v${options.legacyVersion.version} before spawn`)
        const result = await installVersion(options.legacyVersion.version)
        if (!result.ok) {
          logInfo(`[pty] Legacy install failed, falling back to system claude: ${result.error}`)
        }
      }
    }

    // Resolve SSH credentials in the main process (never transit through renderer).
    // terminalSecret is stripped up front: this object is forwarded to spawnPty
    // verbatim (the zod parse result is intentionally discarded), so a field the
    // schema doesn't declare would otherwise flow straight through from the
    // renderer. Only the keychain lookup below may set it.
    let resolvedOptions: typeof options = options ? { ...options, terminalSecret: undefined, commandSecrets: undefined } : options
    // An SSH block is bound to the config it names, ON DISK: the request must be
    // that config's own (host/port/username/remotePath/postCommand) or the spawn
    // is refused. Main trusting the renderer to pair a config's stored password
    // with the host the renderer chose let a compromised renderer point a
    // config's password at an attacker host (private advisory, 2026-08-22). The
    // resolved block is built FROM the saved config, so nothing the renderer
    // added rides along; credentials are injected only for a bound spawn.
    if (options?.ssh && options.configId) {
      const bound = bindSshToSavedConfig(options.ssh, options.configId, readConfig('configs'))
      if (!bound.ok) {
        logWarn(`[pty] SSH spawn refused: ${bound.reason}`)
        throw new Error(`SSH spawn refused: does not match a saved config (${bound.reason})`)
      }
      // bindSshToSavedConfig pins the spawn to the SAVED config's host/user/port;
      // the credential invalidation in config-handlers (config:save) is what keeps
      // that saved identity honest, dropping `<id>` / `<id>_sudo` the moment a
      // renderer rewrites the host/username/port. So a redirected credential is
      // already gone before it could be loaded here — no extra guard at this read.
      const password = loadCredential(options.configId) ?? undefined
      const sudoPassword = loadCredential(options.configId + '_sudo') ?? undefined
      const sshWithCreds: SSHOptions = { ...bound.ssh, password, sudoPassword }
      resolvedOptions = { ...resolvedOptions, ssh: sshWithCreds }
    } else if (options?.ssh) {
      // No configId: nothing is loaded from the keychain, so there is no stored
      // secret to misdirect. Runs unbound with no credentials, as before.
      const sshNoCreds: SSHOptions = { ...options.ssh, password: undefined, sudoPassword: undefined }
      resolvedOptions = { ...resolvedOptions, ssh: sshNoCreds }
    }

    // Terminal-only secret argument: resolved HERE, in main, straight from the OS
    // keychain — the value never transits the renderer and is never persisted to
    // the config file (same posture as the SSH credentials above). Injected only
    // when the SAVED config is terminal-only with a secret on record AND the
    // requested command line is the saved one, so a compromised renderer cannot
    // borrow a config's secret for a command line of its own (private advisory,
    // 2026-08-22).
    if (options?.shellOnly && options.configId && options.terminalOptions?.hasSecretArg
        && argSecretAllowed(options.terminalOptions, options.configId, readConfig('configs'))) {
      const argSecret = loadCredential(options.configId + '_argsecret') ?? undefined
      if (argSecret) resolvedOptions = { ...resolvedOptions, terminalSecret: argSecret }
    }

    // Command-button secrets: every LOCAL shell spawn (the partner pane, or the
    // main pane of a terminal-only config) gets the secrets of the commands
    // visible to it -- the Global ones, plus its config's when it has one -- as
    // env vars, so a button can type a reference instead of the value. Resolved
    // HERE from the commands file on disk and the keychain; the renderer's copy
    // of the commands list is never consulted, because it could name any id it
    // liked. No secrets for a Claude spawn (a reference typed into the TUI is
    // just text to Claude) and none for an SSH spawn (the env never leaves this
    // PC, and decrypting for it would be for nothing). A shell with no config
    // (Ask Conductor's partner) still gets the Global ones: a Global button runs
    // in every session it can run in (ADR-018 D5), and without this it would
    // type a reference to nothing. (ADR-009 pass on #386.)
    if (options?.shellOnly && !options.ssh) {
      const secrets = collectCommandSecrets(readConfig('commands'), options.configId, loadCredential)
      if (Object.keys(secrets).length > 0) resolvedOptions = { ...resolvedOptions, commandSecrets: secrets }
    }

    // Agent Canvas UAT roots are NOT registered here any more (adversarial
    // review, 2026-08-15 — BLOCKER 1). This site registered the RAW
    // `options.cwd` and `options.resume.cwd` strings, neither of which had been
    // through `resolveCwd` or `isHomeOrAncestor`, so a config whose
    // workingDirectory was '.', empty or stale allowlisted the home directory
    // and `~/.ssh`, `~/.claude`, `~/.aws` became servable. Worse,
    // `resume.cwd` is read verbatim out of a transcript JSONL
    // (transcript-discovery.getCwdFromTranscript), a file the agent can WRITE —
    // so the model named its own allowlist entry.
    //
    // Registration now happens in pty-manager, after the spawn, against
    // `resolveCwd(options.cwd)` — the session's CONFIGURED project directory —
    // with the same home-directory refusal codex_review has carried since #188.
    // Explicitly NOT the post-resume-override launch cwd: that value is
    // `target.cwd`, i.e. transcript content, so registering it would have
    // laundered the same model-chosen path through a different file (second
    // pass, 2026-08-15). Only the configured directory may become a served root.
    if (!options?.ssh) {
      // Canvas continuity: stamp this session's work identity so it can find
      // (and resume) work stranded by a previous session of the same
      // conversation / project (the VM "repush" bug, 2026-08-14). LOCAL
      // sessions only — an SSH session's cwd names a path on the REMOTE
      // machine. These stamps LABEL a canvas (ordering, the resume list, the
      // audit line); they never authorize a read.
      noteSessionSpawnForCanvas(sessionId, {
        cwd: options?.resume?.cwd ?? options?.cwd,
        resumeUuid: options?.resume?.uuid,
        // The config's display name, for the Testing pack's generated title
        // (M3). A label like the two above it: it names a run for the user and
        // authorizes nothing.
        configLabel: options?.configLabel,
        // The config's STABLE id (M4). It is what lets the Library resolve the
        // config's CURRENT name at read time, so renaming a config renames
        // every row rather than leaving frozen labels behind. A lookup key into
        // the user's own configs.json — never a serving or authorization key,
        // and the canvas layer re-checks its shape before recording it.
        configId: options?.configId,
        // The ACCOUNT this session runs, for the audit line. Only the profile's
        // DISPLAY NAME is ever resolved from it (never the email), and only for
        // a profile session — see accountDisplayNameFor. Display metadata: the
        // account decides nothing about a canvas (ADR-017).
        profileId: options?.profileId,
      })
    }

    spawnPty(win, sessionId, resolvedOptions)
  })

  ipcMain.on('pty:write', (_event, sessionId: string, data: string) => {
    if (isDebugModeEnabled()) {
      logUserInput(sessionId, data, 'inputBar')
    }
    writePty(sessionId, data)
  })

  ipcMain.on('pty:resize', (_event, sessionId: string, cols: number, rows: number) => {
    resizePty(sessionId, cols, rows)
  })

  ipcMain.on('pty:kill', (_event, sessionId: string) => {
    killPty(sessionId)
    // #580: nothing left to deliver a queued canvas marker to. Logged loudly if
    // any were still held, because that is a verdict the agent never heard.
    forgetCanvasMarkers(sessionId)
  })

  ipcMain.on(IPC.PTY_INTEGRITY_REPORT, (_event, report: PtyIntegrityReport) => {
    getPtyIntegrityMonitor()?.recordRendererReport(report)
  })

  // SSH manual-flow controller — renderer drives stage transitions.
  ipcMain.handle(IPC.SSH_FLOW_RUN_POSTCOMMAND, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    getSshFlow(sessionId)?.runPostCommand()
  })

  ipcMain.handle(IPC.SSH_FLOW_LAUNCH_CLAUDE, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    getSshFlow(sessionId)?.launchClaude()
  })

  ipcMain.handle(IPC.SSH_FLOW_SKIP, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    getSshFlow(sessionId)?.skip()
  })

  ipcMain.handle(IPC.SSH_FLOW_GET_STATE, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    return getSshFlow(sessionId)?.getState() ?? { state: 'connecting' }
  })

  // SSH tmux enhancement (item 4): deliberately END a persistent remote session
  // (tmux kill-session + sidecar cleanup over a SEPARATE ssh exec). The renderer
  // still tears down the local PTY itself (killSessionPty) after this resolves.
  //
  // Phase 3.5 adds the DETACHED branch: a remote the user LEFT RUNNING has no
  // live target in main (killPty dropped it, and a restart never had one), so
  // when the payload names a `configId` the target is rebuilt from the SAVED
  // config exactly as SSH_CHECK_DETACHED_LIVE does — host/user/port off the
  // config on disk, secrets straight from that config's own keychain slots. The
  // renderer supplies two ids and nothing else; it can neither name a host nor
  // name the tmux session to kill (that is `ccc-<safeSid(sessionId)>`, derived
  // locally in buildRemoteTmuxKillCommand).
  //
  // Best-effort throughout: an unknown config, a non-SSH config, an unreachable
  // host and an already-dead session all end the same way — nothing thrown at
  // the renderer, which drops the registry entry regardless.
  ipcMain.handle(IPC.SSH_END_REMOTE, async (_event, payload: unknown) => {
    const parsed = endRemoteSchema.parse(payload)
    const sessionId = typeof parsed === 'string' ? parsed : parsed.sessionId
    const configId = typeof parsed === 'string' ? undefined : parsed.configId
    endSshRemote(sessionId, configId ? endTargetFromSavedConfig(configId, sessionId) : undefined)
  })

  // SSH Persistent (resume liveness): is a set of DETACHED `ccc-<sessionId>` tmux
  // sessions still alive on a config's host? The connection target is built
  // ENTIRELY from the SAVED config named by `configId` (host/user/port) with the
  // password from that config's keychain slot — never from the renderer, which
  // supplies only the config id and the candidate session ids. The ids reach the
  // remote host only via safeSid-matched NAMES (probeTmuxLive), never the command.
  // Fail-open: an unknown/non-SSH config, or any exec failure, returns
  // 'unverified' (not "dead"), so a host that is merely asleep is never mistaken
  // for a wiped session.
  ipcMain.handle(IPC.SSH_CHECK_DETACHED_LIVE, async (_event, payload: unknown): Promise<DetachedRemoteLiveness> => {
    const { configId, sessionIds } = checkDetachedLiveSchema.parse(payload)
    const saved = findSavedConfig(readConfig('configs'), configId)
    if (!saved || saved.sessionType !== 'ssh' || !saved.sshConfig) {
      return { outcome: 'unverified', liveSessionIds: [] }
    }
    const s = saved.sshConfig
    // #54: never ask host B about a session that was left on host A. The
    // renderer does not file such a probe any more (matchDetachedRemotes
    // excludes a retargeted entry), so this is the main-side backstop: one
    // queried session recorded elsewhere makes the WHOLE answer 'unverified'
    // (fail-open -- nothing is pruned, nothing is probed on the wrong host)
    // rather than a 'verified' list that would read the missing id as dead.
    const registry = readDetachedRemotesRegistry()
    if (sessionIds.some((id) => recordedDestinationMoved(id, s, registry))) {
      logWarn(`[ssh] checkDetachedLive answered unverified for config ${configId}: a queried session is recorded at a different destination than the config reaches now`)
      return { outcome: 'unverified', liveSessionIds: [] }
    }
    // Same guarantee as pty:spawn / endTargetFromSavedConfig: the config:save
    // credential invalidation drops `<id>` when this config's host/username/port
    // is rewritten, so a redirected password is gone before this read. No extra
    // guard needed here.
    const password = loadCredential(configId) ?? undefined
    return probeTmuxLive({ username: s.username, host: s.host, port: Number(s.port), password }, sessionIds)
  })

  // SSH Persistent (resume liveness, TIER 1): is a host answering at all? No ssh,
  // no auth, no credential read — one ICMP echo with a TCP:22 fallback. The
  // renderer supplies the host because the reachability tier is keyed by HOST,
  // not by config (several configs share one box, and one ping serves them all);
  // nothing here is interpolated into a shell, and host-ping.ts refuses anything
  // outside its strict charset before a process is spawned.
  //
  // TWO BOUNDS on top of that charset gate (adversarial review, 2026-09-01):
  //
  //  1. SCOPE. The host must be the host of some SAVED SSH config — the same
  //     trust rule ssh:endRemote and ssh:checkDetachedLive already apply, which
  //     resolve their destination from `readConfig('configs')` and never from
  //     the payload. Without it a compromised renderer owns an outbound probe
  //     primitive (ICMP + a TCP:22 knock at any charset-valid address) running
  //     from the user's machine and network position. An unlisted host is
  //     answered — not thrown at — because the caller is the reachability
  //     scheduler and a throw there is an unhandled rejection every tick; the
  //     `reason` names why so a log can tell it apart from a dead host.
  //
  //  2. CAP. `pingHost` spawns a real `ping` process per call and had no bound,
  //     so a renderer loop was thousands of live subprocesses. Probes are
  //     deduped by host (two callers asking about one box share one probe) and
  //     the number of DISTINCT hosts in flight is capped; over the cap the call
  //     is answered `busy` rather than spawning. Demote-only semantics make both
  //     refusals safe: a not-reachable answer costs a pill, never data.
  //
  // See savedSshPingHosts / PING_MAX_IN_FLIGHT above.
  ipcMain.handle(IPC.SSH_PING_HOST, async (_event, payload: unknown): Promise<HostPingResult> => {
    const { host } = pingHostSchema.parse(payload)
    const key = host.toLowerCase()
    if (!savedSshPingHosts().has(key)) {
      logWarn(`[host-ping] refused a host that is not in any saved SSH config — never spawned`)
      return { host, reachable: false, via: 'none', reason: 'host-not-in-configs' }
    }
    const existing = pingInFlightByHost.get(key)
    if (existing) return existing
    if (pingInFlightByHost.size >= PING_MAX_IN_FLIGHT) {
      return { host, reachable: false, via: 'none', reason: 'busy' }
    }
    // pingHost never throws by contract; the catch is the belt for a future
    // regression, so one bad probe cannot leave a permanent entry in the map.
    const probe = pingHost(host).catch((): HostPingResult => ({
      host, reachable: false, via: 'none', reason: 'probe-failed',
    }))
    pingInFlightByHost.set(key, probe)
    try {
      return await probe
    } finally {
      pingInFlightByHost.delete(key)
    }
  })
}
