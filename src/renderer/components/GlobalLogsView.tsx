import React, { useCallback, useEffect, useMemo, useState } from 'react'
import PageFrame from './PageFrame'
import LogTree, { type SlotRow } from './LogTree'
import LogEmptyState from './logs/LogEmptyState'
import ChatTranscriptView from './logs/ChatTranscriptView'
import TimelineRail, { type ViewportRange, type SearchHit } from './logs/TimelineRail'
import { useWindowedTurns, type Logs2Scope } from '../hooks/useWindowedTurns'
import { useConfigStore } from '../stores/configStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { resolveAccountNameByEmail } from '../../shared/account-chip-color'

const logsIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <path d="M2 3h12M2 6h10M2 9h12M2 12h8" />
  </svg>
)

/** One FTS hit from logs2.search. */
interface SearchHitRow {
  runId: number
  idx: number
  configId: string | null
  sessionId: string
  snippet: string
}

/**
 * Right pane for a selected slot. Owns the SINGLE useWindowedTurns instance and
 * shares it across the transcript view + the timeline rail (so they drive one
 * window — never a double subscription). The rail's onJump is win.jumpTo; the
 * viewportRange is derived from the first/last mounted message; searchHits feed
 * the rail's markers.
 */
function SlotTranscriptPanel({
  scope,
  searchHits,
  jumpRequest,
}: {
  scope: Logs2Scope
  searchHits: SearchHit[]
  /** A search-hit click; the panel forwards it to the shared hook's jumpTo. */
  jumpRequest: { runId: number; idx: number; seq: number } | null
}) {
  const win = useWindowedTurns(scope)

  // Forward a search-hit jump to the shared hook. The `seq` makes repeated jumps
  // to the same (runId,idx) re-fire.
  useEffect(() => {
    if (!jumpRequest) return
    void win.jumpTo({ runId: jumpRequest.runId, idx: jumpRequest.idx })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpRequest?.seq])

  const viewportRange: ViewportRange | undefined = useMemo(() => {
    const first = win.messages[0]
    const last = win.messages[win.messages.length - 1]
    if (!first || !last) return undefined
    return { startRunId: first.runId, startIdx: first.idx, endRunId: last.runId, endIdx: last.idx }
  }, [win.messages])

  return (
    <div className="flex-1 flex min-w-0 bg-[var(--surface-stage)]">
      <ChatTranscriptView
        messages={win.messages}
        follow={win.follow}
        setFollow={win.setFollow}
        loading={win.loading}
        loadingOlder={win.loadingOlder}
        error={win.error}
        loadOlder={win.loadOlder}
        prependToken={win.prependToken}
        className="flex-1 min-w-0 px-2"
      />
      <TimelineRail
        scope={scope}
        onJump={win.jumpTo}
        searchHits={searchHits}
        viewportRange={viewportRange}
        className="my-2 mr-1.5"
      />
    </div>
  )
}

