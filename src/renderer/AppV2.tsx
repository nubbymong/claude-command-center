import React, { useEffect, useState, useRef, useCallback } from 'react'
import './components/panels'
import { useSessionStore, Session } from './stores/sessionStore'
import { useConfigStore, TerminalConfig } from './stores/configStore'
import { useSettingsStore, ThemeMode } from './stores/settingsStore'
import { useAppMetaStore } from './stores/appMetaStore'
import { usePanelStore } from './stores/panelStore'
import { useMagicButtonStore } from './stores/magicButtonStore'
import { useTipsStore, trackUsage } from './stores/tipsStore'
import { setupCloudAgentListener } from './stores/cloudAgentStore'
import { setupTokenomicsListener } from './stores/tokenomicsStore'
import { setupVisionListener, useVisionStore } from './stores/visionStore'
import { findPaneByType } from './utils/panel-layout'
import { gatherLocalStorageData, hydrateStores } from './utils/configHydration'
import { markSessionForResumePicker } from './utils/resumePicker'
import ResumePicker from './components/ResumePicker'

// Module-level set -- synchronous, no React state race conditions
const _resumePickerSessions = new Set<string>()
import { generateId } from './utils/id'
import { killSessionPty } from './ptyTracker'
import { marked } from 'marked'
import TerminalView from './components/TerminalView'
import CloseDialog from './components/CloseDialog'
import SetupDialog from './components/SetupDialog'
import type { SessionState, SavedSession } from './types/electron'
import type { ViewType } from './types/views'

// Lazy imports for overlay pages
const CloudAgentsPage = React.lazy(() => import('./components/CloudAgentsPage'))
const TokenomicsPage = React.lazy(() => import('./components/TokenomicsPage'))
const MemoryPage = React.lazy(() => import('./components/MemoryPage'))
const InsightsPage = React.lazy(() => import('./components/InsightsPage'))
const SettingsPage = React.lazy(() => import('./components/SettingsPage'))
const LogViewer = React.lazy(() => import('./components/LogViewer'))
const GuidedConfigView = React.lazy(() => import('./components/GuidedConfigView'))

declare const __APP_VERSION__: string

// ─── Helper: build SSH config from a TerminalConfig's sshConfig ───
function copySshConfig(ssh?: TerminalConfig['sshConfig']): Session['sshConfig'] | undefined {
  if (!ssh) return undefined
  return {
    host: ssh.host, port: ssh.port, username: ssh.username,
    remotePath: ssh.remotePath, hasPassword: ssh.hasPassword,
    postCommand: ssh.postCommand, hasSudoPassword: ssh.hasSudoPassword,
    startClaudeAfter: ssh.startClaudeAfter, dockerContainer: ssh.dockerContainer,
  }
}

// ─── Helper: create a Session from a TerminalConfig ───
function sessionFromConfig(config: TerminalConfig, overrides?: Partial<Session>): Session {
  return {
    id: generateId(),
    configId: config.id,
    label: config.label,
    workingDirectory: config.workingDirectory,
    model: config.model,
    color: config.color,
    status: 'idle',
    createdAt: Date.now(),
    sessionType: config.sessionType,
    shellOnly: config.shellOnly,
    partnerTerminalPath: config.partnerTerminalPath,
    partnerElevated: config.partnerElevated,
    sshConfig: copySshConfig(config.sshConfig),
    legacyVersion: config.legacyVersion,
    agentIds: config.agentIds,
    machineName: config.machineName,
    flickerFree: config.flickerFree,
    powershellTool: config.powershellTool,
    effortLevel: config.effortLevel,
    disableAutoMemory: config.disableAutoMemory,
    ...overrides,
  }
}

// ─── Helper: init partner pane for a session ───
function initPartnerPane(sessionId: string, partnerTerminalPath?: string) {
  if (!partnerTerminalPath) return
  const layout = usePanelStore.getState().layouts[sessionId]
  if (!layout) return
  const terminalPane = findPaneByType(layout, 'claude-terminal')
  if (terminalPane) {
    usePanelStore.getState().addPane(sessionId, terminalPane.id, 'partner-terminal', 'vertical')
  }
}

// ─── Tool definitions for sidebar ───
type ToolKey = 'cloud-agents' | 'tokenomics' | 'memory' | 'insights'
const TOOLS: { key: ToolKey; label: string; icon: string }[] = [
  { key: 'cloud-agents', label: 'Agents', icon: String.fromCodePoint(0x2601) },
  { key: 'tokenomics', label: 'Tokenomics', icon: '$' },
  { key: 'memory', label: 'Memory', icon: String.fromCodePoint(0x270E) },
  { key: 'insights', label: 'Insights', icon: String.fromCodePoint(0x2248) },
]

// ─── Overlay modal wrapper ───
function OverlayModal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-base rounded-xl shadow-2xl w-full max-w-4xl max-h-[80vh] overflow-hidden flex flex-col relative"
        style={{ border: '1px solid var(--color-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 w-7 h-7 rounded-md flex items-center justify-center text-overlay0 hover:text-text hover:bg-surface0 transition-colors text-sm"
          title="Close"
        >
          {String.fromCodePoint(0x2715)}
        </button>
        <div className="flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  )
}

// ─── Resizable divider ───
function ResizeDivider({ direction, onResize }: { direction: 'horizontal' | 'vertical'; onResize: (delta: number) => void }) {
  const [dragging, setDragging] = React.useState(false)
  const startRef = React.useRef(0)

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    startRef.current = direction === 'horizontal' ? e.clientX : e.clientY

    const handleMove = (me: MouseEvent) => {
      const current = direction === 'horizontal' ? me.clientX : me.clientY
      onResize(current - startRef.current)
      startRef.current = current
    }
    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setDragging(false)
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }

  const isHoriz = direction === 'horizontal'
  return (
    <div
      onMouseDown={handleMouseDown}
      className="shrink-0 transition-colors duration-150"
      style={{
        width: isHoriz ? 4 : '100%',
        height: isHoriz ? '100%' : 4,
        cursor: isHoriz ? 'col-resize' : 'row-resize',
        background: dragging ? 'rgba(110,168,254,0.4)' : 'var(--color-border)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(110,168,254,0.25)' }}
      onMouseLeave={(e) => { if (!dragging) e.currentTarget.style.background = 'var(--color-border)' }}
    />
  )
}

// ─── Transcript entry types ───
interface TranscriptEntry {
  type: 'assistant' | 'user'
  message?: {
    role: string
    model?: string
    content: Array<{
      type: string
      text?: string
      name?: string
      id?: string
      input?: Record<string, unknown>
      tool_use_id?: string
      content?: unknown
    }>
    stop_reason?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  }
}

