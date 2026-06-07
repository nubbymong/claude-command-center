import React, { useMemo } from 'react'

/** One flat slot row (mirrors logs2.listSlots item). */
export interface SlotRow {
  slotKey: string
  configId: string | null
  configLabel: string
  accountEmail: string | null
  lastActive: number
  runCount: number
  messageCount: number
}

interface Props {
  slots: SlotRow[]
  /** Live config ids — a slot whose configId is absent here is "orphaned". */
  liveConfigIds: Set<string>
  selectedKey: string | null
  onSelect: (slot: SlotRow) => void
  onDeleteSlot: (slot: SlotRow) => void
  nameForAccount: (email: string | null) => string | null
  accounts: { email: string; name: string }[]
  accountFilter: string
  onAccountFilter: (v: string) => void
}

/**
 * Flat Logs tree (Logs v2): exactly ONE row per config slot — never per-run
 * children (spec decision 4). A header groups live slots; slots with no live
 * config (configId null OR a dead/removed configId) collect under "Orphaned",
 * matching groupSessions.ts's orphan-bucket rule (configId not in the live set).
 * Selecting a row scopes the right-pane transcript to that slot's configId.
 */
export default function LogTree({
  slots,
  liveConfigIds,
  selectedKey,
  onSelect,
  onDeleteSlot,
  nameForAccount,
  accounts,
  accountFilter,
  onAccountFilter,
}: Props) {
  // Classify flat slots into live vs orphaned applying the same live/orphan rule
  // as groupSessions.ts (configId present AND still live -> live group; otherwise
  // -> Orphaned). Deliberate inline reimplementation: the flat one-slot-per-config
  // layout makes the legacy label-attach branch in groupSessions.ts inapplicable.
  const { live, orphaned } = useMemo(() => {
    const liveRows: SlotRow[] = []
    const orphanRows: SlotRow[] = []
    for (const s of slots) {
      if (s.configId && liveConfigIds.has(s.configId)) liveRows.push(s)
      else orphanRows.push(s)
    }
    const newestFirst = (a: SlotRow, b: SlotRow) => b.lastActive - a.lastActive
    liveRows.sort(newestFirst)
    orphanRows.sort(newestFirst)
    return { live: liveRows, orphaned: orphanRows }
  }, [slots, liveConfigIds])

  const slotRow = (s: SlotRow) => {
    const active = selectedKey === s.slotKey
    const accountName = nameForAccount(s.accountEmail)
    return (
      <div
        key={s.slotKey}
        className={`group/row w-full flex items-stretch rounded-md transition-all ${active ? 'bg-surface0/70 border-l-2 border-l-mauve' : 'hover:bg-surface0/30 border-l-2 border-l-transparent'}`}
      >
        <button onClick={() => onSelect(s)} className="flex-1 min-w-0 text-left px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-text truncate font-medium">{s.configLabel}</span>
            {!s.configId && <span className="text-[9px] uppercase tracking-wide text-overlay0 bg-surface0/70 rounded px-1 shrink-0">orphan</span>}
          </div>
          {accountName && (
            <div className="text-[10px] text-overlay1 truncate mt-0.5" title={s.accountEmail ?? undefined}>{accountName}</div>
          )}
          <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-overlay0">
            <span>{new Date(s.lastActive).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <span className="text-overlay0/30">{String.fromCodePoint(0x00B7)}</span>
            <span className="tabular-nums">{s.messageCount} msg</span>
            {s.runCount > 1 && (
              <>
                <span className="text-overlay0/30">{String.fromCodePoint(0x00B7)}</span>
                <span className="tabular-nums">{s.runCount} runs</span>
              </>
            )}
          </div>
        </button>
        <button
          onClick={() => onDeleteSlot(s)}
          title="Delete this slot's indexed history (permanent)"
          className="px-2 text-overlay0 opacity-0 group-hover/row:opacity-100 hover:text-red transition-all shrink-0"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M3 4h10M6 4V3h4v1M5 4l.5 9h5L11 4" /></svg>
        </button>
      </div>
    )
  }

  const sectionHeader = (label: string, count: number) => (
    <div className="w-full flex items-center gap-1.5 px-3 py-1.5">
      <span className="flex-1 min-w-0 text-[10px] font-semibold text-overlay0 uppercase tracking-wider truncate">{label}</span>
      <span className="text-overlay0/50 shrink-0 text-[10px]">{count}</span>
    </div>
  )

  return (
    <div className="w-56 bg-mantle/30 border-r border-surface0/60 flex flex-col overflow-hidden shrink-0">
      {accounts.length > 1 && (
        <div className="p-2 border-b border-surface0/40">
          <select value={accountFilter} onChange={(e) => onAccountFilter(e.target.value)} className="w-full bg-surface0/30 rounded-md px-2 py-1.5 text-[11px] text-text outline-none border border-transparent focus:border-surface1 transition-colors" title="Filter by account">
            <option value="all">All accounts</option>
            {accounts.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
          </select>
        </div>
      )}
      <div className="flex-1 overflow-y-auto py-1">
        {live.length > 0 && (
          <div>
            {sectionHeader('Sessions', live.length)}
            <div className="space-y-0.5 px-1.5 mb-1">{live.map(slotRow)}</div>
          </div>
        )}
        {orphaned.length > 0 && (
          <div>
            {sectionHeader('Orphaned', orphaned.length)}
            <div className="space-y-0.5 px-1.5 mb-1">{orphaned.map(slotRow)}</div>
          </div>
        )}
        {live.length === 0 && orphaned.length === 0 && (
          <div className="px-4 py-10 text-center">
            <p className="text-[11px] text-overlay0">No conversations yet</p>
            <p className="text-[10px] text-overlay0/60 mt-1">Slots appear as Claude sessions run</p>
          </div>
        )}
      </div>
    </div>
  )
}
