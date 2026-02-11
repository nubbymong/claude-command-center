import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

interface LogSession {
  configLabel: string
  sessionId: string
  logDir: string
  startTime?: number
  endTime?: number
  size: number
}

interface LogEntry {
  ts: number
  type: string
  data?: string
}

const THEME = {
  background: '#1E1E2E',
  foreground: '#CDD6F4',
  cursor: '#F5E0DC',
  cursorAccent: '#1E1E2E',
  selectionBackground: '#45475A',
  selectionForeground: '#CDD6F4',
  black: '#45475A',
  red: '#F38BA8',
  green: '#A6E3A1',
  yellow: '#F9E2AF',
  blue: '#89B4FA',
  magenta: '#CBA6F7',
  cyan: '#94E2D5',
  white: '#BAC2DE',
  brightBlack: '#585B70',
  brightRed: '#F38BA8',
  brightGreen: '#A6E3A1',
  brightYellow: '#F9E2AF',
  brightBlue: '#89B4FA',
  brightMagenta: '#CBA6F7',
  brightCyan: '#94E2D5',
  brightWhite: '#A6ADC8',
}

export default function LogViewer() {
  const [sessions, setSessions] = useState<LogSession[]>([])
  const [selectedSession, setSelectedSession] = useState<LogSession | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<LogEntry[] | null>(null)
  const [expandedConfigs, setExpandedConfigs] = useState<Set<string>>(new Set())
  const termContainerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    loadSessions()
  }, [])

  const loadSessions = async () => {
    const list = await window.electronAPI.logs.list()
    setSessions(list as LogSession[])
    // Auto-expand all config groups
    const configs = new Set(list.map((s: LogSession) => s.configLabel))
    setExpandedConfigs(configs)
  }

  // Set up terminal for displaying log content
  useEffect(() => {
    if (!termContainerRef.current) return
    const container = termContainerRef.current
    let disposed = false
    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let resizeObserver: ResizeObserver | null = null

    const initTerminal = () => {
      if (disposed) return

      // Wait for container to have dimensions
      const rect = container.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        requestAnimationFrame(initTerminal)
        return
      }

      term = new Terminal({
        theme: THEME,
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 100000,
        disableStdin: true,
        cursorStyle: 'bar',
        cursorBlink: false,
        cursorInactiveStyle: 'none',
      })

      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(container)
      termRef.current = term
      fitAddonRef.current = fitAddon

      requestAnimationFrame(() => {
        try { fitAddon?.fit() } catch { /* ignore */ }
      })

      resizeObserver = new ResizeObserver(() => {
        try { fitAddon?.fit() } catch { /* ignore */ }
      })
      resizeObserver.observe(container)
    }

    initTerminal()

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      term?.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [selectedSession])  // Re-init when session changes

  // Load log entries when session is selected (with delay to ensure terminal is ready)
  useEffect(() => {
    if (!selectedSession) return

    // Wait for terminal to be ready
    const checkAndLoad = () => {
      if (termRef.current) {
        loadLogContent(selectedSession)
      } else {
        // Terminal not ready yet, try again
        setTimeout(checkAndLoad, 100)
      }
    }

    // Small delay to let terminal initialize
    setTimeout(checkAndLoad, 200)
  }, [selectedSession])

  const loadLogContent = async (session: LogSession) => {
    const term = termRef.current
    if (!term) return

    term.clear()
    term.write('\x1b[90m--- Loading log for ' + session.sessionId + ' ---\x1b[0m\r\n')

    const { entries } = await window.electronAPI.logs.read(session.logDir, 0, 5000)
    term.clear()

    for (const entry of entries) {
      if (entry.type === 'start') {
        term.write('\x1b[90m--- Session started at ' + new Date(entry.ts).toLocaleString() + ' ---\x1b[0m\r\n')
      } else if (entry.type === 'end') {
        term.write('\x1b[90m--- Session ended at ' + new Date(entry.ts).toLocaleString() + ' ---\x1b[0m\r\n')
      } else if (entry.data) {
        term.write(entry.data)
      }
    }
  }

  const handleSearch = async () => {
    if (!selectedSession || !searchQuery.trim()) {
      setSearchResults(null)
      return
    }
    const results = await window.electronAPI.logs.search(selectedSession.logDir, searchQuery)
    setSearchResults(results as LogEntry[])

    // Write search results to terminal
    const term = termRef.current
    if (!term) return
    term.clear()
    term.write(`\x1b[90m--- Search: "${searchQuery}" (${results.length} matches) ---\x1b[0m\r\n\r\n`)
    for (const entry of results as LogEntry[]) {
      const time = new Date(entry.ts).toLocaleTimeString()
      term.write(`\x1b[36m[${time}]\x1b[0m `)
      if (entry.data) {
        term.write(entry.data.replace(/\r?\n$/, '') + '\r\n')
      }
    }
  }

  const handleCleanup = async () => {
    const cleaned = await window.electronAPI.logs.cleanup(30)
    if (cleaned > 0) {
      loadSessions()
    }
  }

  const toggleConfig = (configLabel: string) => {
    setExpandedConfigs((prev) => {
      const next = new Set(prev)
      if (next.has(configLabel)) next.delete(configLabel)
      else next.add(configLabel)
      return next
    })
  }

  // Group sessions by config
  const grouped = sessions.reduce((acc, s) => {
    if (!acc[s.configLabel]) acc[s.configLabel] = []
    acc[s.configLabel].push(s)
    return acc
  }, {} as Record<string, LogSession[]>)

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + 'B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Sidebar: session list */}
      <div className="w-64 bg-mantle border-r border-surface0 flex flex-col overflow-hidden">
        <div className="p-3 border-b border-surface0 flex items-center justify-between">
          <span className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Session Logs</span>
          <button
            onClick={handleCleanup}
            className="text-xs text-overlay0 hover:text-text px-1.5 py-0.5 rounded hover:bg-surface0"
            title="Clean up logs older than 30 days"
          >
            Cleanup
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {Object.entries(grouped).map(([configLabel, configSessions]) => (
            <div key={configLabel}>
              <button
                onClick={() => toggleConfig(configLabel)}
                className="w-full text-left flex items-center gap-1.5 py-1 px-2 rounded text-xs text-subtext0 hover:bg-surface0/50"
              >
                <span className={`transition-transform ${expandedConfigs.has(configLabel) ? 'rotate-90' : ''}`}>
                  &#9654;
                </span>
                <span className="font-medium">{configLabel}</span>
                <span className="text-overlay0 ml-auto">{configSessions.length}</span>
              </button>
              {expandedConfigs.has(configLabel) && (
                <div className="ml-3 space-y-0.5">
                  {configSessions.map((s) => (
                    <button
                      key={s.sessionId}
                      onClick={() => { setSelectedSession(s); setSearchResults(null) }}
                      className={`w-full text-left py-1.5 px-2 rounded text-xs transition-colors ${
                        selectedSession?.sessionId === s.sessionId
                          ? 'bg-surface0 text-text'
                          : 'text-overlay1 hover:bg-surface0/50 hover:text-text'
                      }`}
                    >
                      <div className="truncate">
                        {s.startTime ? new Date(s.startTime).toLocaleDateString() : 'Unknown'}
                        {' '}
                        {s.startTime ? new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                      </div>
                      <div className="text-overlay0 text-[10px] mt-0.5">
                        {formatSize(s.size)} &middot; {s.sessionId.slice(0, 8)}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="text-xs text-overlay0 text-center py-8">
              No session logs yet.
            </div>
          )}
        </div>
      </div>

      {/* Main content: log viewer */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Search bar */}
        <div className="flex items-center gap-2 px-3 py-2 bg-crust border-b border-surface0 shrink-0">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-overlay0 shrink-0">
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
            <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="flex-1 bg-transparent text-text text-sm outline-none border-none font-mono"
            placeholder={selectedSession ? 'Search in session logs...' : 'Select a session to search'}
            disabled={!selectedSession}
          />
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); setSearchResults(null); if (selectedSession) loadLogContent(selectedSession) }}
              className="text-xs text-overlay0 hover:text-text px-1.5"
            >
              Clear
            </button>
          )}
        </div>

        {/* Terminal display */}
        {selectedSession ? (
          <div ref={termContainerRef} className="flex-1 bg-base p-1" style={{ minHeight: '200px' }} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-overlay1">
              <div className="text-3xl mb-3 font-mono">&#x1F4DC;</div>
              <h3 className="text-lg font-semibold mb-1">Session History</h3>
              <p className="text-sm text-overlay0">Select a session from the list to view its log</p>
            </div>
          </div>
        )}

        {/* Timeline slider */}
        {selectedSession && selectedSession.startTime && selectedSession.endTime && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-crust border-t border-surface0 shrink-0 text-xs text-overlay0">
            <span>{new Date(selectedSession.startTime).toLocaleTimeString()}</span>
            <div className="flex-1 h-1 bg-surface1 rounded-full" />
            <span>{new Date(selectedSession.endTime).toLocaleTimeString()}</span>
          </div>
        )}
      </div>
    </div>
  )
}
