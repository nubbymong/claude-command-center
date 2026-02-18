import React, { useState, useEffect } from 'react'
import { TerminalConfig, ConfigGroup, ConfigSection, useConfigStore } from '../stores/configStore'

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
  const [label, setLabel] = useState(initial?.label ?? '')
  const [workingDir, setWorkingDir] = useState(initial?.workingDirectory ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
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
  const [startClaudeAfter, setStartClaudeAfter] = useState(initial?.sshConfig?.startClaudeAfter ?? false)
  const [dockerContainer, setDockerContainer] = useState(initial?.sshConfig?.dockerContainer ?? '')

  // Legacy version fields
  const [legacyEnabled, setLegacyEnabled] = useState(initial?.legacyVersion?.enabled ?? false)
  const [legacyVersion, setLegacyVersion] = useState(initial?.legacyVersion?.version ?? '')
  const [availableVersions, setAvailableVersions] = useState<string[]>([])
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [versionInstalled, setVersionInstalled] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState('')

  // Vision fields
  const [visionEnabled, setVisionEnabled] = useState(initial?.visionConfig?.enabled ?? false)
  const [visionBrowser, setVisionBrowser] = useState<'chrome' | 'edge'>(initial?.visionConfig?.browser ?? 'chrome')
  const [visionDebugPort, setVisionDebugPort] = useState(initial?.visionConfig?.debugPort ?? 9222)
  const [visionUrl, setVisionUrl] = useState(initial?.visionConfig?.url ?? '')

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

    const config: Omit<TerminalConfig, 'id'> = {
      label: label.trim(),
      workingDirectory: dir,
      model,
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
        startClaudeAfter: postCommand.trim() ? startClaudeAfter : undefined,
        dockerContainer: dockerContainer.trim() || undefined
      } : undefined,
      visionConfig: visionEnabled ? {
        enabled: true,
        browser: visionBrowser,
        debugPort: visionDebugPort,
        url: visionUrl.trim() || undefined
      } : undefined,
      legacyVersion: legacyEnabled && legacyVersion ? {
        enabled: true,
        version: legacyVersion
      } : undefined
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
        className="bg-surface0 rounded-lg p-6 w-[440px] shadow-2xl border border-surface1"
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

        <div className="space-y-3">
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

          {/* Color picker */}
          <div>
            <label className="block text-xs text-subtext0 mb-1">Color</label>
            <div className="flex flex-wrap gap-2">
              {COLOR_SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-md border-2 transition-all ${
                    color === c ? 'border-text scale-110' : 'border-transparent hover:border-overlay0'
                  }`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
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

          {/* Partner Terminal — available for both local and SSH sessions (partner is always a local shell) */}
          {!shellOnly && (
            <div>
              <label className="flex items-center gap-2 text-sm text-subtext0 cursor-pointer mb-1.5">
                <input
                  type="checkbox"
                  checked={!!partnerTerminalPath}
                  onChange={(e) => setPartnerTerminalPath(e.target.checked ? (workingDir || '.') : '')}
                  className="rounded border-surface1"
                />
                Partner Terminal (optional shell alongside Claude)
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
                    Run as Administrator (requires gsudo)
                  </label>
                </>
              )}
            </div>
          )}

          {sessionType === 'local' ? (
            <div>
              <label className="block text-xs text-subtext0 mb-1">Working Directory</label>
              <div className="flex gap-2">
                <input
                  value={workingDir}
                  onChange={(e) => setWorkingDir(e.target.value)}
                  placeholder="C:\path\to\project"
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
                <label className="flex items-center gap-2 text-xs text-subtext0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={startClaudeAfter}
                    onChange={(e) => setStartClaudeAfter(e.target.checked)}
                    className="rounded border-surface1"
                  />
                  Start Claude after post-command completes
                </label>
              )}
              <div className="pt-2 border-t border-surface0">
                <label className="block text-xs text-subtext0 mb-1">
                  Docker Container
                  <span className="text-overlay0 ml-1">(for screenshot paste support)</span>
                </label>
                <input
                  value={dockerContainer}
                  onChange={(e) => setDockerContainer(e.target.value)}
                  placeholder="my-container"
                  className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue font-mono"
                />
                <p className="text-[10px] text-overlay0 mt-1">
                  If set, pasted images will be copied into this container via docker cp
                </p>
              </div>
            </>
          )}

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

          {/* Legacy Claude Version */}
          <div className="pt-2 border-t border-surface0">
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

          {/* Vision — browser control */}
          <div className="pt-2 border-t border-surface0">
            <label className="flex items-center gap-2 text-sm text-subtext0 cursor-pointer">
              <input
                type="checkbox"
                checked={visionEnabled}
                onChange={(e) => setVisionEnabled(e.target.checked)}
                className="rounded border-surface1"
              />
              Vision (browser control)
            </label>
            {visionEnabled && (
              <div className="ml-5 mt-2 space-y-2">
                <div>
                  <label className="block text-xs text-subtext0 mb-1">URL to open</label>
                  <input
                    type="text"
                    value={visionUrl}
                    onChange={(e) => setVisionUrl(e.target.value)}
                    placeholder="http://localhost:3000"
                    className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-subtext0 mb-1">Browser</label>
                    <select
                      value={visionBrowser}
                      onChange={(e) => setVisionBrowser(e.target.value as 'chrome' | 'edge')}
                      className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
                    >
                      <option value="chrome">Chrome</option>
                      <option value="edge">Edge</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-subtext0 mb-1">CDP Port</label>
                    <input
                      type="number"
                      value={visionDebugPort}
                      onChange={(e) => setVisionDebugPort(parseInt(e.target.value) || 9222)}
                      className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-overlay0">
                  {sessionType === 'ssh'
                    ? 'Browser launches locally. Vision proxy is network-accessible for remote sessions.'
                    : 'Claude can navigate, click, type, and verify UI in the browser. CDP Port is for Chrome DevTools Protocol (usually 9222).'}
                </p>
              </div>
            )}
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

          {/* Section assignment (only when ungrouped — group's section takes priority) */}
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
