import React, { useState } from 'react'
import { TerminalConfig, ProviderId, CodexOptions, useConfigStore } from '../stores/configStore'
import { CodexFormFields } from './SessionDialog/CodexFormFields'
import { IDENTITY_COLOR_KEYS, resolveIdentityColor, bucketLegacyColorToKey, type IdentityColorKey } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { useRegistryStore } from '../stores/registryStore'
import { useSettingsStore } from '../stores/settingsStore'
import { modelsFromRegistry, effortsFromRegistry, PERMISSION_MODES } from '../lib/claude-cli-options'
import { generateId } from '../utils/id'

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

/** Stronger consequence copy for the two modes that disable safety prompts.
 *  Falls back to the shared PERMISSION_MODES hint for everything else. */
const DANGEROUS_MODE_COPY: Record<string, string> = {
  bypassPermissions: 'Skips every permission prompt, including file writes and shell commands. Only use this in a folder you could throw away.',
  dontAsk: "Accepts everything without asking. Same risk as Bypass for anything inside the working directory.",
}

interface Props {
  onConfirm: (config: Omit<TerminalConfig, 'id'>, password?: string, sudoPassword?: string) => void
  onCancel: () => void
  initial?: Partial<TerminalConfig>
}

export default function SessionDialog({ onConfirm, onCancel, initial }: Props) {
  const groups = useConfigStore((s) => s.groups)
  const addGroup = useConfigStore((s) => s.addGroup)
  const sections = useConfigStore((s) => s.sections)
  const addSection = useConfigStore((s) => s.addSection)
  const registry = useRegistryStore((s) => s.registry)
  const theme = useResolvedTheme()
  const initialClaude = initial?.claudeOptions
  const isEdit = !!initial

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

  // ── Session startup (Claude Code)
  // Edit must not rewrite what's stored: a config saved with no model override
  // reopens as "Default", not the new-config 'opus' default (the old dialog
  // silently upgraded Default → opus on every save; same family as the
  // effortLevel wipe).
  const [model, setModel] = useState(initial ? (initialClaude?.model ?? initial?.model ?? '') : 'opus')
  const [effortLevel, setEffortLevel] = useState(initialClaude?.effortLevel ?? '')
  const [permissionMode, setPermissionMode] = useState(initialClaude?.permissionMode ?? 'default')
  const [extraArgs, setExtraArgs] = useState(initialClaude?.extraArgs ?? '')
  const [loggingEnabled, setLoggingEnabled] = useState(initialClaude?.loggingEnabled !== false)

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
        openHelp.has(k) ? 'border-blue text-blue bg-blue/10' : 'border-surface2 text-overlay0 hover:text-subtext0 hover:border-overlay0'
      }`}
    >
      ?
    </button>
  )
  const Hint = ({ k, children }: { k: string; children: React.ReactNode }) =>
    openHelp.has(k) ? <p className="text-[11px] text-overlay0 mt-1 leading-snug">{children}</p> : null

  const bothChosen = uiProvider !== null && sessionType !== null

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

  // A working directory must be ABSOLUTE. Rejecting '.', './x', '../x' and bare
  // relative paths closes the transcript-misfiling incident at the source (the
  // old '.' fallback), which client validation only half-fixed: an empty field
  // was blocked but '.' still saved (adversarial review, #188). Accepts a
  // Windows drive path, a UNC path, a POSIX absolute path, or a ~ home path.
  const looksAbsolute = (p: string) => /^([a-zA-Z]:[\\/]|\\\\|\/|~)/.test(p.trim())

  // The footer's validation slot: names the next step in a fixed order instead
  // of letting Save silently no-op (the old dialog's worst habit).
  const validationMsg = (() => {
    if (!uiProvider) return 'Choose what this launcher runs'
    if (!sessionType) return 'Choose where it runs'
    // A hand-edited or migrated config can carry the Codex×SSH combination the
    // cards forbid; the disabled cards don't constrain saved state, so guard it
    // here or the config saves and then hard-throws at spawn.
    if (uiProvider === 'codex' && sessionType === 'ssh') return "Codex can't run over SSH — pick Claude Code or Terminal only"
    if (sessionType === 'local' && !workingDir.trim()) return 'Add a working directory to save'
    if (sessionType === 'local' && !looksAbsolute(workingDir)) return 'Working directory must be a full path (e.g. C:\\projects\\app)'
    if (sessionType === 'ssh' && !sshHost.trim()) return 'Add a host to save'
    if (!label.trim()) return 'Add a label to save'
    return ''
  })()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (validationMsg || !uiProvider || !sessionType) return

    const provider: ProviderId = uiProvider === 'codex' ? 'codex' : 'claude'
    const shellOnly = uiProvider === 'terminal'

    // No '.' fallback: the empty-directory default is how the transcript
    // misfiling incident happened; validation above requires a real path.
    const dir = sessionType === 'ssh' ? (sshRemotePath.trim() || '~') : workingDir.trim()

    // Spread-then-set preserves stored fields this dialog no longer edits
    // (legacyVersion, agentIds, disableAutoMemory, enableCodexReview) instead
    // of wiping them on every save — the bug that ate effortLevel for years.
    const claudeOptions = uiProvider === 'claude' ? {
      ...initialClaude,
      model: model || undefined,
      effortLevel: effortLevel === '' ? undefined : effortLevel,
      // 'default' is the no-op sentinel; persist only a real override.
      permissionMode: permissionMode && permissionMode !== 'default' ? permissionMode : undefined,
      extraArgs: extraArgs.trim() || undefined,
      // DEFAULT-TRUE: only write false when the user has turned the toggle off.
      loggingEnabled: !loggingEnabled ? false : undefined,
    } : initial?.claudeOptions

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
    const isSsh = sessionType === 'ssh'
    const passwordSaved = isSsh && savePassword && (sshPassword.length > 0 || storedPassword)
    const sudoSaved = isSsh && postCommand.trim().length > 0 && saveSudo && (sudoPassword.length > 0 || storedSudo)

    const config: Omit<TerminalConfig, 'id'> = {
      provider,
      label: label.trim(),
      workingDirectory: dir,
      identityColorKey: colorKey,
      color: resolveIdentityColor(colorKey, 'dark'),  // back-compat shadow; render prefers the key
      sessionType,
      shellOnly,
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
      } : undefined,
      claudeOptions,
      codexOptions,
      machineName: sessionType === 'ssh' && machineName.trim() ? machineName.trim() : undefined,
      // Account is no longer a config field -- it's chosen at launch by the
      // pre-spawn account gate. Preserve any pre-existing value on edit so older
      // configs aren't silently rewritten, but never set it from this dialog.
      profileId: initial?.profileId,
      // Partner terminal is permanent for every config type (2 Aug decision):
      // the dialog no longer writes a path or elevation. Stored values on old
      // configs are simply ignored by the app.
    }

    // "Remove stored password" clicked (edit mode only): clear the keychain
    // entry the moment the change is confirmed, never before.
    if (initial?.id) {
      if (!passwordSaved && (initial?.sshConfig?.hasPassword ?? false)) {
        void window.electronAPI.credentials.delete(initial.id)
      }
      if (!sudoSaved && (initial?.sshConfig?.hasSudoPassword ?? false)) {
        void window.electronAPI.credentials.delete(initial.id + '_sudo')
      }
    }

    onConfirm(
      config,
      // Honest save, gated on the final sessionType: a typed password reaches the
      // keychain ONLY when this is still an SSH config AND the checkbox is on. The
      // old dialog stored it regardless — so a password typed into an SSH block
      // that was then switched to Local was persisted for a config with no SSH.
      passwordSaved && sshPassword.length > 0 ? sshPassword : undefined,
      sudoSaved && sudoPassword.length > 0 ? sudoPassword : undefined
    )
  }

  // ── Small shared bits
  const sectionHead = (title: string, chip: string, helpKey?: string, helpLabel?: string) => (
    <div className="flex items-center gap-2 border-t border-surface1 pt-3 mt-4 mb-2">
      <span className="text-[10px] uppercase tracking-wider text-overlay1 font-medium">{title}</span>
      <span className="text-[9px] uppercase tracking-wide text-overlay0 border border-surface2 rounded-full px-1.5 py-px">{chip}</span>
      {helpKey && helpLabel && <HelpBtn k={helpKey} label={helpLabel} />}
    </div>
  )

  const providerCard = (id: UiProvider, title: string, sub: string, disabled: boolean) => (
    <button
      type="button"
      role="radio"
      aria-checked={uiProvider === id}
      disabled={disabled}
      onClick={() => setUiProvider(id)}
      className={`flex-1 text-left rounded-md border px-3 py-2 transition-colors ${
        disabled
          ? 'border-surface1 opacity-50 cursor-not-allowed'
          : uiProvider === id
            ? 'border-blue bg-blue/10'
            : 'border-surface1 bg-base hover:border-overlay0'
      }`}
    >
      <span className={`block text-sm font-medium ${disabled ? 'text-overlay0' : 'text-text'}`}>{title}</span>
      <span className="block text-[10px] text-overlay0 mt-0.5">{sub}</span>
    </button>
  )

  const transportCard = (id: SessionType, title: string, sub: string, disabled: boolean) => (
    <button
      type="button"
      role="radio"
      aria-checked={sessionType === id}
      disabled={disabled}
      onClick={() => setSessionType(id)}
      className={`flex-1 text-left rounded-md border px-3 py-2 transition-colors ${
        disabled
          ? 'border-surface1 opacity-50 cursor-not-allowed'
          : sessionType === id
            ? 'border-blue bg-blue/10'
            : 'border-surface1 bg-base hover:border-overlay0'
      }`}
    >
      <span className={`block text-sm font-medium ${disabled ? 'text-overlay0' : 'text-text'}`}>{title}</span>
      <span className="block text-[10px] text-overlay0 mt-0.5">{sub}</span>
    </button>
  )

  const inputCls = 'w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue'

  const permHint = DANGEROUS_MODE_COPY[permissionMode]
    ?? PERMISSION_MODES.find((m) => m.value === permissionMode)?.hint
    ?? ''
  const permDangerous = permissionMode in DANGEROUS_MODE_COPY

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <form
        onSubmit={handleSubmit}
        className="bg-surface0 rounded-lg w-[680px] max-h-[90vh] flex flex-col shadow-2xl border border-surface1"
      >
        <div className="px-6 pt-5 pb-3 border-b border-surface1">
          <h3 className="text-base font-semibold text-text mb-1">
            {isEdit ? 'Edit config' : 'New saved config'}
          </h3>
          <p className="text-[11px] text-overlay0 leading-snug">
            Every click on this launcher starts a fresh session with these settings.
          </p>
        </div>

        <div className="px-6 pb-4 overflow-y-auto flex-1">

          {/* ── 1 · WHAT THIS LAUNCHER RUNS ── */}
          <div className="flex items-center gap-2 pt-4 mb-2">
            <span className="text-[10px] uppercase tracking-wider text-overlay1 font-medium">What this launcher runs</span>
            <span className="text-[9px] uppercase tracking-wide text-overlay0 border border-surface2 rounded-full px-1.5 py-px">Any provider</span>
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
            <p className="text-[11px] text-red mt-1.5">Codex can't run over SSH yet — choose Claude Code or Terminal only.</p>
          )}
          {codexDisabled && sessionType !== 'ssh' && (
            <p className="text-[11px] text-overlay0 mt-1.5">Codex is off — enable it in Settings → Codex to use it here.</p>
          )}
          {uiProvider !== null && (
            <>
              <div className="flex gap-2 mt-2" role="radiogroup" aria-label="Where it runs">
                {transportCard('local', 'Local', 'Runs on this PC', false)}
                {transportCard('ssh', 'SSH', 'Runs on another machine', uiProvider === 'codex')}
              </div>
              {uiProvider === 'codex' && (
                <p className="text-[11px] text-overlay0 mt-1.5">Codex runs on this PC only — SSH isn't available.</p>
              )}
            </>
          )}

          {bothChosen && (
            <>
              {/* ── 2 · WORKSPACE ── */}
              {sectionHead('Workspace', 'Any provider', 'ws', 'About the workspace')}
              <Hint k="ws">
                {sessionType === 'local'
                  ? 'The folder every session starts in. The agent can read and edit files here, with your approval. Every session also gets a second plain terminal from the command bar — no setup needed.'
                  : "Where sessions land after connecting. Your PC's folders are not visible to this session."}
              </Hint>

              {sessionType === 'local' ? (
                <div className="mt-1">
                  <label className="block text-xs text-subtext0 mb-1">Working directory <span className="text-peach">*</span></label>
                  <div className="flex gap-2">
                    <input
                      value={workingDir}
                      onChange={(e) => setWorkingDir(e.target.value)}
                      placeholder={window.electronPlatform === 'win32' ? 'C:\\path\\to\\project' : '~/path/to/project'}
                      className={inputCls.replace('w-full', 'flex-1')}
                    />
                    <button
                      type="button"
                      onClick={handleBrowse}
                      className="px-3 py-2 rounded text-sm bg-surface1 text-subtext1 hover:bg-surface2 hover:text-text transition-colors shrink-0"
                    >
                      Browse
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 mt-1">
                  <div className="grid grid-cols-[1fr_90px] gap-2">
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <label className="text-xs text-subtext0">Host <span className="text-peach">*</span></label>
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
                      <label className="block text-xs text-subtext0 mb-1">Port <span className="text-peach">*</span></label>
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
                      <label className="block text-xs text-subtext0 mb-1">User</label>
                      <input
                        value={sshUser}
                        onChange={(e) => setSshUser(e.target.value)}
                        placeholder="root"
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-subtext0 mb-1">Password</label>
                      <input
                        type="password"
                        value={sshPassword}
                        onChange={(e) => setSshPassword(e.target.value)}
                        placeholder={storedPassword ? '(saved — enter new to change)' : 'Leave empty if you use an SSH key'}
                        className={inputCls}
                      />
                      {(sshPassword.length > 0 || storedPassword) && (
                        <div className="flex items-center gap-3 mt-1.5">
                          <label className="flex items-center gap-2 text-xs text-subtext0 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={savePassword}
                              onChange={(e) => setSavePassword(e.target.checked)}
                              className="rounded border-surface1"
                            />
                            Save password
                          </label>
                          {storedPassword && (
                            <button
                              type="button"
                              onClick={() => { setStoredPassword(false); setSavePassword(false); setSshPassword('') }}
                              className="text-[11px] text-blue underline underline-offset-2"
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
                        <label className="text-xs text-subtext0">Remote directory</label>
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
                        <label className="text-xs text-subtext0">Machine name</label>
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
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <label className="text-xs text-subtext0">After connecting, run</label>
                      <HelpBtn k="postcmd" label="About the post-connect command" />
                    </div>
                    <input
                      value={postCommand}
                      onChange={(e) => setPostCommand(e.target.value)}
                      placeholder="sudo docker exec -it container bash"
                      className={inputCls + ' font-mono text-xs'}
                    />
                    <Hint k="postcmd">
                      Optional. A command to run once the connection is up — for example dropping into a Docker
                      container. CCC gives you a button to run it, then a second button to launch the agent.
                    </Hint>
                  </div>
                  {postCommand.trim() && (
                    <div>
                      <label className="block text-xs text-subtext0 mb-1">Sudo password</label>
                      <input
                        type="password"
                        value={sudoPassword}
                        onChange={(e) => setSudoPassword(e.target.value)}
                        placeholder={storedSudo ? '(saved — enter new to change)' : 'Only needed if the command above uses sudo'}
                        className={inputCls}
                      />
                      {(sudoPassword.length > 0 || storedSudo) && (
                        <div className="flex items-center gap-3 mt-1.5">
                          <label className="flex items-center gap-2 text-xs text-subtext0 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={saveSudo}
                              onChange={(e) => setSaveSudo(e.target.checked)}
                              className="rounded border-surface1"
                            />
                            Save password
                          </label>
                          {storedSudo && (
                            <button
                              type="button"
                              onClick={() => { setStoredSudo(false); setSaveSudo(false); setSudoPassword('') }}
                              className="text-[11px] text-blue underline underline-offset-2"
                            >
                              Remove stored password
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
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
                        <label className="text-xs text-subtext0">Starting model</label>
                        <HelpBtn k="model" label="About the starting model" />
                      </div>
                      <select
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className={inputCls}
                      >
                        <option value="">Default — follows your Claude plan</option>
                        {modelsFromRegistry(registry).map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                      <Hint k="model">
                        Which model sessions start on — change it anytime with /model. Names always point at
                        the newest model in each family.
                      </Hint>
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <label className="text-xs text-subtext0">Starting effort</label>
                        <HelpBtn k="effort" label="About the starting effort" />
                      </div>
                      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Starting effort">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={effortLevel === ''}
                          onClick={() => setEffortLevel('')}
                          className={`px-2.5 py-1 rounded-full border text-xs transition-colors ${
                            effortLevel === '' ? 'border-blue bg-blue/10 text-text' : 'border-surface1 bg-base text-subtext0 hover:border-overlay0'
                          }`}
                        >
                          Default
                        </button>
                        {effortsFromRegistry(registry).map((ef) => (
                          <button
                            key={ef.value}
                            type="button"
                            role="radio"
                            aria-checked={effortLevel === ef.value}
                            onClick={() => setEffortLevel(ef.value as typeof effortLevel)}
                            className={`px-2.5 py-1 rounded-full border text-xs transition-colors ${
                              effortLevel === ef.value ? 'border-blue bg-blue/10 text-text' : 'border-surface1 bg-base text-subtext0 hover:border-overlay0'
                            }`}
                          >
                            {ef.label}
                          </button>
                        ))}
                      </div>
                      <Hint k="effort">
                        How hard Claude thinks before answering — change it anytime with /effort. Higher is
                        slower and uses more of your quota.
                      </Hint>
                    </div>
                    <div>
                      <label className="block text-xs text-subtext0 mb-1">Permission mode</label>
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
                        <p className={`text-[11px] mt-1 ${permDangerous ? 'text-red' : 'text-overlay0'}`}>{permHint}</p>
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <label className="text-xs text-subtext0">Extra CLI arguments</label>
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
                        and CCC's own flags (--model, --effort, --permission-mode, --settings, --mcp-config,
                        --agents, --resume) can't be overridden here.
                      </Hint>
                    </div>
                    {sessionType === 'local' && (
                      <div>
                        <div className="flex items-center gap-1.5">
                          <label className="flex items-center gap-2 text-sm text-subtext0 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={loggingEnabled}
                              onChange={(e) => setLoggingEnabled(e.target.checked)}
                              className="rounded border-surface1"
                            />
                            Index conversation logs
                          </label>
                          <HelpBtn k="logs" label="About conversation logs" />
                        </div>
                        <Hint k="logs">
                          Lets you browse this session's transcript inside CCC. Your conversation is always
                          saved by Claude Code either way (~/.claude/projects) — this only controls whether
                          CCC indexes it.
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

              {uiProvider === 'terminal' && sessionType === 'ssh' && (
                <>
                  {sectionHead('Terminal startup', 'Terminal only')}
                  <p className="text-[11px] text-overlay0 leading-snug">
                    Over SSH, set the startup command in Workspace above — <span className="text-subtext0 font-medium">"After connecting, run"</span>.
                  </p>
                </>
              )}

              {/* ── 4 · ORGANISE (collapsed until needed) ── */}
              <details className="border-t border-surface1 pt-3 mt-4" open={isEdit && (!!groupId || !!sectionId)}>
                <summary className="flex items-center gap-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                  <span className="text-[10px] uppercase tracking-wider text-overlay1 font-medium">Organise</span>
                  <span className="text-[9px] uppercase tracking-wide text-overlay0 border border-surface2 rounded-full px-1.5 py-px">Optional</span>
                  <span className="text-[10px] text-overlay0 ml-auto">▸</span>
                </summary>
                <p className="text-[11px] text-overlay0 mt-2">Optional — only tidies the sidebar.</p>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <label className="text-xs text-subtext0">Group</label>
                      <HelpBtn k="group" label="About groups" />
                    </div>
                    <select
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
                          className="px-3 py-1.5 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 transition-colors"
                        >
                          Create
                        </button>
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <label className="text-xs text-subtext0">Section</label>
                      <HelpBtn k="section" label="About sections" />
                    </div>
                    <select
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
                          className="px-3 py-1.5 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 transition-colors"
                        >
                          Create
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {groupId && (
                  <p className="text-[11px] text-yellow mt-2">Grouped configs can't also sit under a section — clear the group to pick one.</p>
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
                  <label className="block text-xs text-subtext0 mb-1">Label <span className="text-peach">*</span></label>
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. App Dev"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-xs text-subtext0 mb-1">Colour</label>
                  <div className="flex flex-wrap gap-1.5">
                    {IDENTITY_SWATCHES.map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setColorKey(k)}
                        className={`w-6 h-6 rounded-md border-2 transition-all ${
                          colorKey === k ? 'border-text scale-110' : 'border-transparent hover:border-overlay0'
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
        <div className="flex items-center gap-2 px-6 py-3 border-t border-surface1 bg-base/40">
          <span className="text-xs text-yellow mr-auto">{validationMsg}</span>
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 rounded text-sm text-subtext0 hover:text-text hover:bg-surface1 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!!validationMsg}
            className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
              validationMsg ? 'bg-surface1 text-overlay0 cursor-not-allowed' : 'bg-blue text-crust hover:bg-blue/90'
            }`}
          >
            {isEdit ? 'Save changes' : 'Create config'}
          </button>
        </div>
      </form>
    </div>
  )
}
