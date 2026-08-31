import React, { useState } from 'react'
import { TerminalConfig, ProviderId, CodexOptions, useConfigStore } from '../stores/configStore'
import { CodexFormFields } from './SessionDialog/CodexFormFields'
import { IDENTITY_COLOR_KEYS, resolveIdentityColor, bucketLegacyColorToKey, type IdentityColorKey } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { useRegistryStore } from '../stores/registryStore'
import { useSettingsStore } from '../stores/settingsStore'
import { modelGroupsFromRegistry, effortsForModel, PERMISSION_MODES } from '../lib/claude-cli-options'
import { trackUsage } from '../stores/tipsStore'
import { generateId } from '../utils/id'
import { resolveAllowMultiSpawnOnSave } from '../utils/multiSpawn'
import { secretValueProblem, secretPlacementProblem } from '../../shared/command-secret'
import { parseDockerPostCommand } from '../../shared/container-command'
import { DialogOverlay, DialogPanel, DialogHeader, DialogFooter, DialogButton, ON_BRAND } from './ui/Dialog'

export type SessionType = 'local' | 'ssh'

export interface SSHConfig {
  host: string
  port: number
  username: string
  remotePath: string
}

// Identity-colour swatches: stable palette keys (resolved to a theme hex at render).
// Reserved status/brand/link hues are intentionally absent -- identity can never collide with state.
export const IDENTITY_SWATCHES: readonly IdentityColorKey[] = IDENTITY_COLOR_KEYS

// Legacy 24-hex palette retained for non-identity pickers (screenshot button,
// custom commands, notes, project-browser auto-assign) that still store a raw
// hex string. Identity pickers use IDENTITY_SWATCHES above.
export const COLOR_SWATCHES = [
  // Neon electric
  '#00FFFF', '#FF00FF', '#00FF7F', '#FF6EC7',
  // Hot neon
  '#FF3366', '#33FFCC', '#FFFF00', '#FF9933',
  // Claude coral & warm
  '#FF7F50', '#FFB347', '#FF6B9D', '#FFA07A',
  // Electric blues & purples
  '#7B68EE', '#00BFFF', '#BA55D3', '#4169E1',
  // Vivid greens & teals
  '#32CD32', '#20B2AA', '#00CED1', '#7FFF00',
  // Bright accents
  '#FF1493', '#00FA9A', '#FFD700', '#FF4500',
]

/** What the provider cards offer. 'terminal' is a UI-level provider that maps to
 *  the stored shape `provider: 'claude', shellOnly: true` — the same shape the
 *  old "Shell only" tickbox produced, so no config migration and no IPC/enum
 *  widening is needed. A real `provider: 'terminal'` (with first-run command,
 *  arguments and secret argument) is the follow-up PR. */
type UiProvider = 'claude' | 'codex' | 'terminal'

/** The config's own effort union, derived so it can't drift from ClaudeOptions. */
type EffortValue = NonNullable<NonNullable<TerminalConfig['claudeOptions']>['effortLevel']>

/**
 * Can `model` actually run effort level `ef`? '' is "Default", always valid.
 *
 * Module-level so the effortLevel state can clamp in its lazy initialiser — a
 * helper defined in the component body would still be in its TDZ when React
 * calls that initialiser on the first render.
 *
 * Uses the SAME per-model gating the chips use (effortsForModel -> disabled), so
 * an unknown model or an un-hydrated registry enables everything and clamping
 * fails OPEN — it can never silently drop an effort it merely failed to verify.
 */
function effortSupportedFor(
  registry: Parameters<typeof effortsForModel>[0],
  model: string,
  ef: EffortValue | '',
): boolean {
  if (ef === '') return true
  return effortsForModel(registry, model).some((r) => r.value === ef && !r.disabled)
}

/** Stronger consequence copy for the two modes that disable safety prompts.
 *  Falls back to the shared PERMISSION_MODES hint for everything else. */
const DANGEROUS_MODE_COPY: Record<string, string> = {
  bypassPermissions: 'Skips every permission prompt, including file writes and shell commands. Only use this in a folder you could throw away.',
  dontAsk: "Accepts everything without asking. Same risk as Bypass for anything inside the working directory.",
}

interface Props {
  /** `argSecret` is the Terminal-only secret argument: handed to the caller so it
   *  can be written to the OS keychain under `<configId>_argsecret`. It is never
   *  part of the config object and never persisted to the config file. */
  onConfirm: (config: Omit<TerminalConfig, 'id'>, password?: string, sudoPassword?: string, argSecret?: string) => void
  onCancel: () => void
  initial?: Partial<TerminalConfig>
  /** Live sessions of the config being edited (0 / absent = none). Edits only
   *  shape FUTURE launches — and a live session that restarts after an
   *  SSH/terminal change re-binds against the saved config, so the dialog
   *  says so up front instead of letting a restart fail as a surprise. */
  liveSessionCount?: number
}

