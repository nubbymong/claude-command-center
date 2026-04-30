import React, { useState, useEffect } from 'react'
import { TerminalConfig, ConfigGroup, ConfigSection, ProviderId, CodexOptions, useConfigStore } from '../stores/configStore'
import { useAgentLibraryStore, BUILTIN_TEMPLATES } from '../stores/agentLibraryStore'
import { ProviderSegmentedControl } from './SessionDialog/ProviderSegmentedControl'
import { CodexFormFields } from './SessionDialog/CodexFormFields'

export type SessionType = 'local' | 'ssh'

export interface SSHConfig {
  host: string
  port: number
  username: string
  remotePath: string
}

// Neon / Claude UX style color palette
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
  // Read legacy + claudeOptions fields with claudeOptions taking precedence (P1.4 migration)
  const initialClaude = initial?.claudeOptions
  const [provider, setProvider] = useState<ProviderId>(initial?.provider ?? 'claude')
  const [codexModel, setCodexModel] = useState(initial?.codexOptions?.model ?? 'gpt-5.5')
  const [codexEffort, setCodexEffort] = useState<NonNullable<CodexOptions['reasoningEffort']>>(initial?.codexOptions?.reasoningEffort ?? 'medium')
  const [codexPreset, setCodexPreset] = useState<CodexOptions['permissionsPreset']>(initial?.codexOptions?.permissionsPreset ?? 'standard')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [workingDir, setWorkingDir] = useState(initial?.workingDirectory ?? '')
  const [model, setModel] = useState(initialClaude?.model ?? initial?.model ?? '')
  const [color, setColor] = useState(initial?.color ?? COLOR_SWATCHES[0])
  const [sessionType, setSessionType] = useState<SessionType>(initial?.sessionType ?? 'local')
  const [shellOnly, setShellOnly] = useState(initial?.shellOnly ?? false)
  const [groupId, setGroupId] = useState<string | undefined>(initial?.groupId)
  const [newGroupName, setNewGroupName] = useState('')
  const [showNewGroup, setShowNewGroup] = useState(false)
  const [sectionId, setSectionId] = useState<string | undefined>(initial?.sectionId)
  const [newSectionName, setNewSectionName] = useState('')
  const [showNewSection, setShowNewSection] = useState(false)
  const [partnerTerminalPath, setPartnerTerminalPath] = useState(initial?.partnerTerminalPath ?? '')
  const [partnerElevated, setPartnerElevated] = useState(initial?.partnerElevated ?? false)

  // SSH fields
  const [sshHost, setSshHost] = useState(initial?.sshConfig?.host ?? '')
  const [sshPort, setSshPort] = useState(initial?.sshConfig?.port ?? 22)
  const [sshUser, setSshUser] = useState(initial?.sshConfig?.username ?? '')
  const [sshRemotePath, setSshRemotePath] = useState(initial?.sshConfig?.remotePath ?? '~')
  const [sshPassword, setSshPassword] = useState('')
  const [savePassword, setSavePassword] = useState(initial?.sshConfig?.hasPassword ?? false)
  const [postCommand, setPostCommand] = useState(initial?.sshConfig?.postCommand ?? '')
  const [sudoPassword, setSudoPassword] = useState('')
  const [saveSudoPassword, setSaveSudoPassword] = useState(initial?.sshConfig?.hasSudoPassword ?? false)

  // Legacy version fields
  const [legacyEnabled, setLegacyEnabled] = useState((initialClaude?.legacyVersion ?? initial?.legacyVersion)?.enabled ?? false)
  const [legacyVersion, setLegacyVersion] = useState((initialClaude?.legacyVersion ?? initial?.legacyVersion)?.version ?? '')
  const [availableVersions, setAvailableVersions] = useState<string[]>([])
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [versionInstalled, setVersionInstalled] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState('')

  // Agent fields
  const agentUserTemplates = useAgentLibraryStore(s => s.templates)
  const allAgentTemplates = [...agentUserTemplates, ...BUILTIN_TEMPLATES]
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set(initialClaude?.agentIds ?? initial?.agentIds ?? []))
  const [effortLevel, setEffortLevel] = useState<string>(initialClaude?.effortLevel ?? initial?.effortLevel ?? '')
  const [disableAutoMemory, setDisableAutoMemory] = useState(initialClaude?.disableAutoMemory ?? initial?.disableAutoMemory ?? false)
  const [machineName, setMachineName] = useState(initial?.machineName ?? '')

  // Fetch available versions when legacy checkbox enabled
  useEffect(() => {
    if (!legacyEnabled) return
    let cancelled = false
    setLoadingVersions(true)
    window.electronAPI.legacyVersion.fetchVersions()
      .then((versions) => {
        if (cancelled) return
        setAvailableVersions(versions)
        if (!legacyVersion && versions.length > 0) {
          setLegacyVersion(versions[0])
        }
      })
      .catch(() => {
        if (!cancelled) setAvailableVersions([])
      })
      .finally(() => {
        if (!cancelled) setLoadingVersions(false)
      })
    return () => { cancelled = true }
  }, [legacyEnabled])

  // Check install status when version changes
  useEffect(() => {
    if (!legacyEnabled || !legacyVersion) {
      setVersionInstalled(false)
      return
    }
    window.electronAPI.legacyVersion.isInstalled(legacyVersion)
      .then(setVersionInstalled)
      .catch(() => setVersionInstalled(false))
  }, [legacyEnabled, legacyVersion])

  // Listen for install progress
  useEffect(() => {
    if (!installing) return
    const unsub = window.electronAPI.legacyVersion.onInstallProgress((data) => {
      // Progress is displayed via the installing state; we just need to know when done
    })
    return unsub
  }, [installing])

  // Codex is not yet available over SSH -- if user flips sessionType to ssh while
  // codex is selected, fall back to claude so the form remains usable.
  useEffect(() => {
    if (sessionType === 'ssh' && provider === 'codex') {
      setProvider('claude')
    }
  }, [sessionType, provider])

  const handleInstallVersion = async () => {
    if (!legacyVersion) return
    setInstalling(true)
    setInstallError('')
    const result = await window.electronAPI.legacyVersion.install(legacyVersion)
    setInstalling(false)
    if (result.ok) {
      setVersionInstalled(true)
    } else {
      setInstallError(result.error || 'Install failed')
    }
  }

  const handleBrowse = async () => {
    const path = await window.electronAPI.dialog.openFolder()
    if (path) setWorkingDir(path)
  }

  const handleBrowsePartner = async () => {
    const path = await window.electronAPI.dialog.openFolder()
    if (path) setPartnerTerminalPath(path)
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
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    addSection({ id, name: newSectionName.trim() })
    setSectionId(id)
    setNewSectionName('')
    setShowNewSection(false)
  }

  const handleCreateGroup = () => {
    if (!newGroupName.trim()) return
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    addGroup({ id, name: newGroupName.trim() })
    setGroupId(id)
    setNewGroupName('')
    setShowNewGroup(false)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!label.trim()) return
    if (sessionType === 'ssh' && !sshHost.trim()) return

    const sshConfig: SSHConfig | undefined = sessionType === 'ssh' ? {
      host: sshHost.trim(),
      port: sshPort,
      username: sshUser.trim() || 'root',
      remotePath: sshRemotePath.trim() || '~'
    } : undefined

    const dir = sessionType === 'ssh' ? sshRemotePath.trim() || '~' : (workingDir.trim() || '.')

    const claudeOptions = provider === 'claude' ? {
      model: model || undefined,
      legacyVersion: legacyEnabled && legacyVersion ? { enabled: true, version: legacyVersion } : undefined,
      agentIds: !shellOnly && selectedAgentIds.size > 0 ? Array.from(selectedAgentIds) : undefined,
      effortLevel: (!shellOnly && effortLevel ? effortLevel : undefined) as any,
      disableAutoMemory: !shellOnly && disableAutoMemory ? true : undefined,
    } : undefined

    const codexOptions: CodexOptions | undefined = provider === 'codex' ? {
      model: codexModel,
      reasoningEffort: codexEffort,
      permissionsPreset: codexPreset,
    } : undefined

    const config: Omit<TerminalConfig, 'id'> = {
      provider,
      label: label.trim(),
      workingDirectory: dir,
      color,
      sessionType,
      shellOnly,
      groupId,
      sectionId: groupId ? undefined : sectionId,
      partnerTerminalPath: !shellOnly && partnerTerminalPath.trim() ? partnerTerminalPath.trim() : undefined,
      partnerElevated: !shellOnly && partnerTerminalPath.trim() ? partnerElevated : undefined,
      sshConfig: sshConfig ? {
        ...sshConfig,
        hasPassword: savePassword && sshPassword.length > 0,
        postCommand: postCommand.trim() || undefined,
        hasSudoPassword: saveSudoPassword && sudoPassword.length > 0,
      } : undefined,
      claudeOptions,
      codexOptions,
      machineName: machineName.trim() || undefined,
    }

    onConfirm(
      config,
      sshPassword.length > 0 ? sshPassword : undefined,
      sudoPassword.length > 0 ? sudoPassword : undefined
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <form
        onSubmit={handleSubmit}
        className="bg-surface0 rounded-lg p-6 w-[760px] max-h-[90vh] overflow-y-auto shadow-2xl border border-surface1"
      >
        <h3 className="text-base font-semibold text-text mb-4">
          {initial ? 'Edit Config' : 'New Terminal Config'}
        </h3>

        {/* Session type toggle */}
        <div className="flex items-center bg-crust rounded-md p-0.5 mb-4">
          <button
            type="button"
            onClick={() => setSessionType('local')}
            className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              sessionType === 'local' ? 'bg-blue text-crust' : 'text-overlay1 hover:text-text'
            }`}
          >
            Local
          </button>
          <button
            type="button"
            onClick={() => setSessionType('ssh')}
            className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              sessionType === 'ssh' ? 'bg-blue text-crust' : 'text-overlay1 hover:text-text'
            }`}
          >
            SSH
          </button>
        </div>

        {/* Provider segmented control */}
        <ProviderSegmentedControl
          value={provider}
          onChange={setProvider}
          sessionType={sessionType}
        />

        {/* Two-column grid */}
        <div className="grid grid-cols-2 gap-6">

          {/* ============ LEFT COLUMN: Identity + Connection ============ */}
          <div className="space-y-3">

            {/* -- IDENTITY section (first in column, no border-t) -- */}
            <div>
              <span className="text-[10px] uppercase tracking-wider text-overlay1 font-medium">Identity</span>
            </div>

            <div>
              <label className="block text-xs text-subtext0 mb-1">Label</label>
              <input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="My project"
                className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue"
              />
            </div>

            {sessionType === 'ssh' && (
              <div>
                <label className="block text-xs text-subtext0 mb-1">Machine Name</label>
                <input
                  value={machineName}
                  onChange={(e) => setMachineName(e.target.value)}
                  placeholder="e.g. GPU Server, Build Box"
                  className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue"
                />
              </div>
            )}

            {/* Color picker — compact swatches */}
            <div>
              <label className="block text-xs text-subtext0 mb-1">Color</label>
              <div className="flex flex-wrap gap-1.5">
                {COLOR_SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={`w-6 h-6 rounded-md border-2 transition-all ${
                      color === c ? 'border-text scale-110' : 'border-transparent hover:border-overlay0'
                    }`}
                    style={{ backgroundColor: c }}
                    title={c}
                  />
                ))}
              </div>
            </div>

            {/* -- CONNECTION section -- */}
            <div className="border-t border-surface1 pt-3 mt-3">
              <span className="text-[10px] uppercase tracking-wider text-overlay1 font-medium">Connection</span>
            </div>

            {sessionType === 'local' ? (
              <div>
                <label className="block text-xs text-subtext0 mb-1">Working Directory</label>
                <div className="flex gap-2">
                  <input
                    value={workingDir}
                    onChange={(e) => setWorkingDir(e.target.value)}
                    placeholder={window.electronPlatform === 'win32' ? 'C:\\path\\to\\project' : '~/path/to/project'}
                    className="flex-1 bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue"
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
              <>
                <div className="grid grid-cols-[1fr_80px] gap-2">
                  <div>
                    <label className="block text-xs text-subtext0 mb-1">Host</label>
                    <input
                      value={sshHost}
                      onChange={(e) => setSshHost(e.target.value)}
                      placeholder="192.168.1.100 or hostname"
                      className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-subtext0 mb-1">Port</label>
                    <input
                      type="number"
                      value={sshPort}
                      onChange={(e) => setSshPort(parseInt(e.target.value) || 22)}
                      className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-subtext0 mb-1">Username</label>
                  <input
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    placeholder="root"
                    className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue"
                  />
                </div>
                <div>
                  <label className="block text-xs text-subtext0 mb-1">
                    Password
                    <span className="text-overlay0 ml-1">(encrypted with OS keychain)</span>
                  </label>
                  <input
                    type="password"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    placeholder={initial?.sshConfig?.hasPassword ? '(saved - enter new to change)' : 'Leave empty for key auth'}
                    className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue"
                  />
                  {sshPassword.length > 0 && (
                    <label className="flex items-center gap-2 mt-1.5 text-xs text-subtext0 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={savePassword}
                        onChange={(e) => setSavePassword(e.target.checked)}
                        className="rounded border-surface1"
                      />
                      Save password for this config
                    </label>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-subtext0 mb-1">Remote Path (cd after connect)</label>
                  <input
                    value={sshRemotePath}
                    onChange={(e) => setSshRemotePath(e.target.value)}
                    placeholder="~/projects/my-app"
                    className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue"
                  />
                </div>
                <div>
                  <label className="block text-xs text-subtext0 mb-1">
                    Post-connect Command
                    <span className="text-overlay0 ml-1">(runs after SSH connects)</span>
                  </label>
                  <input
                    value={postCommand}
                    onChange={(e) => setPostCommand(e.target.value)}
                    placeholder="sudo docker exec -it container bash"
                    className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue font-mono text-xs"
                  />
                </div>
                {postCommand && (
                  <div>
                    <label className="block text-xs text-subtext0 mb-1">
                      Sudo Password
                      <span className="text-overlay0 ml-1">(auto-entered if prompted)</span>
                    </label>
                    <input
                      type="password"
                      value={sudoPassword}
                      onChange={(e) => setSudoPassword(e.target.value)}
                      placeholder={initial?.sshConfig?.hasSudoPassword ? '(saved - enter new to change)' : 'Leave empty if not needed'}
                      className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue"
                    />
                    {sudoPassword.length > 0 && (
                      <label className="flex items-center gap-2 mt-1.5 text-xs text-subtext0 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={saveSudoPassword}
                          onChange={(e) => setSaveSudoPassword(e.target.checked)}
                          className="rounded border-surface1"
                        />
                        Save sudo password for this config
                      </label>
                    )}
                  </div>
                )}
                {postCommand && (
                  <p className="text-[10px] text-overlay0 leading-snug">
                    After connect you'll get an in-pane button to run this
                    command. Once the inner shell appears, a second button
                    launches Claude (or Skip drops you to the shell).
                  </p>
                )}
              </>
            )}
          </div>

          {/* ============ RIGHT COLUMN: Options + Extensions + Agents + Organization ============ */}
          <div className="space-y-3">

            {/* -- SESSION OPTIONS section (first in column, no border-t) -- */}
            <div>
              <span className="text-[10px] uppercase tracking-wider text-overlay1 font-medium">Session Options</span>
            </div>

            {/* Shell only toggle */}
            <label className="flex items-center gap-2 text-sm text-subtext0 cursor-pointer">
              <input
                type="checkbox"
                checked={shellOnly}
                onChange={(e) => {
                  setShellOnly(e.target.checked)
                  if (e.target.checked) setPartnerTerminalPath('')
                }}
                className="rounded border-surface1"
              />
              Shell only (don't run Claude)
            </label>

            {/* Partner Terminal */}
            {!shellOnly && (
              <div>
                <label className="flex items-center gap-2 text-sm text-subtext0 cursor-pointer mb-1.5">
                  <input
                    type="checkbox"
                    checked={!!partnerTerminalPath}
                    onChange={(e) => setPartnerTerminalPath(e.target.checked ? (workingDir || '.') : '')}
                    className="rounded border-surface1"
                  />
                  Partner Terminal
                </label>
                {partnerTerminalPath && (
                  <>
                    <div className="flex gap-2 ml-5">
                      <input
                        value={partnerTerminalPath}
                        onChange={(e) => setPartnerTerminalPath(e.target.value)}
                        placeholder="Partner terminal path"
                        className="flex-1 bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue"
                      />
                      <button
                        type="button"
                        onClick={handleBrowsePartner}
                        className="px-3 py-2 rounded text-sm bg-surface1 text-subtext1 hover:bg-surface2 hover:text-text transition-colors shrink-0"
                      >
                        Browse
                      </button>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-subtext0 cursor-pointer ml-5">
                      <input
                        type="checkbox"
                        checked={partnerElevated}
                        onChange={(e) => setPartnerElevated(e.target.checked)}
                        className="rounded border-surface1"
                      />
                      {`Run as Administrator (requires ${window.electronPlatform === 'win32' ? 'gsudo' : 'sudo'})`}
                    </label>
                  </>
                )}
              </div>
            )}

            {provider === 'claude' && (
            <>
            {/* Model override */}
            <div>
              <label className="block text-xs text-subtext0 mb-1">
                Model override
                <span className="text-overlay0 ml-1">(uses your subscription plan)</span>
              </label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
              >
                <option value="">Default (no override)</option>
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
                <option value="haiku">Haiku</option>
              </select>
            </div>

            {/* Effort level */}
            {!shellOnly && (
              <div>
                <label className="block text-xs text-subtext0 mb-1">
                  Effort level
                  <span className="text-overlay0 ml-1">(thinking depth vs cost)</span>
                </label>
                <select
                  value={effortLevel}
                  onChange={(e) => setEffortLevel(e.target.value)}
                  className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
                >
                  <option value="">Auto (default)</option>
                  <option value="low">Low — fast, minimal thinking</option>
                  <option value="medium">Medium — balanced</option>
                  <option value="high">High — deep reasoning</option>
                </select>
              </div>
            )}

            {/* Disable auto-memory toggle */}
            {!shellOnly && (
              <label className="flex items-center gap-2 text-sm text-subtext0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={disableAutoMemory}
                  onChange={(e) => setDisableAutoMemory(e.target.checked)}
                  className="rounded border-surface1"
                />
                Disable auto-memory
                <span className="text-[10px] text-overlay0">(no CLAUDE.md memory writes)</span>
              </label>
            )}

            {/* -- EXTENSIONS section -- */}
            <div className="border-t border-surface1 pt-3 mt-3">
              <span className="text-[10px] uppercase tracking-wider text-overlay1 font-medium">Extensions</span>
            </div>

            {/* Legacy Claude Version */}
            <div>
              <label className="flex items-center gap-2 text-sm text-subtext0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={legacyEnabled}
                  onChange={(e) => {
                    setLegacyEnabled(e.target.checked)
                    if (!e.target.checked) {
                      setInstallError('')
                    }
                  }}
                  className="rounded border-surface1"
                />
                Legacy Claude Version
              </label>
              {legacyEnabled && (
                <div className="ml-5 mt-2 space-y-2">
                  <div>
                    <label className="block text-xs text-subtext0 mb-1">Version</label>
                    {loadingVersions ? (
                      <div className="text-xs text-overlay0">Loading versions from npm...</div>
                    ) : availableVersions.length > 0 ? (
                      <select
                        value={legacyVersion}
                        onChange={(e) => setLegacyVersion(e.target.value)}
                        className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
                      >
                        {availableVersions.map((v) => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="text-xs text-red">Failed to load versions. Is npm installed?</div>
                    )}
                  </div>
                  {legacyVersion && !loadingVersions && (
                    <div className="flex items-center gap-2">
                      {versionInstalled ? (
                        <span className="text-xs text-green">Installed</span>
                      ) : installing ? (
                        <span className="text-xs text-overlay0">Installing...</span>
                      ) : (
                        <button
                          type="button"
                          onClick={handleInstallVersion}
                          className="px-3 py-1 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 transition-colors"
                        >
                          Install
                        </button>
                      )}
                    </div>
                  )}
                  {installError && (
                    <div className="text-xs text-red">{installError}</div>
                  )}
                  <p className="text-[10px] text-overlay0">
                    Install and use a specific version of Claude CLI. ~80MB per version.
                    {!versionInstalled && legacyVersion && ' Will auto-install on first launch if not installed.'}
                  </p>
                </div>
              )}
            </div>

            {/* -- AGENTS section -- */}
            {!shellOnly && allAgentTemplates.length > 0 && (
              <>
                <div className="border-t border-surface1 pt-3 mt-3">
                  <span className="text-[10px] uppercase tracking-wider text-overlay1 font-medium">Agents</span>
                </div>
                <div className="max-h-[120px] overflow-y-auto border border-surface1 rounded bg-base">
                  {allAgentTemplates.map(t => (
                    <label
                      key={t.id}
                      className="flex items-start gap-2 px-2.5 py-1.5 hover:bg-surface0/30 cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={selectedAgentIds.has(t.id)}
                        onChange={() => {
                          setSelectedAgentIds(prev => {
                            const next = new Set(prev)
                            if (next.has(t.id)) next.delete(t.id)
                            else next.add(t.id)
                            return next
                          })
                        }}
                        className="rounded border-surface1 mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-medium text-text font-mono">{t.name}</span>
                        {t.isBuiltIn && <span className="text-[9px] text-overlay0 ml-1">(built-in)</span>}
                        <div className="text-[10px] text-overlay1 truncate">{t.description}</div>
                      </div>
                    </label>
                  ))}
                </div>
                <p className="text-[10px] text-overlay0 mt-1.5 leading-snug">
                  Author your own templates in <span className="text-subtext0 font-medium">Agent Hub → Library</span>. Anything you create there appears here automatically.
                </p>
              </>
            )}
            </>
            )}

            {provider === 'codex' && (
              <CodexFormFields
                value={{ model: codexModel, reasoningEffort: codexEffort, permissionsPreset: codexPreset }}
                // Spread-then-set: dropdowns + radios always emit defined values, so we can safely
                // guard each setter on `!== undefined`. Add explicit-clear logic if future nullable fields land.
                onChange={(next) => {
                  if (next.model !== undefined) setCodexModel(next.model)
                  if (next.reasoningEffort !== undefined) setCodexEffort(next.reasoningEffort)
                  if (next.permissionsPreset !== undefined) setCodexPreset(next.permissionsPreset)
                }}
                onOpenSettings={() => {
                  // Best-effort: ask the host to navigate Settings to the Codex tab.
                  // For v1.5.0 we simply open Settings; the user can click the Codex tab.
                  // P3+ may add a deep-link channel.
                  window.dispatchEvent(new CustomEvent('app:openSettings', { detail: { tab: 'codex' } }))
                }}
              />
            )}

            {/* -- ORGANIZATION section -- */}
            <div className="border-t border-surface1 pt-3 mt-3">
              <span className="text-[10px] uppercase tracking-wider text-overlay1 font-medium">Organization</span>
            </div>

            {/* Group assignment */}
            <div>
              <label className="block text-xs text-subtext0 mb-1">Group</label>
              <select
                value={showNewGroup ? '__new__' : (groupId || '')}
                onChange={(e) => handleGroupChange(e.target.value)}
                className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
              >
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
                <option value="__new__">+ New Group...</option>
              </select>
              {showNewGroup && (
                <div className="flex gap-2 mt-1.5">
                  <input
                    autoFocus
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateGroup() } }}
                    placeholder="Group name"
                    className="flex-1 bg-base border border-surface1 rounded px-3 py-1.5 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue"
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

            {/* Section assignment (only when ungrouped) */}
            {!groupId && (
              <div>
                <label className="block text-xs text-subtext0 mb-1">Section</label>
                <select
                  value={showNewSection ? '__new__' : (sectionId || '')}
                  onChange={(e) => handleSectionChange(e.target.value)}
                  className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
                >
                  <option value="">No section</option>
                  {sections.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                  <option value="__new__">+ New Section...</option>
                </select>
                {showNewSection && (
                  <div className="flex gap-2 mt-1.5">
                    <input
                      autoFocus
                      value={newSectionName}
                      onChange={(e) => setNewSectionName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateSection() } }}
                      placeholder="Section name"
                      className="flex-1 bg-base border border-surface1 rounded px-3 py-1.5 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue"
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
            )}
          </div>

        </div>

        {/* Buttons — full-width below grid */}
        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 rounded text-sm text-subtext0 hover:text-text hover:bg-surface1 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-1.5 rounded text-sm bg-blue text-crust font-medium hover:bg-blue/90 transition-colors"
          >
            {initial ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}
