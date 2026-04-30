import React, { useState, useRef, useEffect } from 'react'
import { TerminalConfig } from '../stores/configStore'
import { COLOR_SWATCHES } from './SessionDialog'

type SessionType = 'local' | 'ssh'
type SectionKey = 'identity' | 'directory' | 'connection' | 'claude' | 'advanced'

interface Props {
  onConfirm: (config: Omit<TerminalConfig, 'id'>, sshPassword?: string) => void
  onSkip: () => void
}

/**
 * First-run guided config experience. Split-view with form on the left
 * and contextual help on the right that reacts to focused field.
 */
export default function GuidedConfigView({ onConfirm, onSkip }: Props) {
  // Form state
  const [label, setLabel] = useState('')
  const [workingDir, setWorkingDir] = useState('')
  const [color, setColor] = useState(COLOR_SWATCHES[0])
  const [sessionType, setSessionType] = useState<SessionType>('local')
  const [sshHost, setSshHost] = useState('')
  const [sshPort, setSshPort] = useState(22)
  const [sshUser, setSshUser] = useState('')
  const [sshRemotePath, setSshRemotePath] = useState('~')
  const [sshPassword, setSshPassword] = useState('')
  const [model, setModel] = useState('')
  const [effortLevel, setEffortLevel] = useState<'low' | 'medium' | 'high' | ''>('')
  const [disableAutoMemory, setDisableAutoMemory] = useState(false)

  const [activeSection, setActiveSection] = useState<SectionKey>('identity')
  const helpPanelRef = useRef<HTMLDivElement>(null)
  const sectionRefs = {
    identity: useRef<HTMLDivElement>(null),
    directory: useRef<HTMLDivElement>(null),
    connection: useRef<HTMLDivElement>(null),
    claude: useRef<HTMLDivElement>(null),
    advanced: useRef<HTMLDivElement>(null),
  }

  const isWindows = window.electronPlatform !== 'darwin'

  // Scroll help panel to active section
  useEffect(() => {
    const ref = sectionRefs[activeSection]
    if (ref.current && helpPanelRef.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [activeSection])

  const handleBrowse = async () => {
    const dir = await window.electronAPI.dialog.openFolder()
    if (dir) setWorkingDir(dir)
  }

  const canSubmit = label.trim() && (sessionType === 'local' || sshHost.trim())

  const handleSubmit = () => {
    if (!canSubmit) return

    const dir = sessionType === 'ssh' ? sshRemotePath.trim() || '~' : (workingDir.trim() || '.')
    const config: Omit<TerminalConfig, 'id'> = {
      provider: 'claude',
      label: label.trim(),
      workingDirectory: dir,
      model,
      color,
      sessionType,
      sshConfig: sessionType === 'ssh' ? {
        host: sshHost.trim(),
        port: sshPort,
        username: sshUser.trim() || 'root',
        remotePath: sshRemotePath.trim() || '~',
        hasPassword: sshPassword.length > 0,
      } : undefined,
      effortLevel: effortLevel || undefined,
      disableAutoMemory: disableAutoMemory || undefined,
    }
    onConfirm(config, sshPassword.length > 0 ? sshPassword : undefined)
  }

  const focusSection = (section: SectionKey) => () => setActiveSection(section)

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-base">
      {/* Header */}
      <div className="px-6 py-4 border-b border-surface0 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text">Create Your First Config</h1>
          <p className="text-xs text-overlay0 mt-0.5">
            A terminal config is a reusable template for launching Claude Code sessions
          </p>
        </div>
        <button
          onClick={onSkip}
          className="text-xs text-overlay0 hover:text-text underline"
        >
          Skip for now
        </button>
      </div>

      {/* Split view */}
      <div className="flex-1 flex overflow-hidden">
        {/* Form (left, 55%) */}
        <div className="w-[55%] overflow-y-auto px-8 py-6 border-r border-surface0">
          <div className="max-w-xl space-y-6">

            {/* Identity */}
            <section className={`transition-opacity ${activeSection === 'identity' ? 'opacity-100' : 'opacity-80'}`}>
              <h3 className="text-xs font-semibold text-overlay1 uppercase tracking-wider mb-3">Identity</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm text-subtext1 mb-1">Name</label>
                  <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    onFocus={focusSection('identity')}
                    placeholder="e.g. My Web App"
                    className="w-full px-3 py-2 bg-surface0 border border-surface1 rounded text-text text-sm focus:outline-none focus:border-mauve"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm text-subtext1 mb-2">Color</label>
                  <div
                    className="flex flex-wrap gap-1.5"
                    onMouseDown={focusSection('identity')}
                  >
                    {COLOR_SWATCHES.slice(0, 16).map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setColor(c)}
                        className={`w-6 h-6 rounded transition-all ${color === c ? 'ring-2 ring-text scale-110' : 'hover:scale-105'}`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {/* Connection */}
            <section className={`transition-opacity ${activeSection === 'connection' ? 'opacity-100' : 'opacity-80'}`}>
              <h3 className="text-xs font-semibold text-overlay1 uppercase tracking-wider mb-3">Connection</h3>
              <div
                className="flex gap-2 mb-3"
                onMouseDown={focusSection('connection')}
              >
                <button
                  type="button"
                  onClick={() => setSessionType('local')}
                  className={`flex-1 px-4 py-2 rounded border text-sm transition-colors ${sessionType === 'local' ? 'bg-mauve/20 border-mauve text-text' : 'bg-surface0 border-surface1 text-subtext0 hover:bg-surface1'}`}
                >
                  Local
                </button>
                <button
                  type="button"
                  onClick={() => setSessionType('ssh')}
                  className={`flex-1 px-4 py-2 rounded border text-sm transition-colors ${sessionType === 'ssh' ? 'bg-mauve/20 border-mauve text-text' : 'bg-surface0 border-surface1 text-subtext0 hover:bg-surface1'}`}
                >
                  SSH (Remote)
                </button>
              </div>

              {sessionType === 'ssh' && (
                <div className="space-y-3 mt-3">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label className="block text-xs text-subtext1 mb-1">Host</label>
                      <input
                        type="text"
                        value={sshHost}
                        onChange={(e) => setSshHost(e.target.value)}
                        onFocus={focusSection('connection')}
                        placeholder="server.example.com"
                        className="w-full px-3 py-1.5 bg-surface0 border border-surface1 rounded text-text text-sm focus:outline-none focus:border-mauve"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-subtext1 mb-1">Port</label>
                      <input
                        type="number"
                        value={sshPort}
                        onChange={(e) => setSshPort(parseInt(e.target.value) || 22)}
                        onFocus={focusSection('connection')}
                        className="w-full px-3 py-1.5 bg-surface0 border border-surface1 rounded text-text text-sm focus:outline-none focus:border-mauve"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-subtext1 mb-1">Username</label>
                    <input
                      type="text"
                      value={sshUser}
                      onChange={(e) => setSshUser(e.target.value)}
                      onFocus={focusSection('connection')}
                      placeholder="ubuntu"
                      className="w-full px-3 py-1.5 bg-surface0 border border-surface1 rounded text-text text-sm focus:outline-none focus:border-mauve"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-subtext1 mb-1">Password (optional, uses key auth if empty)</label>
                    <input
                      type="password"
                      value={sshPassword}
                      onChange={(e) => setSshPassword(e.target.value)}
                      onFocus={focusSection('connection')}
                      className="w-full px-3 py-1.5 bg-surface0 border border-surface1 rounded text-text text-sm focus:outline-none focus:border-mauve"
                    />
                  </div>
                </div>
              )}
            </section>

            {/* Working Directory */}
            <section className={`transition-opacity ${activeSection === 'directory' ? 'opacity-100' : 'opacity-80'}`}>
              <h3 className="text-xs font-semibold text-overlay1 uppercase tracking-wider mb-3">Working Directory</h3>
              {sessionType === 'local' ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={workingDir}
                    onChange={(e) => setWorkingDir(e.target.value)}
                    onFocus={focusSection('directory')}
                    placeholder={isWindows ? 'C:\\Users\\you\\projects\\my-app' : '/Users/you/projects/my-app'}
                    className="flex-1 px-3 py-2 bg-surface0 border border-surface1 rounded text-text text-sm focus:outline-none focus:border-mauve"
                  />
                  <button
                    type="button"
                    onClick={handleBrowse}
                    className="px-4 py-2 bg-surface0 hover:bg-surface1 border border-surface1 text-text text-sm rounded transition-colors"
                  >
                    Browse
                  </button>
                </div>
              ) : (
                <div>
                  <label className="block text-xs text-subtext1 mb-1">Remote Path</label>
                  <input
                    type="text"
                    value={sshRemotePath}
                    onChange={(e) => setSshRemotePath(e.target.value)}
                    onFocus={focusSection('directory')}
                    placeholder="~/projects/my-app"
                    className="w-full px-3 py-2 bg-surface0 border border-surface1 rounded text-text text-sm focus:outline-none focus:border-mauve"
                  />
                </div>
              )}
            </section>

            {/* Claude Options */}
            <section className={`transition-opacity ${activeSection === 'claude' ? 'opacity-100' : 'opacity-80'}`}>
              <h3 className="text-xs font-semibold text-overlay1 uppercase tracking-wider mb-3">Claude Options</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm text-subtext1 mb-1">Model Override</label>
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    onFocus={focusSection('claude')}
                    className="w-full px-3 py-2 bg-surface0 border border-surface1 rounded text-text text-sm focus:outline-none focus:border-mauve"
                  >
                    <option value="">Default (uses subscription plan)</option>
                    <option value="opus">Opus (deep thinking)</option>
                    <option value="sonnet">Sonnet (balanced)</option>
                    <option value="haiku">Haiku (fast, cheap)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-subtext1 mb-1">Effort Level</label>
                  <select
                    value={effortLevel}
                    onChange={(e) => setEffortLevel(e.target.value as any)}
                    onFocus={focusSection('claude')}
                    className="w-full px-3 py-2 bg-surface0 border border-surface1 rounded text-text text-sm focus:outline-none focus:border-mauve"
                  >
                    <option value="">Auto (default)</option>
                    <option value="low">Low — Fast responses, less thinking</option>
                    <option value="medium">Medium — Balanced</option>
                    <option value="high">High — Deep thinking, slower</option>
                  </select>
                </div>
              </div>
            </section>

            {/* Advanced */}
            <section className={`transition-opacity ${activeSection === 'advanced' ? 'opacity-100' : 'opacity-80'}`}>
              <h3 className="text-xs font-semibold text-overlay1 uppercase tracking-wider mb-3">Advanced</h3>
              <div className="space-y-2" onMouseDown={focusSection('advanced')}>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={disableAutoMemory}
                    onChange={(e) => setDisableAutoMemory(e.target.checked)}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-sm text-text">Disable auto-memory</div>
                    <div className="text-xs text-overlay0">Prevents Claude from writing to ~/.claude/memory/</div>
                  </div>
                </label>
              </div>
            </section>
          </div>
        </div>

        {/* Help panel (right, 45%) */}
        <div
          ref={helpPanelRef}
          className="w-[45%] overflow-y-auto px-8 py-6 bg-mantle"
        >
          <div className="max-w-md space-y-6">
            {/* Identity help */}
            <div ref={sectionRefs.identity} className={`transition-opacity ${activeSection === 'identity' ? 'opacity-100' : 'opacity-50'}`}>
              <div className="text-mauve text-xs font-semibold uppercase tracking-wider mb-2">Identity</div>
              <h4 className="text-base font-bold text-text mb-2">Give it a name and color</h4>
              <p className="text-sm text-subtext0 leading-relaxed mb-3">
                The name appears in the tab bar, sidebar, and window title. Use something you'll recognize at a glance — project names work well.
              </p>
              <p className="text-sm text-subtext0 leading-relaxed mb-3">
                Colors appear as dots next to session names. They're useful when you have several configs running at once, or to visually distinguish production from development.
              </p>
              <div className="bg-surface0/50 border border-surface0 rounded p-3 text-xs text-subtext1">
                <strong className="text-blue">💡 Tip:</strong> You can match colors to your brand, or use red/yellow/green for prod/staging/dev.
              </div>
            </div>

            {/* Connection help */}
            <div ref={sectionRefs.connection} className={`transition-opacity ${activeSection === 'connection' ? 'opacity-100' : 'opacity-50'}`}>
              <div className="text-mauve text-xs font-semibold uppercase tracking-wider mb-2">Connection</div>
              <h4 className="text-base font-bold text-text mb-2">Local or remote?</h4>
              <p className="text-sm text-subtext0 leading-relaxed mb-3">
                <strong className="text-text">Local</strong> runs Claude Code on this computer. Use this for projects stored on your machine. This is the most common choice.
              </p>
              <p className="text-sm text-subtext0 leading-relaxed mb-3">
                <strong className="text-text">SSH</strong> connects to a remote machine (a Linux server, another Mac, a Raspberry Pi, a cloud VM). Claude runs on the remote and accesses files there.
              </p>
              <div className="bg-surface0/50 border border-surface0 rounded p-3 text-xs text-subtext1 font-mono">
                <div className="text-subtext0 mb-1">SSH flow:</div>
                <div>Your computer ──SSH──▶ Remote</div>
                <div className="ml-[9.5rem]">└─ Claude runs here</div>
                <div className="ml-[9.5rem]">└─ Reads your files</div>
              </div>
              <div className="bg-surface0/50 border border-surface0 rounded p-3 text-xs text-subtext1 mt-3">
                <strong className="text-blue">💡 Tip:</strong> If you leave the SSH password empty, the config will use your SSH key (usually <code className="text-mauve">~/.ssh/id_rsa</code> or <code className="text-mauve">id_ed25519</code>).
              </div>
            </div>

            {/* Directory help */}
            <div ref={sectionRefs.directory} className={`transition-opacity ${activeSection === 'directory' ? 'opacity-100' : 'opacity-50'}`}>
              <div className="text-mauve text-xs font-semibold uppercase tracking-wider mb-2">Working Directory</div>
              <h4 className="text-base font-bold text-text mb-2">Point Claude at your project</h4>
              <p className="text-sm text-subtext0 leading-relaxed mb-3">
                This is the folder Claude will treat as its workspace. Pick the <strong className="text-text">root of your project</strong> — usually the folder that contains files like <code className="text-mauve">package.json</code>, <code className="text-mauve">pyproject.toml</code>, <code className="text-mauve">Cargo.toml</code>, or <code className="text-mauve">.git</code>.
              </p>
              <p className="text-sm text-subtext0 leading-relaxed mb-3">
                Claude will read files from here and can navigate into subdirectories. It won't go above this folder unless you explicitly ask it to.
              </p>
              <div className="bg-surface0/50 border border-surface0 rounded p-3 text-xs text-subtext1">
                <strong className="text-blue">💡 Tip:</strong> Don't use your entire Documents or home folder — Claude will scan too much. Pick a specific project.
              </div>
            </div>

            {/* Claude options help */}
            <div ref={sectionRefs.claude} className={`transition-opacity ${activeSection === 'claude' ? 'opacity-100' : 'opacity-50'}`}>
              <div className="text-mauve text-xs font-semibold uppercase tracking-wider mb-2">Claude Options</div>
              <h4 className="text-base font-bold text-text mb-2">Tune how Claude thinks</h4>
              <p className="text-sm text-subtext0 leading-relaxed mb-3">
                <strong className="text-text">Model Override</strong> lets you force a specific Claude model for this config. Leave as Default to use your subscription's best model (usually Opus). Pick Sonnet or Haiku for faster/cheaper responses on simpler tasks.
              </p>
              <p className="text-sm text-subtext0 leading-relaxed mb-3">
                <strong className="text-text">Effort Level</strong> controls how deeply Claude thinks before responding. Higher effort = better quality but slower and more expensive. Auto lets Claude decide.
              </p>
              <div className="bg-surface0/50 border border-surface0 rounded p-3 text-xs text-subtext1">
                <strong className="text-blue">💡 Tip:</strong> Use High effort for architecture decisions and debugging hard bugs. Use Low effort for simple refactors and doc updates.
              </div>
            </div>

            {/* Advanced help */}
            <div ref={sectionRefs.advanced} className={`transition-opacity ${activeSection === 'advanced' ? 'opacity-100' : 'opacity-50'}`}>
              <div className="text-mauve text-xs font-semibold uppercase tracking-wider mb-2">Advanced</div>
              <h4 className="text-base font-bold text-text mb-2">Optional tweaks</h4>
              <p className="text-sm text-subtext0 leading-relaxed mb-3">
                <strong className="text-text">Flicker-free rendering</strong> uses the terminal's alternate screen buffer. Claude's UI updates without the whole screen flickering. Tradeoff: Ctrl+F search and scrollback don't work while Claude is running.
              </p>
              <p className="text-sm text-subtext0 leading-relaxed mb-3">
                <strong className="text-text">Disable auto-memory</strong> stops Claude from writing persistent memories to <code className="text-mauve">~/.claude/memory/</code>. Use this if you want each session to start fresh.
              </p>
              {isWindows && (
                <p className="text-sm text-subtext0 leading-relaxed mb-3">
                  <strong className="text-text">PowerShell tool</strong> (Windows only) gives Claude a native PowerShell command tool instead of the generic bash wrapper. Faster on Windows but in preview.
                </p>
              )}
              <div className="bg-surface0/50 border border-surface0 rounded p-3 text-xs text-subtext1">
                <strong className="text-blue">💡 Tip:</strong> You can leave all of these off and change them later. They're all reversible.
              </div>
            </div>

            {/* Final note */}
            <div className="bg-mauve/10 border border-mauve/30 rounded p-4 text-sm text-subtext0">
              <strong className="text-text block mb-1">Ready to go?</strong>
              Click <strong className="text-mauve">Create & Launch</strong> to save this config and start your first session. You can always edit it later from the sidebar.
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-surface0 flex items-center justify-between">
        <div className="text-xs text-overlay0">
          {canSubmit ? (
            <span className="text-green">✓ Ready to create</span>
          ) : sessionType === 'ssh' && !sshHost.trim() ? (
            <>Enter a name and SSH host to continue</>
          ) : (
            <>Enter a name to continue</>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onSkip}
            className="px-4 py-2 text-sm text-overlay1 hover:text-text transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-6 py-2 bg-mauve hover:bg-pink text-base font-medium rounded text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Create &amp; Launch
          </button>
        </div>
      </div>
    </div>
  )
}
