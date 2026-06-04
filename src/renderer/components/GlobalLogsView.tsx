import React, { useCallback, useEffect, useMemo, useState } from 'react'
import PageFrame from './PageFrame'
import LogReplay from './LogReplay'
import LogTree from './LogTree'
import LogSearch, { type SearchHitRow } from './LogSearch'
import { groupSessionsByConfig, type LogSessionRow, type ConfigGroup, type GroupedSession } from '../lib/groupSessions'
import { useConfigStore } from '../stores/configStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { resolveAccountNameByEmail } from '../../shared/account-chip-color'

const logsIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <path d="M2 3h12M2 6h10M2 9h12M2 12h8" />
  </svg>
)

export default function GlobalLogsView() {
  const loggingEnabled = useSettingsStore((s) => s.settings.loggingEnabled)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const configs = useConfigStore((s) => s.configs)

  const [sessions, setSessions] = useState<LogSessionRow[]>([])
  const [selected, setSelected] = useState<GroupedSession | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHitRow[]>([])
  const [seekSeq, setSeekSeq] = useState<number | undefined>(undefined)
  const [accountFilter, setAccountFilter] = useState('all')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const rows = (await window.electronAPI.logsdb.listSessions({ offset: 0, limit: 2000 })) as LogSessionRow[]
    setSessions(rows)
  }, [])

  useEffect(() => { if (loggingEnabled !== false) void refresh() }, [loggingEnabled, refresh])

  const nameForAccount = useCallback(
    (email: string | null) => (email ? resolveAccountNameByEmail(email, profiles, accountAliases) : null),
    [profiles, accountAliases],
  )

  const liveSet = useMemo(() => new Set(configs.map((c) => c.id)), [configs])
  const liveLabels = useMemo(() => new Map(configs.map((c) => [c.id, c.label] as const)), [configs])

  const filteredSessions = useMemo(
    () => (accountFilter === 'all' ? sessions : sessions.filter((s) => s.accountEmail === accountFilter)),
    [sessions, accountFilter],
  )
  const { groups, orphaned } = useMemo(
    () => groupSessionsByConfig(filteredSessions, liveSet, liveLabels),
    [filteredSessions, liveSet, liveLabels],
  )

  const accounts = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of sessions) if (s.accountEmail && !seen.has(s.accountEmail)) seen.set(s.accountEmail, nameForAccount(s.accountEmail) || s.accountEmail)
    return Array.from(seen, ([email, name]) => ({ email, name }))
  }, [sessions, nameForAccount])

  const labelById = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s.configLabel])), [sessions])
  const emailById = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s.accountEmail])), [sessions])

  useEffect(() => {
    const q = query.trim()
    if (!q) { setHits([]); return }
    const t = setTimeout(async () => {
      const rows = (await window.electronAPI.logsdb.search(q, 100)) as SearchHitRow[]
      setHits(rows)
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  const onSelectHit = useCallback((h: SearchHitRow) => {
    const row = sessions.find((s) => s.sessionId === h.sessionId)
    if (row) { setSelected({ ...row, legacy: row.configId == null }); setSeekSeq(h.seq) }
  }, [sessions])

  const broadcastDeleted = (ids: string[]) =>
    window.dispatchEvent(new CustomEvent('logs:sessionsDeleted', { detail: { sessionIds: ids } }))

  const confirmAndRun = useCallback(
    async (message: string, ids: string[] | null /* null = clearAll */) => {
      if (busy) return
      if (!window.confirm(message)) return
      setBusy(true)
      try {
        const res = ids
          ? await window.electronAPI.logsdb.prune(ids)
          : await window.electronAPI.logsdb.clearAll()
        broadcastDeleted(ids ?? sessions.map((s) => s.sessionId))
        if (selected && (ids ? ids.includes(selected.sessionId) : true)) setSelected(null)
        await refresh()
        window.alert(`Deleted ${res.deletedSessions} session(s), ${res.deletedEvents} event(s). Active sessions are kept.`)
      } finally {
        setBusy(false)
      }
    },
    [busy, sessions, selected, refresh],
  )

  const deleteGroup = useCallback((g: ConfigGroup) => {
    const deletable = g.sessions.filter((s) => s.status !== 'running').map((s) => s.sessionId)
    void confirmAndRun(`Permanently delete ${deletable.length} log(s) under "${g.configLabel}"? This cannot be undone. Active sessions are kept.`, deletable)
  }, [confirmAndRun])

  const deleteOrphaned = useCallback(() => {
    const deletable = orphaned.filter((s) => s.status !== 'running').map((s) => s.sessionId)
    void confirmAndRun(`Permanently delete ${deletable.length} orphaned log(s)? This cannot be undone. Active sessions are kept.`, deletable)
  }, [orphaned, confirmAndRun])

  const clearAll = useCallback(() => {
    void confirmAndRun('Permanently delete ALL session logs? This cannot be undone. Active sessions are kept.', null)
  }, [confirmAndRun])

  if (loggingEnabled === false) {
    return (
      <PageFrame icon={logsIcon} iconAccent="mauve" title="Logs" scrollable={false}>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-[260px]">
            <h3 className="text-sm font-medium text-subtext1 mb-1">Session logging is off</h3>
            <p className="text-xs text-overlay0">Enable session logging in Settings to record and browse your sessions.</p>
          </div>
        </div>
      </PageFrame>
    )
  }

  const headerActions = (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2 bg-surface0/40 rounded-lg border border-surface0/80 px-2.5 py-1 focus-within:border-blue/40 transition-all">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" className="text-overlay0 shrink-0"><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" /><line x1="9.5" y1="9.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.2" /></svg>
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all logs" className="bg-transparent text-text text-xs outline-none border-none placeholder:text-overlay0 font-mono w-48" />
      </div>
      <button onClick={clearAll} disabled={busy} className="px-2.5 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-red/10 hover:text-red hover:border-red/40 transition-colors disabled:opacity-50" title="Permanently delete all logs (active sessions kept)">
        Clear all
      </button>
    </div>
  )

  return (
    <PageFrame icon={logsIcon} iconAccent="mauve" title="Logs" context={`${sessions.length} session${sessions.length !== 1 ? 's' : ''} recorded`} actions={headerActions} scrollable={false}>
      <div className="flex-1 flex overflow-hidden">
        <LogTree
          groups={groups}
          orphaned={orphaned}
          selectedId={selected?.sessionId ?? null}
          onSelect={(s) => { setSelected(s); setSeekSeq(undefined); setQuery('') }}
          onDeleteGroup={deleteGroup}
          onDeleteOrphaned={deleteOrphaned}
          nameForAccount={nameForAccount}
          accounts={accounts}
          accountFilter={accountFilter}
          onAccountFilter={setAccountFilter}
        />
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {query.trim() ? (
            <LogSearch
              hits={hits}
              labelForSession={(id) => labelById.get(id) ?? id.slice(0, 8)}
              accountForSession={(id) => nameForAccount(emailById.get(id) ?? null)}
              onSelectHit={onSelectHit}
            />
          ) : selected ? (
            <LogReplay key={selected.sessionId + ':' + (seekSeq ?? 'top')} sessionId={selected.sessionId} seekToSeq={seekSeq} eventCount={selected.eventCount} />
          ) : (
            <div className="flex-1 flex items-center justify-center bg-surface-stage">
              <p className="text-xs text-overlay0 max-w-[220px] text-center">Select a session from the left to replay its log, or search across everything above.</p>
            </div>
          )}
        </div>
      </div>
    </PageFrame>
  )
}