// Tool icons
const TOOL_ICONS: Record<string, string> = {
  Read: String.fromCodePoint(0x1F4C4),
  Edit: String.fromCodePoint(0x270F),
  Write: String.fromCodePoint(0x1F4DD),
  Bash: String.fromCodePoint(0x25B6),
  Grep: String.fromCodePoint(0x1F50D),
  Glob: String.fromCodePoint(0x1F4C2),
  Agent: String.fromCodePoint(0x2601),
  TodoWrite: String.fromCodePoint(0x2713),
  WebSearch: String.fromCodePoint(0x1F310),
  WebFetch: String.fromCodePoint(0x1F310),
}

function ToolCallCard({ block }: { block: TranscriptEntry['message'] extends undefined ? never : NonNullable<TranscriptEntry['message']>['content'][0] }) {
  const [expanded, setExpanded] = React.useState(false)
  if (block.type !== 'tool_use') return null

  const name = block.name || 'Unknown'
  const icon = TOOL_ICONS[name] || String.fromCodePoint(0x2699)
  const input = block.input || {}

  // Extract display details based on tool type
  let detail = ''
  let stats = ''
  if (name === 'Read' || name === 'Write') {
    detail = String(input.file_path || '').split(/[/\\]/).slice(-2).join('/')
  } else if (name === 'Edit') {
    detail = String(input.file_path || '').split(/[/\\]/).slice(-2).join('/')
    const oldLen = String(input.old_string || '').split('\n').length
    const newLen = String(input.new_string || '').split('\n').length
    stats = `+${newLen} -${oldLen}`
  } else if (name === 'Bash') {
    detail = String(input.command || '').slice(0, 60)
  } else if (name === 'Grep' || name === 'Glob') {
    detail = String(input.pattern || input.glob || '')
  } else if (name === 'Agent') {
    detail = String(input.description || '').slice(0, 50)
  }

  return (
    <div className="mb-1">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs cursor-pointer transition-colors"
        style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--color-border)' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.02)' }}
      >
        <span className="text-overlay0">{icon}</span>
        <span className="text-subtext0 font-medium">{name}</span>
        <span className="text-overlay0 font-mono truncate" style={{ maxWidth: 300 }}>{detail}</span>
        {stats && <span className="ml-auto text-green">{stats}</span>}
        <span className="text-overlay0 transition-transform" style={{ transform: expanded ? 'rotate(90deg)' : '' }}>
          {String.fromCodePoint(0x25B8)}
        </span>
      </div>
      {expanded && (
        <div className="ml-6 mt-1 mb-2 p-2 rounded text-xs font-mono text-overlay0 overflow-x-auto" style={{ background: 'rgba(0,0,0,0.2)', maxHeight: 200, overflowY: 'auto' }}>
          {name === 'Edit' && input.old_string ? (
            <div>
              <div className="text-red/70 whitespace-pre-wrap">- {String(input.old_string).slice(0, 500)}</div>
              <div className="text-green/70 whitespace-pre-wrap mt-1">+ {String(input.new_string).slice(0, 500)}</div>
            </div>
          ) : name === 'Bash' ? (
            <div className="text-subtext0 whitespace-pre-wrap">{String(input.command || '')}</div>
          ) : (
            <div className="text-overlay0 whitespace-pre-wrap">{JSON.stringify(input, null, 2).slice(0, 500)}</div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Rich conversation view (transcript-based) ───
function RichConversationView({ sessionId, workingDirectory }: { sessionId: string; workingDirectory: string }) {
  const [entries, setEntries] = React.useState<TranscriptEntry[]>([])
  const [status, setStatus] = React.useState<'loading' | 'watching' | 'no-transcript' | 'error'>('loading')
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const mountedRef = React.useRef(true)

  React.useEffect(() => {
    mountedRef.current = true

    if (!workingDirectory) {
      setStatus('no-transcript')
      return
    }

    setEntries([])
    setStatus('loading')

    const unsub = window.electronAPI.transcript.onEntries((sid, newEntries) => {
      if (sid !== sessionId || !mountedRef.current) return
      setStatus('watching')
      setEntries(prev => [...prev, ...(newEntries as TranscriptEntry[])])
    })

    window.electronAPI.transcript.start(sessionId, workingDirectory).then(() => {
      if (!mountedRef.current) return
      setTimeout(() => {
        if (mountedRef.current) {
          setStatus(prev => prev === 'loading' ? 'no-transcript' : prev)
        }
      }, 1500)
    }).catch((err) => {
      console.error('[RichView] Failed to start transcript watcher:', err)
      if (mountedRef.current) setStatus('error')
    })

    return () => {
      mountedRef.current = false
      unsub()
      window.electronAPI.transcript.stop(sessionId)
    }
  }, [sessionId, workingDirectory])

  // Auto-scroll to bottom when new entries arrive
  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [entries.length])

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-6" style={{ fontFamily: 'Inter, sans-serif' }}>
      <div className="max-w-3xl mx-auto">
        {entries.length === 0 && (
          <div className="text-sm text-overlay0 text-center py-12">
            {status === 'loading' && (
              <div className="animate-pulse">Loading transcript...</div>
            )}
            {status === 'watching' && 'Waiting for conversation data...'}
            {status === 'no-transcript' && (
              <>
                No transcript found for this project.
                <div className="text-xs text-overlay0/50 mt-2">
                  Start a conversation in the Terminal view first. The rich view will then show structured tool calls.
                </div>
              </>
            )}
            {status === 'error' && (
              <>
                <span style={{ color: 'var(--color-red)' }}>Failed to load transcript.</span>
                <div className="text-xs text-overlay0/50 mt-2">
                  Switch to Terminal view to use Claude directly.
                </div>
              </>
            )}
          </div>
        )}

        {entries.map((entry, i) => {
          const rawContent = entry.message?.content
          const content = Array.isArray(rawContent) ? rawContent : typeof rawContent === 'string' ? [{ type: 'text', text: rawContent }] : []
          if (entry.type === 'user') {
            // User messages: show text blocks, skip tool_results
            const textBlocks = content.filter(b => b.type === 'text' && b.text && b.text.length > 3)
            if (textBlocks.length === 0) return null
            const fullText = textBlocks.map(b => b.text).join(' ')
            if (fullText.length < 4) return null
            return (
              <div key={i} className="mb-4">
                <div
                  className="inline-block px-3 py-1.5 rounded-lg text-sm max-w-lg"
                  style={{ background: 'rgba(110,168,254,0.08)', color: 'var(--color-blue)' }}
                >
                  {fullText.slice(0, 300)}{fullText.length > 300 ? '...' : ''}
                </div>
              </div>
            )
          }

          if (entry.type === 'assistant') {
            const textBlocks = content.filter(b => b.type === 'text' && b.text)
            const toolBlocks = content.filter(b => b.type === 'tool_use')
            const unknownBlocks = content.filter(b => b.type !== 'text' && b.type !== 'tool_use')

            if (textBlocks.length === 0 && toolBlocks.length === 0 && unknownBlocks.length === 0) return null

            return (
              <div key={i} className="mb-4">
                {textBlocks.map((tb, j) => (
                  <div
                    key={j}
                    className="text-sm text-text leading-relaxed mb-2 prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: marked.parse(tb.text || '', { async: false }) as string }}
                  />
                ))}
                {toolBlocks.map((tb, j) => (
                  <ToolCallCard key={j} block={tb} />
                ))}
                {unknownBlocks.map((ub, j) => (
                  <div
                    key={`unknown-${j}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg mb-1 text-xs"
                    style={{ background: 'rgba(249,226,175,0.06)', border: '1px solid rgba(249,226,175,0.15)' }}
                  >
                    <span style={{ color: 'var(--color-yellow)' }}>{String.fromCodePoint(0x26A0)}</span>
                    <span className="text-overlay0">Unrecognised block: </span>
                    <span className="font-mono text-yellow">{ub.type || 'unknown'}</span>
                    <span className="ml-auto text-overlay0/50 text-xs">Switch to Terminal view for full output</span>
                  </div>
                ))}
              </div>
            )
          }

          return null
        })}
      </div>
    </div>
  )
}

// ─── Rich view input bar ───
function RichInputBar({ sessionId }: { sessionId: string }) {
  const [value, setValue] = React.useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!value.trim()) return
    window.electronAPI.pty.write(sessionId, value + '\r')
    setValue('')
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mx-4 mb-3 flex items-center rounded-xl shrink-0"
      style={{ background: 'var(--color-bg-input)', border: '1px solid var(--color-bg-input-border)' }}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Type a message or / for commands..."
        className="flex-1 bg-transparent px-4 py-3 text-sm text-text placeholder-overlay0 outline-none"
      />
      <button
        type="submit"
        className="px-3 py-2 text-overlay0 hover:text-text transition-colors text-sm mr-1"
        title="Send (Enter)"
      >
        {String.fromCodePoint(0x21B5)}
      </button>
    </form>
  )
}

// ─── Rich view error boundary ───
class RichViewErrorBoundary extends React.Component<
  { children: React.ReactNode; onFallbackToTerminal: () => void },
  { hasError: boolean; error: string }
> {
  state = { hasError: false, error: '' }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <div className="text-red text-sm mb-2">Rich view encountered an error</div>
            <div className="text-overlay0 text-xs mb-4">{this.state.error}</div>
            <button
              onClick={this.props.onFallbackToTerminal}
              className="text-xs px-3 py-1.5 rounded-md bg-surface0 text-subtext0 hover:bg-surface1 transition-colors"
            >
              Switch to Terminal
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── Theme toggle button ───
function ThemeToggle() {
  const theme = useSettingsStore((s) => s.settings.theme)
  const next: Record<ThemeMode, ThemeMode> = { dark: 'light', light: 'system', system: 'dark' }
  const labels: Record<ThemeMode, string> = { dark: 'Dark', light: 'Light', system: 'Auto' }
  return (
    <button
      onClick={() => useSettingsStore.getState().updateSettings({ theme: next[theme] })}
      className="text-xs text-overlay0 hover:text-text px-1.5 py-0.5 rounded hover:bg-surface0 transition-colors"
      title={`Theme: ${labels[theme]}. Click to cycle.`}
    >
      {labels[theme]}
    </button>
  )
}

// ─── Main component ───
export default function AppV2({ onSwitchBack }: { onSwitchBack: () => void }) {
  // ─ Store selectors ─
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const setActiveSession = useSessionStore((s) => s.setActiveSession)
  const addSession = useSessionStore((s) => s.addSession)
  const removeSession = useSessionStore((s) => s.removeSession)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const configs = useConfigStore((s) => s.configs)
  const sections = useConfigStore((s) => s.sections)

  // ─ Local state ─
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [needsCliSetup, setNeedsCliSetup] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [closeDialog, setCloseDialog] = useState<'close' | 'update' | null>(null)
  const [overlayView, setOverlayView] = useState<ViewType | null>(null)
  const [mainView, setMainView] = useState<'session' | ViewType>('session')
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false)
  const [panelsVisible, setPanelsVisible] = useState(false)
  const [closedPanels, setClosedPanels] = useState<Set<string>>(new Set())
  const [viewsMenuOpen, setViewsMenuOpen] = useState(false)
  const [viewMode, setViewMode] = useState<'terminal' | 'rich'>('terminal')
  const [resumePickerVersion, setResumePickerVersion] = useState(0)
  // Read from module-level set (synchronous), bump version to trigger re-render
  const addToResumePicker = useCallback((id: string) => {
    _resumePickerSessions.add(id)
    // Don't need re-render here -- the session add will trigger it
  }, [])
  const removeFromResumePicker = useCallback((id: string) => {
    _resumePickerSessions.delete(id)
    setResumePickerVersion(v => v + 1)
  }, [])
  const [panelStackWidth, setPanelStackWidth] = useState(340)
  const [showGuidedConfig, setShowGuidedConfig] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const hasRestoredRef = useRef(false)
  const sessionIdsRef = useRef<Set<string>>(new Set())

  // ─ Config loading ─
  const loadAndHydrateConfig = useCallback(async () => {
    try {
      const result = await window.electronAPI.config.loadAll()
      if (result.needsMigration) {
        const lsData = gatherLocalStorageData()
        if (Object.keys(lsData).length > 0) {
          await window.electronAPI.config.migrateFromLocalStorage(lsData)
          const reloaded = await window.electronAPI.config.loadAll()
          hydrateStores(reloaded.data)
        } else {
          hydrateStores(result.data)
        }
      } else {
        hydrateStores(result.data)
      }
      setConfigLoaded(true)
    } catch (err) {
      console.error('[AppV2] Failed to load config:', err)
      hydrateStores({})
      setConfigLoaded(true)
    }
  }, [])

  // ─ Setup check ─
  useEffect(() => {
    window.electronAPI.setup.isComplete().then(async (complete) => {
      setSetupComplete(complete)
      if (complete) {
        await loadAndHydrateConfig()
      }
    })
  }, [loadAndHydrateConfig])

  // ─ Session restore ─
  async function restoreSavedSessions() {
    try {
      const savedState = await window.electronAPI.session.load() as SessionState | null
      if (!savedState || savedState.sessions.length === 0) return
      const restoredSessions: Session[] = savedState.sessions.map((saved: SavedSession) => ({
        ...saved,
        status: 'idle' as const,
        createdAt: Date.now(),
      }))
      for (const session of restoredSessions) {
        if (!session.shellOnly && session.sessionType === 'local') {
          addToResumePicker(session.id)
          markSessionForResumePicker(session.id)
        }
      }
      useSessionStore.getState().restoreSessions(restoredSessions, savedState.activeSessionId)
      await window.electronAPI.session.clear()
      restoredSessions.forEach((s) => {
        usePanelStore.getState().initSession(s.id, window.innerWidth)
        initPartnerPane(s.id, s.partnerTerminalPath)
      })
    } catch (err) {
      console.error('[AppV2] Failed to restore sessions:', err)
    }
  }

  // ─ Post-config init ─
  useEffect(() => {
    if (!configLoaded || hasRestoredRef.current) return
    hasRestoredRef.current = true

    async function postConfigInit() {
      const appMeta = useAppMetaStore.getState().meta
      if (appMeta.setupVersion !== __APP_VERSION__) {
        const hasExistingConfig =
          useConfigStore.getState().configs.length > 0
        if (hasExistingConfig) {
          useAppMetaStore.getState().update({ setupVersion: __APP_VERSION__ })
        } else {
          const cliReady = await window.electronAPI.setup.isCliReady()
          if (cliReady) {
            useAppMetaStore.getState().update({ setupVersion: __APP_VERSION__ })
          } else {
            setNeedsCliSetup(true)
          }
        }
      }

      await restoreSavedSessions()
      setupCloudAgentListener()
      setupTokenomicsListener()
      setupVisionListener()
      useVisionStore.getState().loadConfig()
      useVisionStore.getState().fetchStatus()

      const magicSettings = useMagicButtonStore.getState().settings
      if (magicSettings.autoDeleteDays != null && magicSettings.autoDeleteDays > 0) {
        window.electronAPI.screenshot.cleanup(magicSettings.autoDeleteDays)
      }

      setTimeout(() => {
        useTipsStore.getState().pickNextTip()
      }, 2000)
    }

    postConfigInit()
  }, [configLoaded])

  // ─ Session sync: clean up removed sessions from panel store ─
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.id))
    sessionIdsRef.current.forEach((id) => {
      if (!currentIds.has(id)) {
        usePanelStore.getState().removeSession(id)
      }
    })
    sessions.forEach((s) => {
      if (!sessionIdsRef.current.has(s.id) && s.partnerTerminalPath) {
        usePanelStore.getState().initSession(s.id, window.innerWidth)
        const layout = usePanelStore.getState().layouts[s.id]
        if (layout && !findPaneByType(layout, 'partner-terminal')) {
          initPartnerPane(s.id, s.partnerTerminalPath)
        }
      }
    })
    sessionIdsRef.current = currentIds
  }, [sessions])

  // ─ Build session state for saving ─
  function buildSessionState(): SessionState {
    const state = useSessionStore.getState()
    return {
      sessions: state.sessions.map((s) => ({
        id: s.id, configId: s.configId, label: s.label,
        workingDirectory: s.workingDirectory, model: s.model, color: s.color,
        sessionType: s.sessionType, shellOnly: s.shellOnly,
        partnerTerminalPath: s.partnerTerminalPath, partnerElevated: s.partnerElevated,
        sshConfig: copySshConfig(s.sshConfig as any),
        legacyVersion: s.legacyVersion, agentIds: s.agentIds,
      })),
      activeSessionId: state.activeSessionId,
      savedAt: Date.now(),
    }
  }

  // ─ Close handlers ─
  const handleSaveAndClose = async () => {
    const isUpdate = closeDialog === 'update'
    setCloseDialog(null)
    setIsClosing(true)
    if (isUpdate) setIsUpdating(true)
    try {
      await window.electronAPI.session.save(buildSessionState())
      if (isUpdate) {
        await window.electronAPI.update.installAndRestart()
      } else {
        await window.electronAPI.session.gracefulExit()
        window.electronAPI.window.allowClose()
      }
    } catch (err) {
      console.error('[AppV2] Shutdown error:', err)
      if (!isUpdate) window.electronAPI.window.allowClose()
      setIsClosing(false)
    }
  }

  const handleCloseWithoutSaving = async () => {
    const isUpdate = closeDialog === 'update'
    setCloseDialog(null)
    setIsClosing(true)
    if (isUpdate) setIsUpdating(true)
    try {
      await window.electronAPI.session.clear()
      if (isUpdate) {
        await window.electronAPI.update.installAndRestart()
      } else {
        window.electronAPI.window.allowClose()
      }
    } catch (err) {
      console.error('[AppV2] Close error:', err)
      if (!isUpdate) window.electronAPI.window.allowClose()
      setIsClosing(false)
    }
  }

  // ─ Window close intercept ─
  useEffect(() => {
    const handleCloseRequested = () => {
      if (isClosing) return
      const state = useSessionStore.getState()
      if (state.sessions.length === 0) {
        window.electronAPI.window.allowClose()
        return
      }
      setCloseDialog('close')
    }
    const unsub = window.electronAPI.window.onCloseRequested(handleCloseRequested)
    return () => unsub()
  }, [isClosing])

  // ─ Keyboard shortcuts ─
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'F12') {
        e.preventDefault()
        onSwitchBack()
      }
      // Ctrl+N: new session
      if (e.ctrlKey && e.key === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        setShowGuidedConfig(true)
      }
      // Escape: close overlay
      if (e.key === 'Escape') {
        if (overlayView) setOverlayView(null)
        if (showGuidedConfig) setShowGuidedConfig(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onSwitchBack, overlayView, showGuidedConfig])

  // ─ Launch session from config ─
  const launchFromConfig = useCallback(
    (config: TerminalConfig) => {
      const session = sessionFromConfig(config)
      if (!session.shellOnly && session.sessionType === 'local') {
        addToResumePicker(session.id)
        markSessionForResumePicker(session.id) // Also tell TerminalView to use picker script
      }
      addSession(session)
      trackUsage('sessions.create-config')
      setOverlayView(null)
    },
    [addSession]
  )

  // ─ Close session handler ─
  const handleCloseSession = useCallback(
    (sessionId: string) => {
      killSessionPty(sessionId)
      removeSession(sessionId)
    },
    [removeSession]
  )

  // ─ Group configs by section for sidebar ─
  const configsBySection = React.useMemo(() => {
    const result: { name: string; configs: TerminalConfig[] }[] = []
    const sectionMap = new Map(sections.map((s) => [s.id, s.name]))
    const grouped = new Map<string, TerminalConfig[]>()

    for (const cfg of configs) {
      const sectionName = cfg.sectionId ? sectionMap.get(cfg.sectionId) || 'Unsorted' : 'Unsorted'
      if (!grouped.has(sectionName)) grouped.set(sectionName, [])
      grouped.get(sectionName)!.push(cfg)
    }
    for (const [name, cfgs] of grouped) {
      result.push({ name, configs: cfgs })
    }
    return result
  }, [configs, sections])

  // ─ Panel toggle helper ─
  const togglePanel = useCallback((panelKey: string) => {
    setClosedPanels((prev) => {
      const next = new Set(prev)
      if (next.has(panelKey)) next.delete(panelKey)
      else next.add(panelKey)
      return next
    })
  }, [])

  // ─ Loading state ─
  if (setupComplete === null || (setupComplete && !configLoaded)) {
    return (
      <div className="flex flex-col h-screen bg-base text-text items-center justify-center">
        <div className="text-overlay1 text-sm">Loading...</div>
      </div>
    )
  }

  // ─ Setup dialog ─
  if (!setupComplete) {
    return (
      <SetupDialog
        onComplete={async () => {
          await loadAndHydrateConfig()
          useAppMetaStore.getState().update({ setupVersion: __APP_VERSION__ })
          setSetupComplete(true)
          setNeedsCliSetup(false)
        }}
      />
    )
  }

  if (needsCliSetup) {
    return (
      <SetupDialog
        initialStep={2}
        onComplete={() => {
          useAppMetaStore.getState().update({ setupVersion: __APP_VERSION__ })
          setNeedsCliSetup(false)
        }}
      />
    )
  }

  // ─── Guided config handler ───
  const handleGuidedConfirm = async (
    configDraft: Omit<TerminalConfig, 'id'>,
    sshPassword?: string
  ) => {
    const configId = generateId()
    if (sshPassword) {
      await window.electronAPI.credentials.save(configId, sshPassword)
    }
    const newConfig = { ...configDraft, id: configId } as TerminalConfig
    useConfigStore.getState().addConfig(newConfig)
    useAppMetaStore.getState().update({ hasCreatedFirstConfig: true })
    trackUsage('sessions.create-config')

    const session = sessionFromConfig(newConfig)
    if (!session.shellOnly && session.sessionType === 'local') {
      addToResumePicker(session.id)
      markSessionForResumePicker(session.id)
    }
    useSessionStore.getState().addSession(session)
    usePanelStore.getState().initSession(session.id, window.innerWidth)
    initPartnerPane(session.id, newConfig.partnerTerminalPath)
    setShowGuidedConfig(false)
  }

  return (
    <div className="flex flex-col h-screen bg-base text-text overflow-hidden">
      {/* ─── Close dialog ─── */}
      {closeDialog && (
        <CloseDialog
          mode={closeDialog}
          sessionCount={sessions.length}
          onSaveAndClose={handleSaveAndClose}
          onCloseWithoutSaving={handleCloseWithoutSaving}
          onCancel={() => {
            setCloseDialog(null)
            window.electronAPI.window.cancelClose()
          }}
        />
      )}

      {/* ─── Closing overlay ─── */}
      {isClosing && (
        <div className="absolute inset-0 bg-base/90 z-50 flex items-center justify-center">
          <div className="text-center">
            <div className="text-2xl font-mono mb-4 text-blue animate-pulse">
              {isUpdating ? 'Updating...' : 'Closing...'}
            </div>
            <p className="text-overlay1 text-sm">
              {isUpdating ? 'Installing update and restarting' : 'Please wait'}
            </p>
          </div>
        </div>
      )}

      {/* ─── Title bar ─── */}
      <div
        className="h-9 flex items-center px-4 bg-mantle shrink-0 titlebar-drag"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <span className="text-overlay0 text-xs titlebar-no-drag">Claude Command Center</span>
        <div className="flex-1" />
        <button
          onClick={onSwitchBack}
          className="text-overlay0 hover:text-text text-xs px-2 py-0.5 rounded hover:bg-surface0 transition-colors titlebar-no-drag mr-2"
          title="Switch to classic UI (Ctrl+F12)"
        >
          Classic UI
        </button>
        {/* Windows window controls */}
        <div className="flex titlebar-no-drag -mr-4">
          <button
            onClick={() => window.electronAPI.window.minimize()}
            className="w-11 h-9 flex items-center justify-center text-overlay0 hover:bg-surface0 transition-colors text-xs"
          >
            {String.fromCodePoint(0x2014)}
          </button>
          <button
            onClick={() => window.electronAPI.window.maximize()}
            className="w-11 h-9 flex items-center justify-center text-overlay0 hover:bg-surface0 transition-colors text-xs"
          >
            {String.fromCodePoint(0x25A1)}
          </button>
          <button
            onClick={() => window.electronAPI.window.close()}
            className="w-11 h-9 flex items-center justify-center text-overlay0 hover:bg-red hover:text-text transition-colors text-xs"
          >
            {String.fromCodePoint(0x2715)}
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ═══════════ SIDEBAR ═══════════ */}
        <aside
          className="flex flex-col shrink-0 overflow-y-auto overflow-x-hidden bg-mantle transition-all duration-200"
          style={{
            width: sidebarCollapsed ? 48 : 240,
            borderRight: '1px solid var(--color-border)',
          }}
        >
          {/* Collapse toggle + New session */}
          <div className="p-2 flex flex-col gap-0.5">
            {sidebarCollapsed ? (
              <button
                onClick={() => setSidebarCollapsed(false)}
                className="w-8 h-8 mx-auto rounded-lg flex items-center justify-center text-overlay0 hover:text-text hover:bg-surface0/50 transition-colors text-sm"
                title="Expand sidebar"
              >
                {String.fromCodePoint(0x25B6)}
              </button>
            ) : (
              <>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setShowGuidedConfig(true)}
                    className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-overlay1 hover:text-text hover:bg-surface0/50 transition-colors"
                    title="New session (Ctrl+N)"
                  >
                    <span className="text-base">+</span> New session
                  </button>
                  <button
                    onClick={() => setSidebarCollapsed(true)}
                    className="w-7 h-7 rounded-md flex items-center justify-center text-overlay0 hover:text-text hover:bg-surface0/50 transition-colors text-xs"
                    title="Collapse sidebar"
                  >
                    {String.fromCodePoint(0x25C0)}
                  </button>
                </div>
              </>
            )}
          </div>

          {!sidebarCollapsed && (
            <>
              {/* ─ Running sessions ─ */}
              {sessions.length > 0 && (
                <div className="px-2">
                  <div className="text-xs text-overlay0 uppercase tracking-wider px-3 py-2 font-medium">
                    Running
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {sessions.map((session) => (
                      <div key={session.id} className="group relative">
                        <button
                          onClick={() => { setActiveSession(session.id); setMainView('session') }}
                          className={`flex items-center gap-3 px-3 py-2 rounded-lg text-left w-full transition-all duration-150 ${
                            session.id === activeSessionId
                              ? 'bg-surface0/60'
                              : 'hover:bg-surface0/30'
                          }`}
                        >
                          <div
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{
                              backgroundColor:
                                session.status === 'working'
                                  ? '#5cb85c'
                                  : session.status === 'idle'
                                    ? session.color
                                    : '#555',
                              boxShadow:
                                session.status === 'working'
                                  ? '0 0 6px rgba(92,184,92,0.4)'
                                  : 'none',
                            }}
                          />
                          <div className="min-w-0 flex-1">
                            <div
                              className={`text-sm truncate ${
                                session.id === activeSessionId
                                  ? 'text-text font-medium'
                                  : 'text-subtext0'
                              }`}
                            >
                              {session.label}
                            </div>
                            <div className="text-xs text-overlay0 truncate mt-0.5">
                              {session.modelName || session.model || 'default'}
                              {session.sessionType === 'ssh' && ' \u00B7 SSH'}
                              {session.contextPercent != null &&
                                ` \u00B7 ${Math.round(session.contextPercent)}%`}
                            </div>
                          </div>
                          {session.needsAttention && (
                            <div className="w-2 h-2 rounded-full bg-yellow shrink-0" />
                          )}
                        </button>
                        {/* Close button on hover */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleCloseSession(session.id)
                          }}
                          className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-overlay0 hover:text-red hover:bg-surface0 opacity-0 group-hover:opacity-100 transition-all text-xs"
                          title="Close session"
                        >
                          {String.fromCodePoint(0x2715)}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ─ Configs ─ */}
              {configs.length > 0 && (
                <div className="px-2 mt-2">
                  <div className="text-xs text-overlay0 uppercase tracking-wider px-3 py-2 font-medium">
                    Configs
                  </div>
                  {configsBySection.map(({ name, configs: sectionConfigs }) => (
                    <div key={name}>
                      {configsBySection.length > 1 && (
                        <div className="text-xs text-overlay0/60 px-3 py-1 mt-1">{name}</div>
                      )}
                      {sectionConfigs.map((cfg) => {
                        const isRunning = sessions.some((s) => s.configId === cfg.id)
                        return (
                          <button
                            key={cfg.id}
                            onClick={() => launchFromConfig(cfg)}
                            className="flex items-center gap-3 px-3 py-1.5 rounded-lg text-left w-full hover:bg-surface0/30 transition-colors"
                            title={`Launch ${cfg.label}`}
                          >
                            <div
                              className="w-1.5 h-1.5 rounded-full shrink-0"
                              style={{ backgroundColor: isRunning ? cfg.color : 'var(--color-overlay0)' }}
                            />
                            <span
                              className={`text-sm truncate ${
                                isRunning ? 'text-subtext0' : 'text-overlay1'
                              }`}
                            >
                              {cfg.label}
                            </span>
                            {cfg.sessionType === 'ssh' && (
                              <span className="text-xs text-overlay0/50 ml-auto">SSH</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                </div>
              )}

              {/* ─ Tools ─ */}
              <div className="px-2 mt-4">
                <div className="text-xs text-overlay0 uppercase tracking-wider px-3 py-2 font-medium">
                  Tools
                </div>
                <div className="flex flex-col gap-0.5">
                  {TOOLS.map((tool) => (
                    <button
                      key={tool.key}
                      onClick={() => {
                        setMainView(mainView === tool.key ? 'session' : tool.key)
                      }}
                      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                        mainView === tool.key
                          ? 'bg-surface0/60 text-text'
                          : 'text-overlay1 hover:text-text hover:bg-surface0/30'
                      }`}
                    >
                      <span className="text-overlay0 text-xs w-4 text-center">{tool.icon}</span>
                      {tool.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Spacer */}
              <div className="flex-1" />

              {/* ─ Bottom: user + settings ─ */}
              <div
                className="p-3 flex items-center gap-2"
                style={{ borderTop: '1px solid var(--color-border)' }}
              >
                <div className="w-6 h-6 rounded-full bg-surface1 flex items-center justify-center text-xs text-overlay1 font-medium">
                  N
                </div>
                <span className="text-sm text-overlay1 truncate flex-1">Nick</span>
                <button
                  onClick={() => setMainView(mainView === 'settings' ? 'session' : 'settings')}
                  className="text-overlay0 hover:text-text text-sm transition-colors"
                  title="Settings"
                >
                  {String.fromCodePoint(0x2699)}
                </button>
              </div>
            </>
          )}
        </aside>

        {/* ═══════════ MAIN AREA ═══════════ */}
        <main className="flex-1 flex flex-col overflow-hidden relative">
          {/* ─── Guided config overlay ─── */}
          {showGuidedConfig && (
            <div className="absolute inset-0 z-30 bg-base overflow-auto">
              <React.Suspense
                fallback={
                  <div className="flex-1 flex items-center justify-center text-overlay1 text-sm">
                    Loading...
                  </div>
                }
              >
                <GuidedConfigView
                  onSkip={() => setShowGuidedConfig(false)}
                  onConfirm={handleGuidedConfirm}
                />
              </React.Suspense>
            </div>
          )}

          {/* ─── Tool pages (full main area) ─── */}
          {mainView !== 'session' && (
            <div className="flex-1 overflow-auto">
              <div className="flex items-center px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--color-border)' }}>
                <button
                  onClick={() => setMainView('session')}
                  className="text-xs text-overlay0 hover:text-text mr-3 transition-colors"
                >
                  {String.fromCodePoint(0x2190)} Back
                </button>
                <span className="text-sm font-medium text-text capitalize">{mainView === 'cloud-agents' ? 'Agent Hub' : mainView}</span>
              </div>
              <React.Suspense fallback={<div className="p-6 text-overlay0 text-sm">Loading...</div>}>
                {mainView === 'cloud-agents' && <CloudAgentsPage />}
                {mainView === 'tokenomics' && <TokenomicsPage />}
                {mainView === 'memory' && <MemoryPage />}
                {mainView === 'insights' && <InsightsPage />}
                {mainView === 'settings' && <SettingsPage />}
                {mainView === 'logs' && <LogViewer />}
              </React.Suspense>
            </div>
          )}

          {mainView === 'session' && activeSession ? (
            <>
              {/* ─ Session header ─ */}
              <div
                className="px-5 py-2.5 flex items-center gap-3 shrink-0"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    backgroundColor:
                      activeSession.status === 'working' ? '#5cb85c' : activeSession.color,
                  }}
                />
                <span className="text-sm font-semibold text-text">{activeSession.label}</span>
                <span className="text-xs text-overlay0">
                  {activeSession.modelName || activeSession.model || 'default'}
                </span>
                {activeSession.sessionType === 'ssh' && activeSession.sshConfig && (
                  <span className="text-xs text-overlay0">
                    SSH: {activeSession.sshConfig.username}@{activeSession.sshConfig.host}
                  </span>
                )}
                <div className="flex-1" />
                {/* Terminal / Rich view toggle (hidden during resume picker) */}
                {!_resumePickerSessions.has(activeSession.id) && <div
                  className="flex items-center rounded-md overflow-hidden text-xs"
                  style={{ border: '1px solid var(--color-border)' }}
                >
                  <button
                    onClick={() => setViewMode('terminal')}
                    className={`px-2.5 py-1 transition-colors ${viewMode === 'terminal' ? 'bg-surface0 text-text' : 'text-overlay0 hover:text-subtext0'}`}
                  >
                    Terminal
                  </button>
                  <button
                    onClick={() => setViewMode('rich')}
                    className={`px-2.5 py-1 transition-colors ${viewMode === 'rich' ? 'bg-surface0 text-text' : 'text-overlay0 hover:text-subtext0'}`}
                  >
                    Rich
                  </button>
                </div>}
                <div className="relative">
                  <button
                    onClick={() => setViewsMenuOpen((v) => !v)}
                    className={`text-xs px-2.5 py-1 rounded-md transition-colors flex items-center gap-1 ${
                      panelsVisible
                        ? 'bg-blue/15 text-blue'
                        : 'text-overlay0 hover:text-text bg-surface0 hover:bg-surface1'
                    }`}
                  >
                    Views {String.fromCodePoint(0x25BE)}
                  </button>
                  {viewsMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onPointerDown={() => setViewsMenuOpen(false)} />
                      <div
                        className="absolute right-0 top-full mt-1 z-50 rounded-lg shadow-xl py-1 min-w-[180px] bg-mantle"
                        style={{ border: '1px solid var(--color-border-hover)' }}
                      >
                        {[
                          { key: 'changes', label: 'Changes', color: 'var(--color-yellow)' },
                          { key: 'terminal', label: 'Terminal', color: 'var(--color-green)' },
                          { key: 'preview', label: 'Preview', color: 'var(--color-teal)' },
                        ].map((panel) => {
                          const isOn = !closedPanels.has(panel.key)
                          return (
                            <button
                              key={panel.key}
                              onClick={() => {
                                const next = new Set(closedPanels)
                                if (isOn) next.add(panel.key)
                                else next.delete(panel.key)
                                setClosedPanels(next)
                                if (next.size < 3) setPanelsVisible(true)
                              }}
                              className="w-full text-left px-3 py-2 text-xs text-subtext0 hover:bg-surface0 transition-colors flex items-center gap-2"
                            >
                              <div className="w-2 h-2 rounded-sm" style={{ background: isOn ? panel.color : 'var(--color-surface2)' }} />
                              {panel.label}
                              <span className="ml-auto text-overlay0">{isOn ? String.fromCodePoint(0x2713) : ''}</span>
                            </button>
                          )
                        })}
                        <div style={{ borderTop: '1px solid var(--color-border)', margin: '4px 0' }} />
                        <button
                          onClick={() => { setPanelsVisible((v) => !v); setViewsMenuOpen(false) }}
                          className="w-full text-left px-3 py-2 text-xs text-overlay0 hover:bg-surface0 transition-colors"
                        >
                          {panelsVisible ? 'Hide all panels' : 'Show panels'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* ─ Terminal + panel stack ─ */}
              <div className="flex flex-1 overflow-hidden" style={{ minHeight: 0 }}>
                {/* Main content area */}
                <div className="flex-1 flex flex-col min-w-0 relative">
                  {/* Resume picker overlay -- covers terminal until user picks */}
                  {activeSession && _resumePickerSessions.has(activeSession.id) && (
                    <div className="absolute inset-0 z-30 bg-base flex items-center justify-center">
                      <ResumePicker
                        workingDirectory={activeSession.workingDirectory}
                        sessionLabel={activeSession.label}
                        onResume={(claudeSessionId) => {
                          removeFromResumePicker(activeSession.id)
                          // Kill picker PTY, respawn Claude with --resume directly
                          window.electronAPI.pty.kill(activeSession.id)
                          setTimeout(() => {
                            window.electronAPI.pty.spawn(activeSession.id, {
                              cwd: activeSession.workingDirectory,
                              configId: activeSession.configId,
                              configLabel: activeSession.label,
                              resumeSessionId: claudeSessionId,
                              effortLevel: activeSession.effortLevel,
                              flickerFree: activeSession.flickerFree,
                              powershellTool: activeSession.powershellTool,
                              disableAutoMemory: activeSession.disableAutoMemory,
                            })
                          }, 200)
                        }}
                        onNewConversation={() => {
                          removeFromResumePicker(activeSession.id)
                          // Kill picker PTY, respawn Claude fresh
                          window.electronAPI.pty.kill(activeSession.id)
                          setTimeout(() => {
                            window.electronAPI.pty.spawn(activeSession.id, {
                              cwd: activeSession.workingDirectory,
                              configId: activeSession.configId,
                              configLabel: activeSession.label,
                              effortLevel: activeSession.effortLevel,
                              flickerFree: activeSession.flickerFree,
                              powershellTool: activeSession.powershellTool,
                              disableAutoMemory: activeSession.disableAutoMemory,
                            })
                          }, 200)
                        }}
                      />
                    </div>
                  )}
                  {/* Rich conversation view (shown above terminal when active) */}
                  {viewMode === 'rich' && activeSession && !_resumePickerSessions.has(activeSession.id) && (
                    <div className="flex-1 flex flex-col overflow-hidden bg-base" style={{ minHeight: 100 }}>
                      <React.Suspense fallback={<div className="flex-1 flex items-center justify-center text-overlay0 text-sm">Loading...</div>}>
                        <RichViewErrorBoundary onFallbackToTerminal={() => setViewMode('terminal')}>
                          <RichConversationView sessionId={activeSession.id} workingDirectory={activeSession.workingDirectory} />
                          <RichInputBar sessionId={activeSession.id} />
                        </RichViewErrorBoundary>
                      </React.Suspense>
                    </div>
                  )}
                  {/* Terminal views (always mounted, overlay covers when resume picker is active) */}
                  {sessions.map((session) => (
                    <div
                      key={session.id + '-' + session.createdAt}
                      className="flex-1 flex flex-col"
                      style={{
                        display: session.id === activeSessionId && viewMode === 'terminal' ? 'flex' : 'none',
                        minHeight: 0,
                      }}
                    >
                      <TerminalView
                        sessionId={session.id}
                        configId={session.configId}
                        cwd={
                          session.sessionType === 'local' ? session.workingDirectory : undefined
                        }
                        shellOnly={session.shellOnly}
                        ssh={session.sshConfig}
                        isActive={session.id === activeSessionId && viewMode === 'terminal'}
                        legacyVersion={session.legacyVersion}
                        agentIds={session.agentIds}
                        flickerFree={session.flickerFree}
                        powershellTool={session.powershellTool}
                        effortLevel={session.effortLevel}
                        disableAutoMemory={session.disableAutoMemory}
                      />
                    </div>
                  ))}
                </div>

                {/* ─ Panel stack (right side) ─ */}
                {panelsVisible && (
                  <>
                  <ResizeDivider
                    direction="horizontal"
                    onResize={(delta) => setPanelStackWidth((w) => Math.max(200, Math.min(600, w - delta)))}
                  />
                  <div
                    className="flex flex-col shrink-0 overflow-hidden bg-mantle"
                    style={{ width: panelStackWidth }}
                  >
                    <PanelSection
                      title="Changes"
                      accentColor="var(--color-yellow)"
                      visible={!closedPanels.has('changes')}
                      onClose={() => togglePanel('changes')}
                    >
                      <DiffViewerPanelInline sessionId={activeSession.id} />
                    </PanelSection>

                    <PanelSection
                      title="Terminal"
                      accentColor="var(--color-green)"
                      visible={!closedPanels.has('terminal')}
                      onClose={() => togglePanel('terminal')}
                    >
                      <div className="flex-1 min-h-0" style={{ minHeight: 120 }}>
                        <TerminalView
                          sessionId={`${activeSession.id}-partner`}
                          configId={activeSession.configId}
                          cwd={activeSession.partnerTerminalPath || activeSession.workingDirectory}
                          shellOnly={true}
                          isActive={activeSessionId === activeSession.id}
                        />
                      </div>
                    </PanelSection>

                    <PanelSection
                      title="Preview"
                      accentColor="var(--color-teal)"
                      visible={!closedPanels.has('preview')}
                      onClose={() => togglePanel('preview')}
                    >
                      <div className="flex items-center justify-center p-6 text-center">
                        <div>
                          <div className="text-overlay0/40 text-2xl mb-2">{String.fromCodePoint(0x25C9)}</div>
                          <div className="text-xs text-overlay0">Run your dev server to see a live preview</div>
                          <button className="mt-3 text-xs px-3 py-1.5 rounded-md bg-surface0 text-subtext0 hover:bg-surface1 transition-colors">
                            Set up
                          </button>
                        </div>
                      </div>
                    </PanelSection>
                  </div>
                  </>
                )}
              </div>

              {/* ─ Status bar ─ */}
              <div
                className="px-5 py-1.5 flex items-center gap-4 text-xs text-overlay0 shrink-0"
                style={{ borderTop: '1px solid var(--color-border)' }}
              >
                {activeSession.costUsd != null && (
                  <span className="text-green">${activeSession.costUsd.toFixed(2)}</span>
                )}
                {activeSession.contextPercent != null && (
                  <span>{Math.round(activeSession.contextPercent)}% context</span>
                )}
                {activeSession.totalDurationMs != null && (
                  <span>
                    {activeSession.totalDurationMs >= 60000
                      ? `${Math.floor(activeSession.totalDurationMs / 60000)}m ${Math.round((activeSession.totalDurationMs % 60000) / 1000)}s`
                      : `${Math.round(activeSession.totalDurationMs / 1000)}s`}
                  </span>
                )}
                {activeSession.linesAdded != null && (
                  <span>
                    <span className="text-green">+{activeSession.linesAdded}</span>
                    {activeSession.linesRemoved != null && (
                      <span className="text-red"> -{activeSession.linesRemoved}</span>
                    )}
                  </span>
                )}
                <div className="flex-1" />
                <ThemeToggle />
                <span className="text-overlay0">
                  {activeSession.modelName || activeSession.model || 'default'}
                </span>
              </div>
            </>
          ) : mainView === 'session' ? (
            /* ─── Empty state ─── */
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="text-3xl text-overlay0/30 mb-4">{String.fromCodePoint(0x276F)}</div>
                <div className="text-lg text-text font-medium mb-1">What's up next?</div>
                <div className="text-sm text-overlay0 mb-4">
                  Select a session from the sidebar or create a new one
                </div>
                <button
                  onClick={() => setShowGuidedConfig(true)}
                  className="px-4 py-2 rounded-lg text-sm bg-surface0 hover:bg-surface1 text-text transition-colors"
                >
                  + New session
                </button>
              </div>
            </div>
          ) : null}
        </main>
      </div>

      {/* ═══════════ OVERLAY VIEWS (kept for dialogs only) ═══════════ */}
      {overlayView && (
        <OverlayModal onClose={() => setOverlayView(null)}>
          <React.Suspense
            fallback={
              <div className="flex items-center justify-center h-64 text-overlay1 text-sm">
                Loading...
              </div>
            }
          >
            {overlayView === 'cloud-agents' && <CloudAgentsPage />}
            {overlayView === 'tokenomics' && <TokenomicsPage />}
            {overlayView === 'memory' && <MemoryPage />}
            {overlayView === 'insights' && <InsightsPage />}
            {overlayView === 'settings' && <SettingsPage />}
            {overlayView === 'logs' && <LogViewer />}
          </React.Suspense>
        </OverlayModal>
      )}
    </div>
  )
}

// ─── Panel section sub-component ───
function PanelSection({
  title,
  accentColor,
  visible,
  onClose,
  children,
}: {
  title: string
  accentColor: string
  visible: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  if (!visible) return null
  return (
    <div className="flex flex-col" style={{ borderBottom: '1px solid var(--color-border)' }}>
      <div className="flex items-center gap-2 px-3 py-2 shrink-0">
        <div className="w-0.5 h-3.5 rounded-full" style={{ backgroundColor: accentColor }} />
        <span className="text-xs font-medium text-subtext0 flex-1">{title}</span>
        <button
          onClick={onClose}
          className="w-5 h-5 rounded flex items-center justify-center text-overlay0 hover:text-text hover:bg-surface0 transition-colors text-xs"
        >
          {String.fromCodePoint(0x2715)}
        </button>
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  )
}

// ─── Inline diff viewer for the panel stack ───
// This is a simplified wrapper -- the full DiffViewerPane needs PaneComponentProps.
// We render a lightweight version that subscribes to diff updates.
function DiffViewerPanelInline({ sessionId }: { sessionId: string }) {
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const [fileCount, setFileCount] = useState(0)

  useEffect(() => {
    if (!session?.workingDirectory) return

    // Try to get diff stats
    const checkDiffs = async () => {
      try {
        const stats = await (window.electronAPI as any).diff?.getStats?.(sessionId, session.workingDirectory)
        if (stats) {
          setFileCount(stats.filesChanged || 0)
        }
      } catch {
        // diff API may not be available
      }
    }
    checkDiffs()
    const interval = setInterval(checkDiffs, 5000)
    return () => clearInterval(interval)
  }, [sessionId, session?.workingDirectory])

  if (!session) return null

  return (
    <div className="p-3 text-xs">
      {fileCount > 0 ? (
        <div className="text-subtext0">
          {fileCount} file{fileCount !== 1 ? 's' : ''} changed
          {session.linesAdded != null && (
            <span className="ml-2">
              <span className="text-green">+{session.linesAdded}</span>
              {session.linesRemoved != null && (
                <span className="text-red ml-1">-{session.linesRemoved}</span>
              )}
            </span>
          )}
        </div>
      ) : (
        <div className="text-overlay0">No changes detected</div>
      )}
    </div>
  )
}
