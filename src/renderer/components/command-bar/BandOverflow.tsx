import React from 'react'
import type { CustomCommand, CommandSection } from '../../stores/commandStore'
import type { SessionCapabilities } from '../../lib/session-capabilities'
import { CommandIcon } from '../command-icons'
import { DEFAULT_COMMAND_COLOR } from '../../lib/command-swatches'
import { TargetMark } from './chips'
import { clusterOf, type BandPlan } from './layout'

interface Props {
  plan: BandPlan
  /** The chips that did not fit on the row (in row order). */
  folded: CustomCommand[]
  caps: SessionCapabilities
  anchor: DOMRect
  onRun: (cmd: CustomCommand, e: React.MouseEvent) => void
  onContextMenu: (cmd: CustomCommand, e: React.MouseEvent) => void
  onManage: () => void
  onClose: () => void
}

/**
 * The "N more" popover for one band (ADR-018 D8): everything that did not fit,
 * grouped by the user's sections, plus the buttons that cannot run in this
 * session -- greyed, with the reason on the row, never hidden silently (D5).
 * A filter box appears once there is enough to filter. Keyboard: type to
 * filter, Up/Down to move, Enter runs, Escape returns focus to the pill.
 */
export default function BandOverflow({ plan, folded, caps, anchor, onRun, onContextMenu, onManage, onClose }: Props) {
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)
  const ref = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top?: number; bottom?: number }>({ left: anchor.left })

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const viewW = window.innerWidth
    const viewH = window.innerHeight
    const left = Math.max(8, Math.min(anchor.left, viewW - r.width - 8))
    if (anchor.top - r.height - 6 > 0) setPos({ left, bottom: viewH - anchor.top + 6 })
    else setPos({ left, top: anchor.bottom + 6 })
  }, [anchor])

  const q = query.trim().toLowerCase()
  const matches = (c: CustomCommand) => !q || c.label.toLowerCase().includes(q) || (c.prompt || '').toLowerCase().includes(q)
  const rows: Array<{ section: CommandSection | null; items: Array<{ cmd: CustomCommand; reason?: string }> }> = []
  const sectionById = new Map(plan.sections.map((s) => [s.id, s]))
  const push = (cmd: CustomCommand, reason?: string) => {
    const section = cmd.sectionId ? sectionById.get(cmd.sectionId) ?? null : null
    let row = rows.find((r) => (r.section?.id ?? null) === (section?.id ?? null))
    if (!row) { row = { section, items: [] }; rows.push(row) }
    row.items.push({ cmd, reason })
  }
  for (const c of folded) if (matches(c)) push(c)
  for (const { cmd, reason } of plan.inapplicable) if (matches(cmd)) push(cmd, reason)
  // Unsectioned last in the list ("No section"), sections in their order.
  rows.sort((a, b) => (a.section === null ? 1 : 0) - (b.section === null ? 1 : 0))
  const flat = rows.flatMap((r) => r.items)
  const showFilter = folded.length + plan.inapplicable.length > 5

  React.useEffect(() => { setActive(0) }, [q])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); return }
    if (e.key === 'Enter') {
      const it = flat[active]
      if (it && !it.reason) { onRun(it.cmd, e as unknown as React.MouseEvent); onClose() }
    }
  }

  let index = -1
  return (
    <div className="fixed inset-0 z-50" onClick={onClose} data-testid="command-overflow-backdrop">
      <div
        ref={ref}
        className="fixed rounded-lg shadow-xl p-2 w-[300px] text-xs outline-none"
        style={{ ...pos, background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        role="dialog"
        aria-label={`More ${plan.label} commands`}
        data-testid="command-overflow"
        tabIndex={-1}
      >
        {showFilter && (
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Find a ${plan.label.toLowerCase()} command…`}
            className="w-full h-7 px-2 mb-2 rounded-md border outline-none"
            style={{ background: 'var(--surface-base)', borderColor: 'var(--border-strong)', color: 'var(--text-primary)' }}
            data-testid="command-overflow-filter"
          />
        )}
        <div className="max-h-[320px] overflow-y-auto">
          {rows.length === 0 && <div className="px-2 py-2" style={{ color: 'var(--text-muted)' }}>Nothing matches.</div>}
          {rows.map((row) => (
            <div key={row.section?.id ?? '__none'}>
              {(rows.length > 1 || row.section) && (
                <div className="px-1.5 pt-1.5 pb-1 text-[9.5px] font-semibold uppercase tracking-[.09em]" style={{ color: row.section?.color || 'var(--text-muted)' }} data-testid="command-overflow-group">
                  {row.section ? row.section.name : 'No section'}
                </div>
              )}
              {row.items.map(({ cmd, reason }) => {
                index += 1
                const i = index
                const color = cmd.color || DEFAULT_COMMAND_COLOR
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    className="w-full flex items-center gap-2 px-1.5 py-1 rounded-md text-left"
                    style={{
                      background: i === active ? 'var(--surface-raised)' : 'transparent',
                      color: reason ? 'var(--text-muted)' : 'var(--text-primary)',
                      opacity: reason ? 0.8 : 1,
                    }}
                    onMouseEnter={() => setActive(i)}
                    onClick={(e) => { if (!reason) { onRun(cmd, e); onClose() } }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(cmd, e) }}
                    title={reason ? `${cmd.label} — cannot run here: ${reason}` : cmd.label}
                    data-testid="command-overflow-item"
                    data-command-id={cmd.id}
                    data-inapplicable={reason ? 'true' : undefined}
                  >
                    <TargetMark kind={clusterOf(cmd, caps)} caps={caps} />
                    <CommandIcon icon={cmd.icon} color={color} label={cmd.label} size={14} />
                    <span className="truncate">{cmd.label}</span>
                    <span className="ml-auto text-[10.5px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                      {reason ? "can't run here" : [cmd.hasSecretArg ? 'secret' : null, cmd.defaultArgs?.length ? 'args' : null, cmd.pinned ? 'pinned' : null].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                )
              })}
              {row.items.some((it) => it.reason) && (
                <div className="px-1.5 pb-1 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                  {Array.from(new Set(row.items.filter((it) => it.reason).map((it) => it.reason))).join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-1 pt-2 text-[10.5px]" style={{ borderTop: '1px solid var(--border-strong)', color: 'var(--text-muted)' }}>
          <span>Right-click any → <span style={{ color: 'var(--text-secondary)' }}>Pin to bar</span></span>
          <button type="button" className="ml-auto hover:underline" style={{ color: 'var(--text-secondary)' }} onClick={() => { onManage(); onClose() }} data-testid="command-overflow-manage">Manage all…</button>
        </div>
      </div>
    </div>
  )
}
