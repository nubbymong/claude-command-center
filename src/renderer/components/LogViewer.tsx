import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import PageFrame from './PageFrame'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { resolveAccountNameByEmail } from '../../shared/account-chip-color'

interface LogSession {
  configLabel: string
  sessionId: string
  logDir: string
  startTime?: number
  endTime?: number
  size: number
  accountEmail?: string
  profileId?: string
}

interface LogEntry {
  ts: number
  type: string
  data?: string
}

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export function buildLogTheme() {
  return {
    background:          readVar('--surface-stage', '#0f1218'),
    foreground:          readVar('--terminal-foreground', '#b8c5d6'),
    cursor:              readVar('--text-primary', '#F5E0DC'),
    cursorAccent:        readVar('--surface-stage', '#0f1218'),
    selectionBackground: readVar('--surface-overlay', '#2a3342'),
    selectionForeground: readVar('--text-primary', '#f0f4fc'),
    black:        readVar('--surface-overlay', '#2a3342'),
    red:          readVar('--status-danger', '#F38BA8'),
    green:        readVar('--status-success', '#A6E3A1'),
    yellow:       readVar('--status-warning', '#F9E2AF'),
    blue:         readVar('--status-info', '#89B4FA'),
    magenta:      readVar('--chart-other', '#CBA6F7'),
    cyan:         readVar('--accent', '#94E2D5'),
    white:        readVar('--text-secondary', '#b8c5d6'),
    brightBlack:  readVar('--text-muted', '#4a5568'),
    brightRed:    readVar('--status-danger', '#F38BA8'),
    brightGreen:  readVar('--status-success', '#A6E3A1'),
    brightYellow: readVar('--status-warning', '#F9E2AF'),
    brightBlue:   readVar('--status-info', '#89B4FA'),
    brightMagenta:readVar('--chart-other', '#CBA6F7'),
    brightCyan:   readVar('--accent', '#94E2D5'),
    brightWhite:  readVar('--text-primary', '#f0f4fc'),
  }
}

function getDateGroup(ts?: number): string {
  if (!ts) return 'Unknown'
  const now = new Date()
  const date = new Date(ts)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const weekAgo = new Date(today.getTime() - 7 * 86400000)
  if (date >= today) return 'Today'
  if (date >= yesterday) return 'Yesterday'
  if (date >= weekAgo) return 'This Week'
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
}

export function computeFilterDiff(before: number[], after: number[]): { added: number[]; removed: number[] } {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    added: after.filter(i => !beforeSet.has(i)),
    removed: before.filter(i => !afterSet.has(i)),
  }
}

function writeEntry(term: { write: (s: string) => void }, entry: LogEntry) {
  if (entry.type === 'start') {
    const time = new Date(entry.ts).toLocaleString()
    term.write(`\x1b[32m${String.fromCodePoint(0x25B6)}\x1b[90m Session started ${time}\x1b[0m\r\n`)
  } else if (entry.type === 'end') {
    const time = new Date(entry.ts).toLocaleString()
    term.write(`\x1b[31m${String.fromCodePoint(0x25A0)}\x1b[90m Session ended ${time}\x1b[0m\r\n`)
  } else if (entry.data) {
    term.write(entry.data)
  }
}