export default function SessionDialog({ onConfirm, onCancel, initial, liveSessionCount = 0 }: Props) {
  const groups = useConfigStore((s) => s.groups)
  const addGroup = useConfigStore((s) => s.addGroup)
  const sections = useConfigStore((s) => s.sections)
  const addSection = useConfigStore((s) => s.addSection)
  const registry = useRegistryStore((s) => s.registry)
  const theme = useResolvedTheme()
  const initialClaude = initial?.claudeOptions
  const isEdit = !!initial
  // Deliberately NO useDialogEscape: this form holds unsaved input (name,
  // working dir, args, env, provider), and Escape is a reflex when leaving a
  // field. Discarding a half-filled config on one keypress with no confirm and
  // no undo is worse than not having the shortcut. Cancel is the way out.

  // Codex master ("Do you use Codex?"): with it off, Codex configs can't launch,
  // so the card renders disabled with a pointer to Settings → Codex.
  const codexDisabled = useSettingsStore((s) => s.settings.codexEnabled === false)

  // ── The two driving choices. A NEW config starts with neither chosen and the
  // dialog reveals itself as they're answered; EDIT opens fully revealed.
  const [uiProvider, setUiProvider] = useState<UiProvider | null>(
    initial ? (initial.shellOnly ? 'terminal' : (initial.provider ?? 'claude')) : null
  )
  const [sessionType, setSessionType] = useState<SessionType | null>(initial ? (initial.sessionType ?? 'local') : null)

  // ── Workspace
  const [workingDir, setWorkingDir] = useState(initial?.workingDirectory ?? '')
  const [sshHost, setSshHost] = useState(initial?.sshConfig?.host ?? '')
  const [sshPort, setSshPort] = useState(initial?.sshConfig?.port ?? 22)
  const [sshUser, setSshUser] = useState(initial?.sshConfig?.username ?? '')
  const [sshRemotePath, setSshRemotePath] = useState(initial?.sshConfig?.remotePath ?? '~')
  const [machineName, setMachineName] = useState(initial?.machineName ?? '')
  const [postCommand, setPostCommand] = useState(initial?.sshConfig?.postCommand ?? '')
  // Allow Multi Spawn (phase 4): may this launcher run several copies at once?
  // Absent/false = off, and a launch is then refused while one is live. The
  // STORED field is tri-state (see resolveAllowMultiSpawnOnSave); the checkbox
  // only needs the two visible states.
  const [allowMultiSpawn, setAllowMultiSpawn] = useState(initial?.allowMultiSpawn === true)
  // SSH tmux enhancement (item 1): "Detachable" (persistent remote session).
  // DEFAULT ON -- only an explicit false disables it, so a config saved before
  // this field existed (undefined) opens ticked.
  const [detachable, setDetachable] = useState(initial?.sshConfig?.detachable !== false)
  // Secrets: `stored*` tracks whether the keychain currently holds one (the
  // "Remove stored password" link clears it); `save*` is the honest opt-in —
  // a typed password is only handed to the caller for storage when it's on.
  // savePassword defaults to true so a freshly-typed password is saved by
  // default. It must NOT default to `hasPassword ?? true`: after this PR every
  // key-auth SSH config persists hasPassword:false, and `false ?? true` is
  // false — which rendered the checkbox unticked, silently dropping a password
  // the user typed into an existing key-auth config (adversarial review, #188).
  // The checkbox only renders (and only matters) once there IS a password to
  // save, so a plain `true` is safe for stored-secret and key-auth cases alike.
  const [sshPassword, setSshPassword] = useState('')
  const [storedPassword, setStoredPassword] = useState(initial?.sshConfig?.hasPassword ?? false)
  const [savePassword, setSavePassword] = useState(true)
  const [sudoPassword, setSudoPassword] = useState('')
  const [storedSudo, setStoredSudo] = useState(initial?.sshConfig?.hasSudoPassword ?? false)
  const [saveSudo, setSaveSudo] = useState(true)
  // ── Runtime (item e): where claude actually runs after the connection is up.
  // 'host' = directly on the machine; 'container' = the app composes the
  // docker/podman command itself. The sudo password field belongs HERE (it was
  // always docker's); the free-text post-command survives under Advanced for
  // arbitrary prep only.
  const initialRuntime = initial?.sshConfig?.runtime
  const [runtimeType, setRuntimeType] = useState<'host' | 'container'>(initialRuntime?.type ?? 'host')
  const [rtEngine, setRtEngine] = useState<'docker' | 'podman'>(initialRuntime?.engine ?? 'docker')
  const [rtContainer, setRtContainer] = useState(initialRuntime?.container ?? '')
  const [rtMode, setRtMode] = useState<'exec' | 'start'>(initialRuntime?.mode ?? 'exec')
  const [rtSudo, setRtSudo] = useState(initialRuntime?.sudo ?? false)
  const [rtDir, setRtDir] = useState(initialRuntime?.containerDir ?? '')

  // ── Session startup (Claude Code)
  // Edit must not rewrite what's stored: a config saved with no model override
  // reopens as "Default", not the new-config 'opus' default (the old dialog
  // silently upgraded Default → opus on every save; same family as the
  // effortLevel wipe).
  const initialModel = initial ? (initialClaude?.model ?? initial?.model ?? '') : 'opus'
  const [model, setModel] = useState(initialModel)
  // Typed against the config's own effort union (not widened to string) so the
  // saved claudeOptions.effortLevel stays assignable — '' is the "Default" chip.
  //
  // Clamped on LOAD, not just on model change: handleModelChange only fires when
  // the user touches the model select, so a config saved before a model dropped
  // an effort level (claude-opus-4-6 + xhigh) reopened with that effort still
  // selected and re-submitted it on Save without the model being touched at all
  // (ADR-009 MINOR on #404). handleSubmit clamps again, for the case where the
  // registry had not hydrated yet when this ran.
  const [effortLevel, setEffortLevel] = useState<EffortValue | ''>(() => {
    const saved = initialClaude?.effortLevel ?? ''
    return effortSupportedFor(registry, initialModel, saved) ? saved : ''
  })
  const [permissionMode, setPermissionMode] = useState(initialClaude?.permissionMode ?? 'default')
  const [extraArgs, setExtraArgs] = useState(initialClaude?.extraArgs ?? '')
  const [loggingEnabled, setLoggingEnabled] = useState(initialClaude?.loggingEnabled !== false)

  // ── Terminal-only startup
  const [termCommand, setTermCommand] = useState(initial?.terminalOptions?.command ?? '')
  const [termArgs, setTermArgs] = useState(initial?.terminalOptions?.args ?? '')
  const [termElevated, setTermElevated] = useState(initial?.terminalOptions?.elevated ?? false)
  const [secretArg, setSecretArg] = useState('')
  const [storedSecret, setStoredSecret] = useState(initial?.terminalOptions?.hasSecretArg ?? false)

  // ── Session startup (Codex)
  const [codexModel, setCodexModel] = useState(initial?.codexOptions?.model ?? 'gpt-5.5')
  const [codexEffort, setCodexEffort] = useState<NonNullable<CodexOptions['reasoningEffort']>>(initial?.codexOptions?.reasoningEffort ?? 'medium')
  const [codexPreset, setCodexPreset] = useState<CodexOptions['permissionsPreset']>(initial?.codexOptions?.permissionsPreset ?? 'standard')

  // ── Organise
  const [groupId, setGroupId] = useState<string | undefined>(initial?.groupId)
  const [newGroupName, setNewGroupName] = useState('')
  const [showNewGroup, setShowNewGroup] = useState(false)
  const [sectionId, setSectionId] = useState<string | undefined>(initial?.sectionId)
  const [newSectionName, setNewSectionName] = useState('')
  const [showNewSection, setShowNewSection] = useState(false)

  // ── Identity
  const [label, setLabel] = useState(initial?.label ?? '')
  const [colorKey, setColorKey] = useState<IdentityColorKey>(
    (initial?.identityColorKey as IdentityColorKey) ?? bucketLegacyColorToKey(initial?.color ?? '')
  )

  // ── Progressive help: every longer explanation lives behind a small "?" so
  // the default view is short labels only.
  const [openHelp, setOpenHelp] = useState<Set<string>>(new Set())
  const toggleHelp = (key: string) => {
    setOpenHelp((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const HelpBtn = ({ k, label: aria }: { k: string; label: string }) => (
    <button
      type="button"
      aria-label={aria}
      aria-expanded={openHelp.has(k)}
      onClick={() => toggleHelp(k)}
      className={`inline-flex items-center justify-center w-4 h-4 rounded-full border text-[10px] font-semibold leading-none shrink-0 transition-colors ${
        openHelp.has(k) ? 'border-[var(--brand)] text-[var(--brand)] bg-[color-mix(in_srgb,var(--brand)_12%,transparent)]' : 'border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
      }`}
    >
      ?
    </button>
  )
  const Hint = ({ k, children }: { k: string; children: React.ReactNode }) =>
    openHelp.has(k) ? <p className="text-[11px] text-[var(--text-muted)] mt-1 leading-snug">{children}</p> : null

  const bothChosen = uiProvider !== null && sessionType !== null

  // Changing the model must not leave an effort the new model can't run selected:
  // the chip greys out (disabled) but its value stays in state and still submits
  // (--effort xhigh --model claude-opus-4-6). Reset to '' (Default, always valid)
  // when the current effort is no longer supported, using the SAME per-model
  // gating the chips use (effortsForModel → disabled). '' needs no check.
  const handleModelChange = (nextModel: string) => {
    setModel(nextModel)
    if (!effortSupportedFor(registry, nextModel, effortLevel)) setEffortLevel('')
  }

  const handleBrowse = async () => {
    const path = await window.electronAPI.dialog.openFolder()
    if (path) setWorkingDir(path)
  }

  const handleGroupChange = (value: string) => {
    if (value === '__new__') {
      setShowNewGroup(true)
      setGroupId(undefined)
    } else if (value === '') {
      setGroupId(undefined)
      setShowNewGroup(false)
    } else {
      setGroupId(value)
      setShowNewGroup(false)
      // Group's section takes priority, clear config-level section
      setSectionId(undefined)
      setShowNewSection(false)
    }
  }

  const handleSectionChange = (value: string) => {
    if (value === '__new__') {
      setShowNewSection(true)
      setSectionId(undefined)
    } else if (value === '') {
      setSectionId(undefined)
      setShowNewSection(false)
    } else {
      setSectionId(value)
      setShowNewSection(false)
    }
  }

  const handleCreateSection = () => {
    if (!newSectionName.trim()) return
    const id = generateId()
    addSection({ id, name: newSectionName.trim() })
    setSectionId(id)
    setNewSectionName('')
    setShowNewSection(false)
  }

  const handleCreateGroup = () => {
    if (!newGroupName.trim()) return
    const id = generateId()
    addGroup({ id, name: newGroupName.trim() })
    setGroupId(id)
    setNewGroupName('')
    setShowNewGroup(false)
  }

  // A working directory must be ABSOLUTE, platform-appropriately. Rejecting '.',
  // relative paths, and shape-only lookalikes (`~evil`, `/etc` on Windows) closes
  // the transcript-misfiling incident at the source: a non-absolute path silently
  // resolves to $HOME at spawn, which client validation only half-fixed before
  // (empty was blocked, '.' and friends still saved — adversarial review, #188).
  const looksAbsolute = (raw: string) => {
    const p = raw.trim()
    // Home-relative: only a bare ~ or ~/ ~\ prefix (NOT ~evil).
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return true
    if (window.electronPlatform === 'win32') {
      return /^([a-zA-Z]:[\\/]|\\\\|\/\/)/.test(p)  // drive path or UNC (either slash)
    }
    return p.startsWith('/')  // POSIX absolute
  }
  // Mirror ssh-shim.ts SAFE_REMOTE_PATH_RE: main THROWS on a bad remote path
  // (inside a setTimeout → crashes the main process), so a freely-typed space or
  // shell char must be caught here, not just at spawn (adversarial review, #188).
  const safeRemotePath = (p: string) => /^[~A-Za-z0-9_./-]+$/.test(p)

  // The footer's validation slot: names the next step in a fixed order instead
  // of letting Save silently no-op (the old dialog's worst habit).
  const validationMsg = (() => {
    if (!uiProvider) return 'Choose what this launcher runs'
    if (!sessionType) return 'Choose where it runs'
    // A hand-edited or migrated config can carry the Codex×SSH combination the
    // cards forbid; the disabled cards don't constrain saved state, so guard it
    // here or the config saves and then hard-throws at spawn.
    if (uiProvider === 'codex' && sessionType === 'ssh') return "Codex can't run over SSH — pick Claude Code or Terminal only"
    // A terminal-only secret argument the shell cannot carry intact (a double
    // quote, a trailing backslash, cmd metacharacters on Windows; a line break
    // anywhere) is refused here, by the same rule the command-button dialog
    // uses: the app cannot rewrite a secret. (ADR-009 pass, beta.16.)
    if (uiProvider === 'terminal' && sessionType === 'local' && secretArg) {
      const problem = secretValueProblem(secretArg, window.electronPlatform === 'win32')
      if (problem) return problem
    }
    // A {secret} written where no reference form is safe (just outside a closed
    // quote, inside single quotes, or as the command itself) is left LITERAL at
    // launch rather than substituted — the ADR-009 pass measured the alternative
    // leaking the value into its own argv entry. Say so here, or the user only
    // finds out when the command fails. (#371)
    if (uiProvider === 'terminal' && sessionType === 'local') {
      const placement =
        secretPlacementProblem(termCommand, { isCommandLine: true }) ?? secretPlacementProblem(termArgs)
      if (placement) return placement
    }
    // Required only where the folder is load-bearing: an agent session reads and
    // edits files there, and it's the folder transcripts get filed under. A
    // terminal-only launcher often just runs a command that connects somewhere
    // else, so an empty value is legitimate — it starts in the home folder.
    if (sessionType === 'local' && uiProvider !== 'terminal' && !workingDir.trim()) {
      return 'Add a working directory to save'
    }
    // Enforce the absolute-path rule only on a CHANGED value: an imported or
    // synced config with a foreign-platform absolute path (e.g. a macOS
    // /Users/... path opened on Windows) can still have its label/colour/model
    // edited without being forced to fix the path (adversarial review, #188).
    if (sessionType === 'local' && workingDir.trim() !== (initial?.workingDirectory ?? '').trim() && !looksAbsolute(workingDir)) {
      return 'Working directory must be a full path (e.g. C:\\projects\\app)'
    }
    if (sessionType === 'ssh' && !sshHost.trim()) return 'Add a host to save'
    if (sessionType === 'ssh' && sshRemotePath.trim() && !safeRemotePath(sshRemotePath.trim())) return 'Remote directory can only use letters, numbers and _ . / - ~'
    if (sessionType === 'ssh' && runtimeType === 'container') {
      const name = rtContainer.trim()
      if (!name) return 'Name the container to save'
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) return 'Container name can only use letters, numbers and _ . -'
      if (rtDir.trim() && !/^[A-Za-z0-9_./~-]+$/.test(rtDir.trim())) return 'Container directory can only use letters, numbers and _ . / - ~'
    }
    if (!label.trim()) return 'Add a label to save'
    return ''
  })()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (validationMsg || !uiProvider || !sessionType) return

    const provider: ProviderId = uiProvider === 'codex' ? 'codex' : 'claude'
    const shellOnly = uiProvider === 'terminal'

    // Last clamp before the value is persisted: the load-time one runs before
    // the registry may have hydrated, and nothing re-checks in between if the
    // user never touches the model select (ADR-009 MINOR on #404).
    const effectiveEffort: EffortValue | '' =
      effortSupportedFor(registry, model, effortLevel) ? effortLevel : ''

    // Both of these gate a tip's "you have already found this" variant, and
    // neither was ever recorded — so the tips kept explaining effort levels and
    // SSH sessions to people who had configured both. Recorded on save, not on
    // every keystroke: choosing a value in a form you then abandon is not using
    // the feature.
    if (uiProvider === 'claude' && effectiveEffort !== '') trackUsage('sessions.effort-level')
    if (sessionType === 'ssh') trackUsage('sessions.session-type')
    if (provider === 'codex') trackUsage('sessions.codex-config')

    // No '.' fallback: the empty-directory default is how the transcript
    // misfiling incident happened; validation above requires a real path.
    const dir = sessionType === 'ssh' ? (sshRemotePath.trim() || '~') : workingDir.trim()

    // Spread-then-set preserves stored fields this dialog no longer edits
    // (legacyVersion, agentIds, disableAutoMemory, enableCodexReview) instead
    // of wiping them on every save — the bug that ate effortLevel for years.
    const claudeOptions = uiProvider === 'claude' ? {
      ...initialClaude,
      model: model || undefined,
      effortLevel: effectiveEffort === '' ? undefined : effectiveEffort,
      // 'default' is the no-op sentinel; persist only a real override.
      permissionMode: permissionMode && permissionMode !== 'default' ? permissionMode : undefined,
      extraArgs: extraArgs.trim() || undefined,
      // DEFAULT-TRUE: only write false when the user has turned the toggle off.
      loggingEnabled: !loggingEnabled ? false : undefined,
    } : initial?.claudeOptions

    // Terminal-only options. Local only: over SSH the startup command IS the
    // post-connect command, so we never write a second one here.
    const isTerminalLocal = uiProvider === 'terminal' && sessionType === 'local'
    const secretSaved = isTerminalLocal && (secretArg.length > 0 || storedSecret)
    const terminalOptions = isTerminalLocal
      ? (termCommand.trim() || termArgs.trim() || secretSaved || termElevated
          ? {
              command: termCommand.trim() || undefined,
              args: termArgs.trim() || undefined,
              hasSecretArg: secretSaved || undefined,
              elevated: termElevated || undefined,
            }
          : undefined)
      : initial?.terminalOptions

    const codexOptions: CodexOptions | undefined = uiProvider === 'codex' ? {
      model: codexModel,
      reasoningEffort: codexEffort,
      permissionsPreset: codexPreset,
    } : undefined

    // SECURITY (adversarial review, #188): every credential decision is gated on
    // the FINAL sessionType. Without this, switching an SSH config to Local (or
    // to Terminal-only) drops the SSH block from the UI but leaves savePassword/
    // storedPassword state untouched — so the config saved with no sshConfig
    // while its keychain secret survived orphaned, later auto-typed at a
    // different host. sudo additionally requires a post-connect command: clearing
    // that command must strand nothing. When these are false and the config
    // previously had a stored secret, the delete block below removes it.
    // A stored secret is ENDPOINT-specific: if the user repoints an SSH config at
    // a different host, PORT, or username without retyping, the old password must
    // NOT carry to the new endpoint (adversarial review, #188 — host, port and
    // username all change the principal being authenticated). Treat the stored
    // value as absent in that case, so it is deleted below and re-entry required.
    const isSsh = sessionType === 'ssh'
    const prevSsh = initial?.sshConfig
    const endpointChanged = isSsh && !!prevSsh && (
      (prevSsh.host ?? '').trim() !== sshHost.trim() ||
      prevSsh.port !== sshPort ||
      (prevSsh.username ?? '').trim() !== (sshUser.trim() || 'root')
    )
    const keepStoredPw = storedPassword && !endpointChanged
    const keepStoredSudo = storedSudo && !endpointChanged
    const passwordSaved = isSsh && savePassword && (sshPassword.length > 0 || keepStoredPw)
    // Sudo secret is warranted by EITHER a container runtime that needs sudo
    // (its real home, item e) or a legacy free-text prep command.
    const sudoWarranted = (runtimeType === 'container' && rtSudo) || postCommand.trim().length > 0
    const sudoSaved = isSsh && sudoWarranted && saveSudo && (sudoPassword.length > 0 || keepStoredSudo)

    const config: Omit<TerminalConfig, 'id'> = {
      provider,
      label: label.trim(),
      workingDirectory: dir,
      identityColorKey: colorKey,
      color: resolveIdentityColor(colorKey, 'dark'),  // back-compat shadow; render prefers the key
      sessionType,
      shellOnly,
      terminalOptions,
      groupId,
      sectionId: groupId ? undefined : sectionId,
      sshConfig: sessionType === 'ssh' ? {
        // Spread preserves fields the dialog doesn't edit (dockerContainer).
        ...initial?.sshConfig,
        host: sshHost.trim(),
        port: sshPort,
        username: sshUser.trim() || 'root',
        remotePath: sshRemotePath.trim() || '~',
        hasPassword: passwordSaved,
        postCommand: postCommand.trim() || undefined,
        hasSudoPassword: sudoSaved,
        // item e: structured runtime persists ONLY when the container choice is
        // made; 'host' stores nothing (undefined = default, same shape rule as
        // detachable below).
        runtime: runtimeType === 'container' ? {
          type: 'container',
          engine: rtEngine,
          container: rtContainer.trim(),
          mode: rtMode,
          sudo: rtSudo || undefined,
          containerDir: rtDir.trim() || undefined,
        } : undefined,
        // item 1: persist only the opt-OUT (false); ON is the default/undefined.
        detachable: detachable ? undefined : false,
      } : undefined,
      claudeOptions,
      codexOptions,
      // Allow Multi Spawn (phase 4.1): TRI-STATE, not an opt-in-only flag.
      // Turning it off on a config that had it on stores an explicit `false`,
      // which the startup migration is forbidden to touch — otherwise the
      // migration re-enables it next launch and the user's OFF never sticks.
      allowMultiSpawn: resolveAllowMultiSpawnOnSave(allowMultiSpawn, initial?.allowMultiSpawn),
      // The ×N control's remembered copy count belongs to the ROW, not this
      // dialog. Carry it through untouched so editing a config never resets it
      // (the field-by-field rebuild below the sshConfig spread is exactly how
      // detachable and loggingEnabled were silently dropped before).
      multiSpawnCount: initial?.multiSpawnCount,
      machineName: sessionType === 'ssh' && machineName.trim() ? machineName.trim() : undefined,
      // Account is no longer a config field -- it's chosen at launch by the
      // pre-spawn account gate. Preserve any pre-existing value on edit so older
      // configs aren't silently rewritten, but never set it from this dialog.
      profileId: initial?.profileId,
      // Partner terminal is permanent for every config type (2 Aug decision):
      // the dialog no longer writes a path or elevation. Stored values on old
      // configs are simply ignored by the app.
    }

    // On edit, delete any keychain entry we are NOT (re)saving. Gated only on
    // "not saving", NOT on the config's hasPassword flag: the flag can lie
    // (a config the old dialog left in the divergent state has hasPassword:false
    // with a live secret), and credentials.delete is idempotent, so an
    // unconditional delete-when-not-saving both removes intentional "Remove
    // stored password" entries AND sweeps pre-existing orphans (adversarial
    // review, #188). Runs on confirm, never before.
    if (initial?.id) {
      if (!passwordSaved) void window.electronAPI.credentials.delete(initial.id)
      if (!sudoSaved) void window.electronAPI.credentials.delete(initial.id + '_sudo')
      // Same rule for the Terminal-only secret: switching the config away from a
      // local terminal, or clearing the secret, must not strand it in the keychain.
      if (!secretSaved) void window.electronAPI.credentials.delete(initial.id + '_argsecret')
    }

    onConfirm(
      config,
      // Honest save, gated on the final sessionType: a typed password reaches the
      // keychain ONLY when this is still an SSH config AND the checkbox is on. The
      // old dialog stored it regardless — so a password typed into an SSH block
      // that was then switched to Local was persisted for a config with no SSH.
      passwordSaved && sshPassword.length > 0 ? sshPassword : undefined,
      sudoSaved && sudoPassword.length > 0 ? sudoPassword : undefined,
      secretSaved && secretArg.length > 0 ? secretArg : undefined,
    )
  }

  // ── Small shared bits
  const sectionHead = (title: string, chip: string, helpKey?: string, helpLabel?: string) => (
    <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-3 mt-4 mb-2">
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] font-medium">{title}</span>
      <span className="text-[9px] uppercase tracking-wide text-[var(--text-muted)] border border-[var(--border-strong)] rounded-full px-1.5 py-px">{chip}</span>
      {helpKey && helpLabel && <HelpBtn k={helpKey} label={helpLabel} />}
    </div>
  )

  // Native radio inputs styled as cards: the browser then provides the ARIA
  // radiogroup keyboard pattern for free (roving tabindex, arrow-key navigation,
  // skip-disabled) instead of the hand-rolled role="radio" buttons that claimed
  // radio semantics but only responded to Tab/Enter (Copilot review, #188).
  const cardCls = (selected: boolean, disabled: boolean) =>
    `flex-1 text-left rounded-[10px] border px-3 py-2 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-[var(--brand)] ${
      disabled
        ? 'border-[var(--border-subtle)] bg-[var(--surface-base)] opacity-50 cursor-not-allowed'
        : selected
          ? 'border-[var(--brand)] bg-[color-mix(in_srgb,var(--brand)_14%,var(--surface-base))] cursor-pointer'
          : 'border-[var(--border-subtle)] bg-[var(--surface-base)] hover:border-[var(--border-strong)] cursor-pointer'
    }`

  const providerCard = (id: UiProvider, title: string, sub: string, disabled: boolean) => (
    <label className={cardCls(uiProvider === id, disabled)}>
      <input
        type="radio"
        name="ccc-provider"
        className="sr-only"
        value={id}
        checked={uiProvider === id}
        disabled={disabled}
        onChange={() => setUiProvider(id)}
      />
      <span className={`block text-sm font-medium ${disabled ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>{title}</span>
      <span className="block text-[10px] text-[var(--text-muted)] mt-0.5">{sub}</span>
    </label>
  )

  // Connection choice (config-modal redesign, item i): Local | SSH | SSH
  // Persistent. The old "Detachable" checkbox is this third card — persistence
  // is a connection KIND, not a tweak buried under the SSH fields. Maps onto
  // the stored shape unchanged (sessionType + detachable), so a pre-redesign
  // config with Detachable ticked (or unset — the old default) opens as SSH
  // Persistent with no data migration.
  type ConnectionChoice = 'local' | 'ssh' | 'ssh-persistent'
  const connectionChoice: ConnectionChoice | null =
    sessionType === null ? null : sessionType === 'local' ? 'local' : detachable ? 'ssh-persistent' : 'ssh'
  const pickConnection = (id: ConnectionChoice) => {
    if (id === 'local') { setSessionType('local'); return }
    setSessionType('ssh')
    setDetachable(id === 'ssh-persistent')
  }
  const connectionCard = (id: ConnectionChoice, title: string, sub: string, disabled: boolean) => (
    <label className={cardCls(connectionChoice === id, disabled)}>
      <input
        type="radio"
        name="ccc-transport"
        className="sr-only"
        value={id}
        checked={connectionChoice === id}
        disabled={disabled}
        onChange={() => pickConnection(id)}
      />
      <span className={`block text-sm font-medium ${disabled ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>{title}</span>
      <span className="block text-[10px] text-[var(--text-muted)] mt-0.5">{sub}</span>
    </label>
  )

  const inputCls = 'w-full bg-[var(--surface-base)] border border-[var(--border-strong)] rounded-lg px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus-ring'

  const permHint = DANGEROUS_MODE_COPY[permissionMode]
    ?? PERMISSION_MODES.find((m) => m.value === permissionMode)?.hint
    ?? ''
  const permDangerous = permissionMode in DANGEROUS_MODE_COPY

  return (
    <DialogOverlay testId="session-dialog">
      <DialogPanel width="w-[680px]" className="max-h-[90vh]" labelledBy="session-dialog-title">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col min-h-0"
        data-testid="session-dialog-form"
      >
        <DialogHeader
          titleId="session-dialog-title"
          title={isEdit ? 'Edit config' : 'New saved config'}
          subtitle="Every click on this launcher starts a fresh session with these settings."
          onClose={onCancel}
          closeLabel="Cancel"
        />

        <div className="px-[18px] pb-4 overflow-y-auto flex-1 min-h-0">

          {isEdit && liveSessionCount > 0 && (
            <div
              className="mt-4 px-3 py-2 rounded-lg text-[11.5px] leading-snug"
              style={{
                color: 'var(--status-warning)',
                background: 'color-mix(in srgb, var(--status-warning) 9%, transparent)',
                border: '1px solid color-mix(in srgb, var(--status-warning) 40%, transparent)',
              }}
              data-testid="edit-while-running-note"
            >
              {liveSessionCount === 1 ? 'A session launched from this config is running.' : `${liveSessionCount} sessions launched from this config are running.`}{' '}
              They keep the settings they launched with; your edits apply to sessions started from now on. Restarting a live SSH session after changing its connection details will be refused, and a restarted shell whose command line changed will run without its secret argument.
            </div>
          )}

          {/* ── 1 · WHAT THIS LAUNCHER RUNS ── */}
          <div className="flex items-center gap-2 pt-4 mb-2">
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] font-medium">What this launcher runs</span>
            <span className="text-[9px] uppercase tracking-wide text-[var(--text-muted)] border border-[var(--border-strong)] rounded-full px-1.5 py-px">Any provider</span>
            <HelpBtn k="runs" label="About this section" />
          </div>
          <Hint k="runs">
            Pick the agent this launcher starts and where it runs — everything below adapts to these two
            choices. Claude Code signs in with your Claude account; Codex needs its own OpenAI account.
          </Hint>
          <div className="flex gap-2 mt-2" role="radiogroup" aria-label="Provider">
            {providerCard('claude', 'Claude Code', "Anthropic's coding agent", false)}
            {providerCard('codex', 'Codex', "OpenAI's coding agent", codexDisabled || sessionType === 'ssh')}
            {providerCard('terminal', 'Terminal only', 'A plain terminal — no AI', false)}
          </div>
          {sessionType === 'ssh' && (
            <p className="text-[11px] text-[var(--status-danger)] mt-1.5">Codex can't run over SSH yet — choose Claude Code or Terminal only.</p>
          )}
          {codexDisabled && sessionType !== 'ssh' && (
            <p className="text-[11px] text-[var(--text-muted)] mt-1.5">Codex is off — enable it in Settings → Codex to use it here.</p>
          )}
          {uiProvider !== null && (
            <>
              <div className="flex gap-2 mt-2" role="radiogroup" aria-label="Connection">
                {connectionCard('local', 'Local', 'Runs on this PC', false)}
                {connectionCard('ssh', 'SSH', 'Another machine, plain session', uiProvider === 'codex')}
                {connectionCard('ssh-persistent', 'SSH Persistent', 'Survives disconnects, reattaches', uiProvider === 'codex')}
              </div>
              {uiProvider === 'codex' && (
                <p className="text-[11px] text-[var(--text-muted)] mt-1.5">Codex runs on this PC only — SSH isn't available.</p>
              )}
              {/* Allow Multi Spawn (phase 4). Off by default: a launcher runs
                  ONE session at a time, and every launch surface refuses the
                  second copy (with a popover offering this very switch). Turn
                  it on for a config you routinely want several of. */}
              <label className="flex items-start gap-2 mt-2.5 cursor-pointer" data-testid="allow-multi-spawn-field">
                <input
                  type="checkbox"
                  checked={allowMultiSpawn}
                  onChange={(e) => setAllowMultiSpawn(e.target.checked)}
                  className="mt-0.5 rounded border-[var(--border-subtle)] accent-[var(--brand)]"
                  data-testid="allow-multi-spawn"
                />
                <span className="block">
                  <span className="block text-sm text-[var(--text-secondary)]">Allow Multi Spawn</span>
                  <span className="block text-[10px] text-[var(--text-muted)] mt-0.5">Launch several copies of this config at once</span>
                </span>
              </label>
            </>
          )}

          {bothChosen && (
            <>
              {/* ── 2 · WORKSPACE ── */}
              {sectionHead('Workspace', 'Any provider', 'ws', 'About the workspace')}
              <Hint k="ws">
                {sessionType !== 'local'
                  ? "Where sessions land after connecting. Your PC's folders are not visible to this session."
                  : uiProvider === 'terminal'
                    ? 'The folder the terminal starts in. Optional — leave it blank and the session starts in your home folder, which is usually what you want when the command connects somewhere else.'
                    : 'The folder every session starts in. The agent can read and edit files here, with your approval. Every session also gets a second plain terminal from the command bar — no setup needed.'}
              </Hint>

              {sessionType === 'local' ? (
                <div className="mt-1">
                  <label className="block text-xs text-[var(--text-secondary)] mb-1">
                    Working directory{' '}
                    {uiProvider === 'terminal'
                      ? <span className="text-[var(--text-muted)]">(optional)</span>
                      : <span className="text-[var(--status-warning)]">*</span>}
                  </label>
                  <div className="flex gap-2">
                    <input
                      value={workingDir}
                      onChange={(e) => setWorkingDir(e.target.value)}
                      placeholder={
                        uiProvider === 'terminal'
                          ? 'Leave blank to start in your home folder'
                          : window.electronPlatform === 'win32' ? 'C:\\path\\to\\project' : '~/path/to/project'
                      }
                      className={inputCls.replace('w-full', 'flex-1')}
                    />
                    <DialogButton variant="secondary" onClick={handleBrowse} className="shrink-0" style={{ height: 'auto', alignSelf: 'stretch' }}>
                      Browse
                    </DialogButton>
                  </div>
                  {/* Grandfathered bad value: an existing config keeps saving (we only
                      block a CHANGED non-absolute path), but say what it actually does
                      — '.' and friends resolve to the home folder at spawn, which is
                      what mis-filed transcripts before. */}
                  {workingDir.trim() && !looksAbsolute(workingDir) && (
                    <p className="text-[11px] text-[var(--status-warning)] mt-1.5">
                      {uiProvider === 'terminal'
                        ? 'Not a full path — this session will start in your home folder. Clear the field if that’s what you want.'
                        : 'Not a full path — sessions will start in your home folder. Pick a real project folder.'}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-3 mt-1">
                  <div className="grid grid-cols-[1fr_90px] gap-2">
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <label className="text-xs text-[var(--text-secondary)]">Host <span className="text-[var(--status-warning)]">*</span></label>
                        <HelpBtn k="host" label="About host" />
                      </div>
                      <input
                        value={sshHost}
                        onChange={(e) => setSshHost(e.target.value)}
                        placeholder="192.168.1.100"
                        className={inputCls}
                      />
                      <Hint k="host">IP address or hostname of the machine to connect to.</Hint>
                    </div>
                    <div>
                      <label className="block text-xs text-[var(--text-secondary)] mb-1">Port <span className="text-[var(--status-warning)]">*</span></label>
                      <input
                        type="number"
                        value={sshPort}
                        onChange={(e) => setSshPort(parseInt(e.target.value) || 22)}
                        className={inputCls}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-[var(--text-secondary)] mb-1">User</label>
                      <input
                        value={sshUser}
                        onChange={(e) => setSshUser(e.target.value)}
                        placeholder="root"
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[var(--text-secondary)] mb-1">Password</label>
                      <input
                        type="password"
                        value={sshPassword}
                        onChange={(e) => setSshPassword(e.target.value)}
                        placeholder={storedPassword ? '(saved — enter new to change)' : 'Leave empty if you use an SSH key'}
                        className={inputCls}
                      />
                      {(sshPassword.length > 0 || storedPassword) && (
                        <div className="flex items-center gap-3 mt-1.5">
                          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                            <input
                              type="checkbox"
                              checked={savePassword}
                              onChange={(e) => setSavePassword(e.target.checked)}
                              className="rounded border-[var(--border-subtle)] accent-[var(--brand)]"
                            />
                            Save password
                          </label>
                          {storedPassword && (
                            <button
                              type="button"
                              onClick={() => { setStoredPassword(false); setSavePassword(false); setSshPassword('') }}
                              className="text-[11px] text-[var(--brand)] underline underline-offset-2"
                            >
                              Remove stored password
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <label className="text-xs text-[var(--text-secondary)]">Remote directory</label>
                        <HelpBtn k="rdir" label="About the remote directory" />
                      </div>
                      <input
                        value={sshRemotePath}
                        onChange={(e) => setSshRemotePath(e.target.value)}
                        placeholder="~"
                        className={inputCls}
                      />
                      <Hint k="rdir">Where sessions land after connecting. Defaults to the home directory (~).</Hint>
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <label className="text-xs text-[var(--text-secondary)]">Machine name</label>
                        <HelpBtn k="mname" label="About machine name" />
                      </div>
                      <input
                        value={machineName}
                        onChange={(e) => setMachineName(e.target.value)}
                        placeholder="e.g. Unix 185"
                        className={inputCls}
                      />
                      <Hint k="mname">Optional display name, shown in logs and the status line so you can tell machines apart.</Hint>
                    </div>
                  </div>
                </div>
              )}

              {/* ── 2b · RUNTIME (item e) — where claude actually runs after the
                     connection is up. The app composes the container command
                     itself; free-text prep survives under Advanced only. ── */}
              {sessionType === 'ssh' && (
                <>
                  {sectionHead('Runtime', 'Any provider', 'runtime', 'About the runtime')}
                  <Hint k="runtime">
                    Where the session actually runs once connected. "In a Docker container" makes the app
                    build and run the container command itself — no shell one-liners to maintain.
                  </Hint>
                  <div className="flex gap-2 mt-2" role="radiogroup" aria-label="Runtime">
                    <label className={cardCls(runtimeType === 'host', false)}>
                      <input type="radio" name="ccc-runtime" className="sr-only" value="host"
                        checked={runtimeType === 'host'} onChange={() => setRuntimeType('host')} />
                      <span className="block text-sm font-medium text-[var(--text-primary)]">On the host</span>
                      <span className="block text-[10px] text-[var(--text-muted)] mt-0.5">Directly on the machine you connect to</span>
                    </label>
                    <label className={cardCls(runtimeType === 'container', false)}>
                      <input type="radio" name="ccc-runtime" className="sr-only" value="container"
                        checked={runtimeType === 'container'} onChange={() => setRuntimeType('container')} data-testid="runtime-container" />
                      <span className="block text-sm font-medium text-[var(--text-primary)]">In a Docker container</span>
                      <span className="block text-[10px] text-[var(--text-muted)] mt-0.5">The app execs into the container for you</span>
                    </label>
                  </div>
                  {runtimeType === 'container' && (
                    <div className="space-y-3 mt-3">
                      <div className="grid grid-cols-[110px_1fr_150px] gap-2">
                        <div>
                          <label className="block text-xs text-[var(--text-secondary)] mb-1">Engine</label>
                          <select value={rtEngine} onChange={(e) => setRtEngine(e.target.value as 'docker' | 'podman')} className={inputCls}>
                            <option value="docker">docker</option>
                            <option value="podman">podman</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-[var(--text-secondary)] mb-1">Container name <span className="text-[var(--status-warning)]">*</span></label>
                          <input value={rtContainer} onChange={(e) => setRtContainer(e.target.value)}
                            placeholder="claude-dev" className={inputCls + ' font-mono text-xs'} data-testid="runtime-container-name" />
                        </div>
                        <div>
                          <label className="block text-xs text-[var(--text-secondary)] mb-1">Mode</label>
                          <select value={rtMode} onChange={(e) => setRtMode(e.target.value as 'exec' | 'start')} className={inputCls}>
                            <option value="exec">Exec into running</option>
                            <option value="start">Start stopped</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <label className="text-xs text-[var(--text-secondary)]">Container directory</label>
                          <HelpBtn k="rtdir" label="About the container directory" />
                        </div>
                        <input value={rtDir} onChange={(e) => setRtDir(e.target.value)}
                          placeholder="Optional — where the session lands inside the container" className={inputCls} />
                        <Hint k="rtdir">Working directory inside the container. Leave blank for the container's default.</Hint>
                      </div>
                      <div>
                        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                          <input type="checkbox" checked={rtSudo} onChange={(e) => setRtSudo(e.target.checked)}
                            className="rounded border-[var(--border-subtle)] accent-[var(--brand)]" data-testid="runtime-sudo" />
                          The container engine needs sudo
                        </label>
                        {rtSudo && (
                          <div className="mt-2">
                            <label className="block text-xs text-[var(--text-secondary)] mb-1">Sudo password</label>
                            <input
                              type="password"
                              value={sudoPassword}
                              onChange={(e) => setSudoPassword(e.target.value)}
                              placeholder={storedSudo ? '(saved — enter new to change)' : 'Used to run the engine with sudo'}
                              className={inputCls}
                            />
                            {(sudoPassword.length > 0 || storedSudo) && (
                              <div className="flex items-center gap-3 mt-1.5">
                                <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={saveSudo}
                                    onChange={(e) => setSaveSudo(e.target.checked)}
                                    className="rounded border-[var(--border-subtle)] accent-[var(--brand)]"
                                  />
                                  Save password
                                </label>
                                {storedSudo && (
                                  <button
                                    type="button"
                                    onClick={() => { setStoredSudo(false); setSaveSudo(false); setSudoPassword('') }}
                                    className="text-[11px] text-[var(--brand)] underline underline-offset-2"
                                  >
                                    Remove stored password
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {/* Migration affordance: a docker-shaped free-text post-command
                      converts with one click — never silently. */}
                  {runtimeType === 'host' && parseDockerPostCommand(postCommand) && (
                    <div
                      className="mt-3 px-3 py-2 rounded-lg text-[11.5px] leading-snug flex items-center justify-between gap-3"
                      style={{
                        color: 'var(--status-warning)',
                        background: 'color-mix(in srgb, var(--status-warning) 9%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--status-warning) 40%, transparent)',
                      }}
                      data-testid="runtime-convert-offer"
                    >
                      <span>Your "after connecting" command looks like a container command. Convert it to a structured Runtime?</span>
                      <DialogButton
                        variant="secondary"
                        onClick={() => {
                          const parsed = parseDockerPostCommand(postCommand)!
                          setRuntimeType('container')
                          setRtEngine(parsed.engine ?? 'docker')
                          setRtContainer(parsed.container ?? '')
                          setRtMode(parsed.mode ?? 'exec')
                          setRtSudo(Boolean(parsed.sudo))
                          setPostCommand('')
                        }}
                      >
                        Convert
                      </DialogButton>
                    </div>
                  )}
                  <details className="mt-3 group">
                    <summary className="text-xs text-[var(--text-secondary)] cursor-pointer select-none">Advanced</summary>
                    <div className="mt-2 space-y-3">
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <label className="text-xs text-[var(--text-secondary)]">After connecting, run</label>
                          <HelpBtn k="postcmd" label="About the post-connect command" />
                        </div>
                        <input
                          value={postCommand}
                          onChange={(e) => setPostCommand(e.target.value)}
                          placeholder="Arbitrary prep — runs before the Runtime command"
                          className={inputCls + ' font-mono text-xs'}
                        />
                        <Hint k="postcmd">
                          Optional prep run once the connection is up, before the Runtime command (if any).
                          For entering a container, use the Runtime section instead — the app builds that
                          command for you.
                        </Hint>
                      </div>
                      {runtimeType === 'host' && postCommand.trim() && (
                        <div>
                          <label className="block text-xs text-[var(--text-secondary)] mb-1">Sudo password</label>
                          <input
                            type="password"
                            value={sudoPassword}
                            onChange={(e) => setSudoPassword(e.target.value)}
                            placeholder={storedSudo ? '(saved — enter new to change)' : 'Only needed if the command above uses sudo'}
                            className={inputCls}
                          />
                          {(sudoPassword.length > 0 || storedSudo) && (
                            <div className="flex items-center gap-3 mt-1.5">
                              <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={saveSudo}
                                  onChange={(e) => setSaveSudo(e.target.checked)}
                                  className="rounded border-[var(--border-subtle)] accent-[var(--brand)]"
                                />
                                Save password
                              </label>
                              {storedSudo && (
                                <button
                                  type="button"
                                  onClick={() => { setStoredSudo(false); setSaveSudo(false); setSudoPassword('') }}
                                  className="text-[11px] text-[var(--brand)] underline underline-offset-2"
                                >
                                  Remove stored password
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </details>
                </>
              )}

              {/* ── 3 · SESSION STARTUP (Claude Code / Codex; a Terminal-only
                     launcher has nothing to configure here yet) ── */}
              {uiProvider === 'claude' && (
                <>
                  {sectionHead('Session startup', 'Claude Code only', 'startup', 'About session startup')}
                  <Hint k="startup">
                    Starting values only — sessions begin here, and you can change any of them mid-session
                    with /model, /effort and /permissions.
                  </Hint>
                  <div className="space-y-3 mt-1">
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <label className="text-xs text-[var(--text-secondary)]">Starting model</label>
                        <HelpBtn k="model" label="About the starting model" />
                      </div>
                      <select
                        value={model}
                        onChange={(e) => handleModelChange(e.target.value)}
                        className={inputCls}
                      >
                        <option value="">Default — follows your Claude plan</option>
                        {modelGroupsFromRegistry(registry).map((g) => (
                          <optgroup key={g.title} label={g.title}>
                            {g.items.map((m) => (
                              <option key={m.value} value={m.value}>{m.label}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      <Hint k="model">
                        Which model sessions start on — change it anytime with /model. The names under
                        “Latest” always point at the newest model in each family; the versions under each
                        family pin that exact model.
                      </Hint>
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <label className="text-xs text-[var(--text-secondary)]">Starting effort</label>
                        <HelpBtn k="effort" label="About the starting effort" />
                      </div>
                      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Starting effort">
                        {[{ value: '', label: 'Default', disabled: false }, ...effortsForModel(registry, model)].map((ef) => (
                          <label
                            key={ef.value || 'default'}
                            title={ef.disabled ? `Not offered on ${model}` : undefined}
                            className={`px-2.5 py-1 rounded-full border text-xs transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-[var(--brand)] ${
                              ef.disabled
                                ? 'border-[var(--border-subtle)] bg-[var(--surface-base)] text-[var(--text-muted)] cursor-not-allowed'
                                : effortLevel === ef.value
                                  ? 'border-[var(--brand)] bg-[color-mix(in_srgb,var(--brand)_14%,transparent)] text-[var(--text-primary)] cursor-pointer'
                                  : 'border-[var(--border-subtle)] bg-[var(--surface-base)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] cursor-pointer'
                            }`}
                          >
                            <input
                              type="radio"
                              name="ccc-effort"
                              className="sr-only"
                              value={ef.value}
                              disabled={ef.disabled}
                              checked={effortLevel === ef.value}
                              onChange={() => setEffortLevel(ef.value as EffortValue | '')}
                            />
                            {ef.label}
                          </label>
                        ))}
                      </div>
                      <Hint k="effort">
                        How hard Claude thinks before answering — change it anytime with /effort. Higher is
                        slower and uses more of your quota.
                      </Hint>
                    </div>
                    <div>
                      <label className="block text-xs text-[var(--text-secondary)] mb-1">Permission mode</label>
                      <select
                        value={permissionMode}
                        onChange={(e) => setPermissionMode(e.target.value)}
                        className={inputCls}
                      >
                        {PERMISSION_MODES.map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                      {permHint && (
                        <p className={`text-[11px] mt-1 ${permDangerous ? 'text-[var(--status-danger)]' : 'text-[var(--text-muted)]'}`}>{permHint}</p>
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <label className="text-xs text-[var(--text-secondary)]">Extra CLI arguments</label>
                        <HelpBtn k="xargs" label="About extra CLI arguments" />
                      </div>
                      <input
                        type="text"
                        value={extraArgs}
                        onChange={(e) => setExtraArgs(e.target.value)}
                        placeholder={sessionType === 'ssh' ? '--add-dir /srv/shared' : '--verbose --add-dir F:\\shared_libs'}
                        spellCheck={false}
                        className={inputCls + ' font-mono text-xs'}
                      />
                      <Hint k="xargs">
                        Advanced. Appended to the claude command exactly as typed. Shell characters are blocked
                        and the app's own flags (--model, --effort, --permission-mode, --settings, --mcp-config,
                        --agents, --resume) can't be overridden here.
                      </Hint>
                    </div>
                    {sessionType === 'local' && (
                      <div>
                        <div className="flex items-center gap-1.5">
                          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
                            <input
                              type="checkbox"
                              checked={loggingEnabled}
                              onChange={(e) => setLoggingEnabled(e.target.checked)}
                              className="rounded border-[var(--border-subtle)] accent-[var(--brand)]"
                            />
                            Index conversation logs
                          </label>
                          <HelpBtn k="logs" label="About conversation logs" />
                        </div>
                        <Hint k="logs">
                          Lets you browse this session's transcript inside the Conductor. Your conversation is always
                          saved by Claude Code either way (~/.claude/projects) — this only controls whether
                          the app indexes it.
                        </Hint>
                      </div>
                    )}
                  </div>
                </>
              )}

              {uiProvider === 'codex' && (
                <>
                  {sectionHead('Session startup', 'Codex only', 'startup-cx', 'About session startup')}
                  <Hint k="startup-cx">
                    Starting values only — Codex signs in with its own OpenAI account, separate from Claude.
                  </Hint>
                  <div className="mt-1">
                    <CodexFormFields
                      value={{ model: codexModel, reasoningEffort: codexEffort, permissionsPreset: codexPreset }}
                      onChange={(next) => {
                        if (next.model !== undefined) setCodexModel(next.model)
                        if (next.reasoningEffort !== undefined) setCodexEffort(next.reasoningEffort)
                        if (next.permissionsPreset !== undefined) setCodexPreset(next.permissionsPreset)
                      }}
                      onOpenSettings={() => {
                        window.dispatchEvent(new CustomEvent('app:openSettings', { detail: { tab: 'codex' } }))
                      }}
                    />
                  </div>
                </>
              )}

              {uiProvider === 'terminal' && sessionType === 'local' && (
                <>
                  {sectionHead('Terminal startup', 'Terminal only', 'termstart', 'About terminal startup')}
                  <Hint k="termstart">
                    No AI here — just a terminal. Anything below runs automatically each time you open this
                    launcher, so it can start a long-running tool for you.
                  </Hint>
                  <div className="space-y-3 mt-1">
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <label className="text-xs text-[var(--text-secondary)]">First-run command</label>
                        <HelpBtn k="termcmd" label="About the first-run command" />
                      </div>
                      <input
                        value={termCommand}
                        onChange={(e) => setTermCommand(e.target.value)}
                        placeholder="npm run dev"
                        spellCheck={false}
                        className={inputCls + ' font-mono text-xs'}
                      />
                      <Hint k="termcmd">Runs once when the terminal opens. Leave empty for a plain shell.</Hint>
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <label className="text-xs text-[var(--text-secondary)]">Arguments</label>
                        <HelpBtn k="termargs" label="About arguments" />
                      </div>
                      <input
                        value={termArgs}
                        onChange={(e) => setTermArgs(e.target.value)}
                        placeholder={'--port 4310 --token {secret}'}
                        spellCheck={false}
                        className={inputCls + ' font-mono text-xs'}
                      />
                      <Hint k="termargs">
                        Appended to the command above. Saved as plain text in your config file — put tokens and
                        keys in Secret argument instead.
                      </Hint>
                    </div>
                    <div>
                      <label className="block text-xs text-[var(--text-secondary)] mb-1">Secret argument</label>
                      <input
                        type="password"
                        value={secretArg}
                        onChange={(e) => setSecretArg(e.target.value)}
                        placeholder={storedSecret ? '(saved — enter new to change)' : 'Leave empty if not needed'}
                        className={inputCls}
                      />
                      <div className="flex items-center gap-3 mt-1.5">
                        <p className="text-[11px] text-[var(--text-muted)]">
                          <span className="text-[var(--status-success)]">🔒</span> Kept in your OS keychain, never written to the
                          config file. Type <span className="font-mono text-[var(--text-secondary)]">{'{secret}'}</span> in
                          the command or Arguments to use it.
                          {window.electronPlatform === 'win32' && <> A value longer than about 8,000 characters will not reach a tool
                          launched through a <span className="font-mono text-[var(--text-secondary)]">.cmd</span> wrapper
                          (most <span className="font-mono text-[var(--text-secondary)]">npm</span>-installed tools) — a limit
                          of the Windows command line itself.</>}
                        </p>
                        {storedSecret && (
                          <button
                            type="button"
                            onClick={() => { setStoredSecret(false); setSecretArg('') }}
                            className="text-[11px] text-[var(--brand)] underline underline-offset-2 shrink-0"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={termElevated}
                        onChange={(e) => setTermElevated(e.target.checked)}
                        className="rounded border-[var(--border-subtle)] accent-[var(--brand)]"
                      />
                      {window.electronPlatform === 'win32'
                        ? 'Run as Administrator (requires gsudo)'
                        : 'Run with elevated privileges (requires sudo)'}
                    </label>
                  </div>
                </>
              )}

              {uiProvider === 'terminal' && sessionType === 'ssh' && (
                <>
                  {sectionHead('Terminal startup', 'Terminal only')}
                  <p className="text-[11px] text-[var(--text-muted)] leading-snug">
                    Over SSH, use the Runtime section above — or <span className="text-[var(--text-secondary)] font-medium">"After connecting, run"</span> under its Advanced fold for arbitrary prep.
                  </p>
                </>
              )}

              {/* ── 4 · ORGANISE (collapsed until needed) ── */}
              {/* The only expandable section. It must NOT dress its trigger in the
                  same pill the static scope chips use ("Any provider", "Terminal
                  only") — that made a clickable row look identical to decoration.
                  A leading chevron that rotates when open, a hover state and a
                  plain "(optional)" read as a control instead. */}
              <details className="group border-t border-[var(--border-subtle)] pt-3 mt-4" open={isEdit && (!!groupId || !!sectionId)}>
                <summary className="flex items-center gap-2 cursor-pointer select-none list-none rounded px-1 -mx-1 py-1 hover:bg-[var(--surface-overlay)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand)] [&::-webkit-details-marker]:hidden">
                  <span className="text-[10px] text-[var(--text-secondary)] transition-transform group-open:rotate-90">▶</span>
                  <span className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] font-medium group-hover:text-[var(--text-primary)]">Organise</span>
                  <span className="text-[11px] text-[var(--text-muted)] normal-case">(optional — group &amp; section)</span>
                </summary>
                <p className="text-[11px] text-[var(--text-muted)] mt-2">Optional — only tidies the sidebar.</p>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <label className="text-xs text-[var(--text-secondary)]" htmlFor="ccc-group">Group</label>
                      <HelpBtn k="group" label="About groups" />
                    </div>
                    <select
                      id="ccc-group"
                      value={showNewGroup ? '__new__' : (groupId || '')}
                      onChange={(e) => handleGroupChange(e.target.value)}
                      className={inputCls}
                    >
                      <option value="">None</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                      <option value="__new__">+ New group…</option>
                    </select>
                    <Hint k="group">A bundle that collapses into one sidebar row and can launch all its configs with one click.</Hint>
                    {showNewGroup && (
                      <div className="flex gap-2 mt-1.5">
                        <input
                          autoFocus
                          value={newGroupName}
                          onChange={(e) => setNewGroupName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateGroup() } }}
                          placeholder="Group name"
                          className={inputCls.replace('w-full', 'flex-1')}
                        />
                        <button
                          type="button"
                          onClick={handleCreateGroup}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors focus-ring"
                          style={{ background: 'var(--brand)', color: ON_BRAND }}
                        >
                          Create
                        </button>
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <label className="text-xs text-[var(--text-secondary)]" htmlFor="ccc-section">Section</label>
                      <HelpBtn k="section" label="About sections" />
                    </div>
                    <select
                      id="ccc-section"
                      value={showNewSection ? '__new__' : (sectionId || '')}
                      onChange={(e) => handleSectionChange(e.target.value)}
                      disabled={!!groupId}
                      className={inputCls + (groupId ? ' opacity-50 cursor-not-allowed' : '')}
                    >
                      <option value="">None</option>
                      {sections.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                      <option value="__new__">+ New section…</option>
                    </select>
                    <Hint k="section">A labelled heading this config sits under. You can launch everything in a section at once.</Hint>
                    {showNewSection && !groupId && (
                      <div className="flex gap-2 mt-1.5">
                        <input
                          autoFocus
                          value={newSectionName}
                          onChange={(e) => setNewSectionName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateSection() } }}
                          placeholder="Section name"
                          className={inputCls.replace('w-full', 'flex-1')}
                        />
                        <button
                          type="button"
                          onClick={handleCreateSection}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors focus-ring"
                          style={{ background: 'var(--brand)', color: ON_BRAND }}
                        >
                          Create
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {groupId && (
                  <p className="text-[11px] text-[var(--status-warning)] mt-2">Grouped configs can't also sit under a section — clear the group to pick one.</p>
                )}
              </details>

              {/* ── 5 · IDENTITY ── */}
              {sectionHead('Identity', 'Any provider', 'identity', 'About identity')}
              <Hint k="identity">
                Names and colours this config so you can tell its sessions apart in the sidebar and tab strip
                when several are running.
              </Hint>
              <div className="grid grid-cols-2 gap-4 mt-1">
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1">Label <span className="text-[var(--status-warning)]">*</span></label>
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. App Dev"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1">Colour</label>
                  <div className="flex flex-wrap gap-1.5">
                    {IDENTITY_SWATCHES.map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setColorKey(k)}
                        className={`w-6 h-6 rounded-md border-2 transition-all ${
                          colorKey === k ? 'border-[var(--text-primary)] scale-110' : 'border-transparent hover:border-[var(--border-strong)]'
                        }`}
                        style={{ backgroundColor: resolveIdentityColor(k, theme) }}
                        title={k}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer: the validation slot names the next step; Save can never
            silently no-op again. */}
        <DialogFooter left={<span className="text-xs" style={{ color: 'var(--status-warning)' }} role="status" data-testid="session-dialog-validation">{validationMsg}</span>}>
          <DialogButton variant="ghost" onClick={onCancel} testId="session-dialog-cancel">Cancel</DialogButton>
          <DialogButton type="submit" variant="primary" disabled={!!validationMsg} testId="session-dialog-submit">
            {isEdit ? 'Save changes' : 'Create config'}
          </DialogButton>
        </DialogFooter>
      </form>
      </DialogPanel>
    </DialogOverlay>
  )
}