export default function GlobalLogsView() {
  const loggingEnabled = useSettingsStore((s) => s.settings.loggingEnabled)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const configs = useConfigStore((s) => s.configs)

  const [slots, setSlots] = useState<SlotRow[]>([])
  const [selected, setSelected] = useState<SlotRow | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHitRow[]>([])
  const [jumpRequest, setJumpRequest] = useState<{ runId: number; idx: number; seq: number } | null>(null)
  const [accountFilter, setAccountFilter] = useState('all')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const rows = (await window.electronAPI.logs2.listSlots()) as SlotRow[]
    setSlots(rows)
  }, [])

  useEffect(() => { if (loggingEnabled !== false) void refresh() }, [loggingEnabled, refresh])

  const nameForAccount = useCallback(
    (email: string | null) => (email ? resolveAccountNameByEmail(email, profiles, accountAliases) : null),
    [profiles, accountAliases],
  )

  const liveConfigIds = useMemo(() => new Set(configs.map((c) => c.id)), [configs])

  const filteredSlots = useMemo(
    () => (accountFilter === 'all' ? slots : slots.filter((s) => s.accountEmail === accountFilter)),
    [slots, accountFilter],
  )

  const accounts = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of slots) if (s.accountEmail && !seen.has(s.accountEmail)) seen.set(s.accountEmail, nameForAccount(s.accountEmail) || s.accountEmail)
    return Array.from(seen, ([email, name]) => ({ email, name }))
  }, [slots, nameForAccount])

  // Map a slot to a transcript scope. Prefer the configId; fall back to the
  // slotKey-as-sessionId for an orphan slot with no configId (the worker keys
  // orphan slots by their session-config identity).
  const scopeFor = useCallback((s: SlotRow): Logs2Scope => {
    return s.configId ? { configId: s.configId } : { sessionId: s.slotKey }
  }, [])

  // Debounced FTS search.
  useEffect(() => {
    const q = query.trim()
    if (!q) { setHits([]); return }
    let active = true
    const t = setTimeout(async () => {
      const rows = (await window.electronAPI.logs2.search({ query: q, limit: 100 })) as SearchHitRow[]
      if (active) setHits(rows)
    }, 300)
    return () => { active = false; clearTimeout(t) }
  }, [query])

  // Search hits that belong to the SELECTED slot's scope — used as rail markers.
  const scopedHits = useMemo<SearchHit[]>(() => {
    if (!selected) return []
    if (selected.configId) return hits.filter((h) => h.configId === selected.configId).map((h) => ({ runId: h.runId, idx: h.idx }))
    return hits.filter((h) => h.sessionId === selected.slotKey).map((h) => ({ runId: h.runId, idx: h.idx }))
  }, [hits, selected])

  // Clicking a search hit: select the owning slot (if not already), clear the
  // query so the transcript surface replaces the hit list, then jump to the hit.
  const onSelectHit = useCallback((h: SearchHitRow) => {
    const slot = slots.find((s) => (h.configId ? s.configId === h.configId : s.slotKey === h.sessionId))
    if (slot && slot.slotKey !== selected?.slotKey) setSelected(slot)
    setQuery('')
    setJumpRequest({ runId: h.runId, idx: h.idx, seq: Date.now() })
  }, [slots, selected])

  const onSelectSlot = useCallback((s: SlotRow) => {
    setSelected(s)
    setJumpRequest(null)
  }, [])

  const deleteSlot = useCallback(async (s: SlotRow) => {
    if (busy) return
    // deleteSlot does NOT protect a currently-running run — the worker marks the
    // live tail failed if its slot is deleted mid-run. Honest copy: this removes
    // INDEXED history; Claude's own conversation in ~/.claude/projects remains.
    if (!window.confirm(`Delete indexed history for "${s.configLabel}"? This removes CCC's index for this slot (the conversation in ~/.claude/projects is not affected) and cannot be undone.`)) return
    setBusy(true)
    try {
      await window.electronAPI.logs2.deleteSlot({ scope: scopeFor(s) })
      if (selected?.slotKey === s.slotKey) setSelected(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [busy, scopeFor, selected, refresh])

  const clearAll = useCallback(async () => {
    if (busy) return
    if (!window.confirm('Delete ALL indexed conversation history? This removes CCC\'s index for every slot (your conversations in ~/.claude/projects are not affected) and cannot be undone.')) return
    setBusy(true)
    try {
      await window.electronAPI.logs2.clearAll()
      setSelected(null)
      setQuery('')
      setHits([])
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [busy, refresh])

  if (loggingEnabled === false) {
    return (
      <PageFrame icon={logsIcon} iconAccent="mauve" title="Logs" scrollable={false}>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-[260px]">
            <h3 className="text-sm font-medium text-subtext1 mb-1">Conversation indexing is off</h3>
            <p className="text-xs text-overlay0">Enable session logging in Settings to record and browse your conversations.</p>
          </div>
        </div>
      </PageFrame>
    )
  }

  const headerActions = (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2 bg-surface0/40 rounded-lg border border-surface0/80 px-2.5 py-1 focus-within:border-blue/40 transition-all">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" className="text-overlay0 shrink-0"><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" /><line x1="9.5" y1="9.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.2" /></svg>
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all conversations" className="bg-transparent text-text text-xs outline-none border-none placeholder:text-overlay0 font-mono w-48" />
      </div>
      <button onClick={() => void clearAll()} disabled={busy} className="px-2.5 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-red/10 hover:text-red hover:border-red/40 transition-colors disabled:opacity-50" title="Delete all indexed history (conversations in ~/.claude are not affected)">
        Clear all
      </button>
    </div>
  )

  return (
    <PageFrame icon={logsIcon} iconAccent="mauve" title="Logs" context={`${slots.length} slot${slots.length !== 1 ? 's' : ''} indexed`} actions={headerActions} scrollable={false}>
      <div className="flex-1 flex overflow-hidden">
        <LogTree
          slots={filteredSlots}
          liveConfigIds={liveConfigIds}
          selectedKey={selected?.slotKey ?? null}
          onSelect={onSelectSlot}
          onDeleteSlot={(s) => void deleteSlot(s)}
          nameForAccount={nameForAccount}
          accounts={accounts}
          accountFilter={accountFilter}
          onAccountFilter={setAccountFilter}
        />
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {query.trim() ? (
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              {hits.length === 0 ? (
                <div className="flex-1 flex items-center justify-center bg-[var(--surface-stage)]">
                  <p className="text-xs text-overlay0">No matches.</p>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto bg-[var(--surface-stage)] p-2 space-y-1">
                  {hits.map((h, i) => (
                    <button
                      key={`${h.sessionId}:${h.runId}:${h.idx}:${i}`}
                      onClick={() => onSelectHit(h)}
                      className="w-full text-left rounded-md px-3 py-2 bg-surface0/40 hover:bg-surface0/70 border border-transparent hover:border-surface1 transition-colors"
                    >
                      <div className="flex items-center gap-2 text-[10px] text-overlay0">
                        <span className="text-text font-medium truncate">
                          {slots.find((s) => (h.configId ? s.configId === h.configId : s.slotKey === h.sessionId))?.configLabel ?? h.sessionId.slice(0, 8)}
                        </span>
                      </div>
                      {h.snippet && <div className="text-[11px] text-subtext0 font-mono truncate mt-0.5">{h.snippet}</div>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : selected ? (
            <SlotTranscriptPanel
              key={selected.slotKey}
              scope={scopeFor(selected)}
              searchHits={scopedHits}
              jumpRequest={jumpRequest}
            />
          ) : (
            <LogEmptyState reason="select" />
          )}
        </div>
      </div>
    </PageFrame>
  )
}