export default function LogViewer() {
  const [sessions, setSessions] = useState<LogSession[]>([])
  const [selectedSession, setSelectedSession] = useState<LogSession | null>(null)
  const [sessionFilter, setSessionFilter] = useState('')
  const [accountFilter, setAccountFilter] = useState<string>('all')

  // Account naming: resolve a session's accountEmail to its friendly name via the
  // shared single-source resolver (profile name > alias > raw email).
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const nameForAccount = useCallback(
    (email?: string) => (email ? resolveAccountNameByEmail(email, profiles, accountAliases) : null),
    [profiles, accountAliases],
  )
  // Distinct accounts present in the recorded logs (drives the account filter,
  // shown only when more than one account appears).
  const logAccounts = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of sessions) {
      if (s.accountEmail && !seen.has(s.accountEmail)) {
        seen.set(s.accountEmail, nameForAccount(s.accountEmail) || s.accountEmail)
      }
    }
    return Array.from(seen, ([email, name]) => ({ email, name }))
  }, [sessions, nameForAccount])
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // Search/filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [useRegex, setUseRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [typeFilter, setTypeFilter] = useState<'all' | 'events' | 'output'>('all')

  // Entries
  const [allEntries, setAllEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const PAGE_LIMIT = 500
  const [loadedOffset, setLoadedOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)

  // Terminal
  const termContainerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const prevFilterRef = useRef<number[]>([])

  // Load sessions on mount
  useEffect(() => {
    loadSessions()
  }, [])

  // Keyboard shortcut: Ctrl+F focuses search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
      if (e.key === 'Escape' && document.activeElement === searchInputRef.current) {
        searchInputRef.current?.blur()
        if (searchQuery) setSearchQuery('')
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [searchQuery])

  const loadSessions = async () => {
    const list = await window.electronAPI.logs.list()
    setSessions(list as LogSession[])
    const groups = new Set((list as LogSession[]).map(s => getDateGroup(s.startTime)))
    setExpandedGroups(groups)
  }

  // Terminal setup (re-init when session changes)
  useEffect(() => {
    if (!termContainerRef.current) return
    const container = termContainerRef.current
    let disposed = false
    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let resizeObserver: ResizeObserver | null = null

    const initTerminal = () => {
      if (disposed) return
      const rect = container.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        requestAnimationFrame(initTerminal)
        return
      }

      term = new Terminal({
        theme: buildLogTheme(),
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 10000,
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
  }, [selectedSession])

  // Load entries when session selected (chunked: 500 per page)
  useEffect(() => {
    if (!selectedSession) { setAllEntries([]); setLoadedOffset(0); setHasMore(false); return }
    setLoading(true)
    let cancelled = false
    const load = async () => {
      const { entries, hasMore: more } = await window.electronAPI.logs.read(selectedSession.logDir, 0, PAGE_LIMIT)
      if (cancelled) return
      setAllEntries(entries as LogEntry[])
      setLoadedOffset((entries as LogEntry[]).length)
      setHasMore(!!more)
      setLoading(false)
    }
    const waitForTerm = () => { if (termRef.current) load(); else setTimeout(waitForTerm, 100) }
    setTimeout(waitForTerm, 150)
    return () => { cancelled = true }
  }, [selectedSession])

  const loadMore = useCallback(async () => {
    if (!selectedSession || !hasMore) return
    const { entries, hasMore: more } = await window.electronAPI.logs.read(selectedSession.logDir, loadedOffset, PAGE_LIMIT)
    setAllEntries(prev => prev.concat(entries as LogEntry[]))
    setLoadedOffset(prev => prev + (entries as LogEntry[]).length)
    setHasMore(!!more)
  }, [selectedSession, loadedOffset, hasMore])

  // Validate regex
  const regexError = useMemo(() => {
    if (!useRegex || !searchQuery.trim()) return null
    try {
      new RegExp(searchQuery)
      return null
    } catch (err: any) {
      return err.message?.split(':').pop()?.trim() || 'Invalid regex'
    }
  }, [searchQuery, useRegex])

  // Filter entries to indices (index-based, diff-aware)
  const filteredIndices = useMemo(() => {
    const out: number[] = []
    for (let i = 0; i < allEntries.length; i++) {
      const e = allEntries[i]
      if (typeFilter === 'events' && !(e.type === 'start' || e.type === 'end')) continue
      if (typeFilter === 'output' && (e.type === 'start' || e.type === 'end')) continue
      if (searchQuery.trim() && !regexError) {
        const text = e.data || ''
        const matched = useRegex
          ? (() => { try { return new RegExp(searchQuery, caseSensitive ? '' : 'i').test(text) } catch { return false } })()
          : (caseSensitive ? text.includes(searchQuery) : text.toLowerCase().includes(searchQuery.toLowerCase()))
        if (!matched) continue
      }
      out.push(i)
    }
    return out
  }, [allEntries, searchQuery, useRegex, caseSensitive, typeFilter, regexError])

  // Render filtered entries to terminal (diff-aware: append-only when possible)
  useEffect(() => {
    const term = termRef.current
    if (!term || loading) return
    const diff = computeFilterDiff(prevFilterRef.current, filteredIndices)
    const sizeBefore = prevFilterRef.current.length
    const fullRepaint =
      sizeBefore === 0 ||
      diff.removed.length > 0 ||
      Math.abs(filteredIndices.length - sizeBefore) > sizeBefore * 0.25

    if (fullRepaint) {
      term.clear()
      const hasFilters = searchQuery.trim() || typeFilter !== 'all'
      if (filteredIndices.length === 0 && allEntries.length > 0) {
        term.write('\x1b[90m  No matching entries\x1b[0m\r\n')
      } else if (hasFilters && allEntries.length > 0) {
        term.write(`\x1b[90m  Showing ${filteredIndices.length} of ${allEntries.length} entries\x1b[0m\r\n\r\n`)
      }
      for (const idx of filteredIndices) writeEntry(term, allEntries[idx])
    } else {
      for (const idx of diff.added) writeEntry(term, allEntries[idx])
    }
    prevFilterRef.current = filteredIndices
  }, [filteredIndices, loading, allEntries, searchQuery, typeFilter])

  // Group sessions for sidebar (date groups + filter)
  const groupedSessions = useMemo(() => {
    let filtered = sessions
    if (accountFilter !== 'all') {
      filtered = filtered.filter(s => s.accountEmail === accountFilter)
    }
    if (sessionFilter) {
      const q = sessionFilter.toLowerCase()
      filtered = filtered.filter(s =>
        s.configLabel.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q) ||
        (s.accountEmail?.toLowerCase().includes(q) ?? false) ||
        (nameForAccount(s.accountEmail)?.toLowerCase().includes(q) ?? false)
      )
    }

    const groups: Record<string, LogSession[]> = {}
    const order: string[] = []

    for (const s of filtered) {
      const group = getDateGroup(s.startTime)
      if (!groups[group]) {
        groups[group] = []
        order.push(group)
      }
      groups[group].push(s)
    }

    return { groups, order }
  }, [sessions, sessionFilter, accountFilter, nameForAccount])

  const toggleGroup = (group: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  const handleCleanup = async () => {
    const cleaned = await window.electronAPI.logs.cleanup(30)
    if (cleaned > 0) loadSessions()
  }

  const clearFilters = () => {
    setSearchQuery('')
    setTypeFilter('all')
  }

  const hasActiveFilters = searchQuery.trim() !== '' || typeFilter !== 'all'
  const totalEntries = allEntries.length
  const matchCount = filteredIndices.length

  const logsIcon = (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M2 3h12M2 6h10M2 9h12M2 12h8" />
    </svg>
  )

  const logsContext = (
    <>
      {sessions.length} session{sessions.length !== 1 ? 's' : ''} recorded
      {selectedSession && <> · viewing <span className="text-overlay1">{selectedSession.configLabel}</span></>}
    </>
  )

  const logsActions = (
    <button
      onClick={handleCleanup}
      className="px-2.5 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 hover:text-text transition-colors"
      title="Remove logs older than 30 days"
    >
      Cleanup
    </button>
  )

  return (
    <PageFrame
      icon={logsIcon}
      iconAccent="mauve"
      title="Logs"
      context={logsContext}
      actions={logsActions}
      scrollable={false}
    >
      {/* Search & filter bar */}
      <div className="px-4 py-2 bg-crust/40 border-b border-surface0/60 shrink-0">
        <div className="flex items-center gap-2">
          {/* Search input */}
          <div className="flex-1 flex items-center gap-2 bg-surface0/40 rounded-lg border border-surface0/80 px-2.5 py-1.5 focus-within:border-blue/40 transition-all">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" className="text-overlay0 shrink-0">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
              <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent text-text text-xs outline-none border-none placeholder:text-overlay0 font-mono min-w-0"
              placeholder={selectedSession ? (useRegex ? 'Regex pattern...' : 'Search log entries... (Ctrl+F)') : 'Select a session first'}
              disabled={!selectedSession}
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="text-overlay0 hover:text-text transition-colors shrink-0">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <line x1="3" y1="3" x2="9" y2="9" /><line x1="9" y1="3" x2="3" y2="9" />
                </svg>
              </button>
            )}
          </div>

          {/* Regex toggle */}
          <button
            onClick={() => setUseRegex(!useRegex)}
            disabled={!selectedSession}
            className={`px-2 py-1.5 rounded-lg text-[11px] font-mono font-bold transition-all shrink-0 ${
              useRegex
                ? 'bg-mauve/15 text-mauve border border-mauve/30'
                : 'text-overlay0 hover:text-overlay1 hover:bg-surface0/40 border border-transparent disabled:opacity-30'
            }`}
            title="Toggle regex (.*)"
          >
            .*
          </button>

          {/* Case toggle */}
          <button
            onClick={() => setCaseSensitive(!caseSensitive)}
            disabled={!selectedSession}
            className={`px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-all shrink-0 ${
              caseSensitive
                ? 'bg-blue/15 text-blue border border-blue/30'
                : 'text-overlay0 hover:text-overlay1 hover:bg-surface0/40 border border-transparent disabled:opacity-30'
            }`}
            title="Toggle case sensitivity"
          >
            Aa
          </button>

          <div className="w-px h-5 bg-surface0/80 shrink-0" />

          {/* Type filter chips */}
          {(['all', 'events', 'output'] as const).map(type => (
            <button
              key={type}
              onClick={() => setTypeFilter(type)}
              disabled={!selectedSession}
              className={`px-2.5 py-1 rounded-full text-[10px] font-medium transition-all shrink-0 ${
                typeFilter === type
                  ? 'bg-surface1 text-text'
                  : 'text-overlay0 hover:text-overlay1 hover:bg-surface0/30 disabled:opacity-30'
              }`}
            >
              {type === 'all' ? 'All' : type === 'events' ? 'Events' : 'Output'}
            </button>
          ))}

          {/* Match count */}
          {hasActiveFilters && selectedSession && !loading && (
            <>
              <div className="w-px h-5 bg-surface0/80 shrink-0" />
              <span className={`text-[10px] tabular-nums shrink-0 ${matchCount === 0 ? 'text-red' : 'text-overlay1'}`}>
                {matchCount}{totalEntries > 0 ? `/${totalEntries}` : ''}
              </span>
              <button
                onClick={clearFilters}
                className="text-[10px] text-overlay0 hover:text-text transition-colors shrink-0"
              >
                Clear
              </button>
            </>
          )}
        </div>

        {/* Regex error */}
        {regexError && (
          <div className="mt-1.5 text-[10px] text-red flex items-center gap-1.5">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="shrink-0">
              <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1.2" />
              <line x1="5" y1="3" x2="5" y2="5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <circle cx="5" cy="7.5" r="0.5" fill="currentColor" />
            </svg>
            {regexError}
          </div>
        )}
      </div>

      {/* Main split */}
      <div className="flex-1 flex overflow-hidden">
        {/* Session sidebar */}
        <div className="w-56 bg-mantle/30 border-r border-surface0/60 flex flex-col overflow-hidden shrink-0">
          {/* Session search */}
          <div className="p-2 border-b border-surface0/40 space-y-2">
            <input
              type="text"
              value={sessionFilter}
              onChange={e => setSessionFilter(e.target.value)}
              className="w-full bg-surface0/30 rounded-md px-2.5 py-1.5 text-[11px] text-text placeholder:text-overlay0 outline-none border border-transparent focus:border-surface1 transition-colors"
              placeholder="Filter sessions..."
            />
            {logAccounts.length > 1 && (
              <select
                value={accountFilter}
                onChange={e => setAccountFilter(e.target.value)}
                className="w-full bg-surface0/30 rounded-md px-2 py-1.5 text-[11px] text-text outline-none border border-transparent focus:border-surface1 transition-colors"
                title="Filter sessions by account"
              >
                <option value="all">All accounts</option>
                {logAccounts.map(a => (
                  <option key={a.email} value={a.email}>{a.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Session list grouped by date */}
          <div className="flex-1 overflow-y-auto py-1">
            {groupedSessions.order.map(group => (
              <div key={group}>
                <button
                  onClick={() => toggleGroup(group)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold text-overlay0 uppercase tracking-wider hover:text-overlay1 transition-colors"
                >
                  <svg
                    width="8" height="8" viewBox="0 0 8 8" fill="currentColor"
                    className={`transition-transform shrink-0 ${expandedGroups.has(group) ? 'rotate-90' : ''}`}
                  >
                    <polygon points="2,0 7,4 2,8" />
                  </svg>
                  <span className="truncate">{group}</span>
                  <span className="ml-auto text-overlay0/50 shrink-0">{groupedSessions.groups[group].length}</span>
                </button>
                {expandedGroups.has(group) && (
                  <div className="space-y-0.5 px-1.5 mb-1">
                    {groupedSessions.groups[group].map(s => {
                      const active = selectedSession?.sessionId === s.sessionId
                      return (
                        <button
                          key={s.sessionId}
                          onClick={() => { setSelectedSession(s); clearFilters() }}
                          className={`w-full text-left rounded-md px-2.5 py-2 transition-all ${
                            active
                              ? 'bg-surface0/70 border-l-2 border-l-mauve'
                              : 'hover:bg-surface0/30 border-l-2 border-l-transparent'
                          }`}
                        >
                          <div className="text-[11px] text-text truncate font-medium">{s.configLabel}</div>
                          {nameForAccount(s.accountEmail) && (
                            <div className="text-[10px] text-overlay1 truncate mt-0.5" title={s.accountEmail}>
                              {nameForAccount(s.accountEmail)}
                            </div>
                          )}
                          <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-overlay0">
                            <span>
                              {s.startTime
                                ? new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                : 'Unknown'}
                            </span>
                            <span className="text-overlay0/30">{String.fromCodePoint(0x00B7)}</span>
                            <span>{formatSize(s.size)}</span>
                            <span className="text-overlay0/30">{String.fromCodePoint(0x00B7)}</span>
                            <span className="font-mono">{s.sessionId.slice(0, 6)}</span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
            {sessions.length === 0 && (
              <div className="px-4 py-10 text-center">
                <p className="text-[11px] text-overlay0">No session logs yet</p>
                <p className="text-[10px] text-overlay0/60 mt-1">Logs appear after running sessions</p>
              </div>
            )}
            {sessions.length > 0 && groupedSessions.order.length === 0 && sessionFilter && (
              <div className="px-4 py-6 text-center">
                <p className="text-[11px] text-overlay0">No matching sessions</p>
              </div>
            )}
          </div>
        </div>

        {/* Main terminal area */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {selectedSession ? (
            <>
              {loading ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="flex items-center gap-2.5 text-overlay1">
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
                    </svg>
                    <span className="text-xs">Loading entries...</span>
                  </div>
                </div>
              ) : (
                <div ref={termContainerRef} className="flex-1 bg-base log-list-enter" style={{ minHeight: '200px' }} />
              )}

              {/* Bottom info bar */}
              {selectedSession.startTime && (
                <div className="flex items-center gap-3 px-4 py-1.5 bg-crust/40 border-t border-surface0/40 shrink-0">
                  <span className="text-[10px] text-overlay0 tabular-nums shrink-0">
                    {new Date(selectedSession.startTime).toLocaleString()}
                  </span>
                  <div className="flex-1 h-px bg-surface0/50 relative">
                    <div className="absolute inset-0 bg-mauve/20 rounded-full" />
                  </div>
                  {selectedSession.endTime && (
                    <span className="text-[10px] text-overlay0 tabular-nums shrink-0">
                      {new Date(selectedSession.endTime).toLocaleTimeString()}
                    </span>
                  )}
                  <span className="text-[10px] text-overlay0/50 shrink-0">{formatSize(selectedSession.size)}</span>
                  <span className="text-[10px] text-overlay0/50 font-mono shrink-0">{selectedSession.sessionId.slice(0, 8)}</span>
                </div>
              )}
              {hasMore && !loading && (
                <button
                  onClick={loadMore}
                  className="text-[10px] text-overlay1 hover:text-text px-3 py-1.5 border-t border-surface0/40 bg-crust/30"
                >
                  Load older entries...
                </button>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-surface0/30 flex items-center justify-center">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-overlay0">
                    <path d="M4 6h16M4 10h12M4 14h16M4 18h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </div>
                <h3 className="text-sm font-medium text-subtext1 mb-1">Session Logs</h3>
                <p className="text-xs text-overlay0 max-w-[200px]">Select a session from the sidebar to explore its log entries</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </PageFrame>
  )
}
