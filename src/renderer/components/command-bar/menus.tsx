import React from 'react'
import type { CustomCommand, CommandSection, CommandBand } from '../../stores/commandStore'
import type { CoreToolId, CommandBarOverflow } from '../../stores/commandBarStore'
import type { SessionCapabilities } from '../../lib/session-capabilities'
import { COMMAND_SWATCHES, swatchesFor, DEFAULT_COMMAND_COLOR } from '../../lib/command-swatches'
import { COMMAND_ICON_KEYS, CommandIcon } from '../command-icons'
import { chipTitle } from './layout'

/* ------------------------------------------------------------------------ */
/* Shared menu chrome                                                        */
/* ------------------------------------------------------------------------ */

const MENU_STYLE: React.CSSProperties = { background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)' }

function usePlacement(x: number, y: number, ref: React.RefObject<HTMLDivElement | null>) {
  const [pos, setPos] = React.useState<{ left: number; top?: number; bottom?: number }>({ left: x })
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const viewH = window.innerHeight
    const viewW = window.innerWidth
    const left = Math.max(8, Math.min(x, viewW - rect.width - 8))
    if (y + rect.height > viewH - 8) setPos({ left, bottom: viewH - y })
    else setPos({ left, top: y })
  }, [x, y, ref])
  return pos
}

/**
 * One context menu with keyboard support: Escape closes, Up/Down move, Enter
 * activates, Right opens a submenu, Left closes it. Focus returns to the
 * element that opened it (the caller passes `returnFocusTo`).
 */
export function Menu({ x, y, onClose, children, ariaLabel, returnFocusTo, testId }: {
  x: number; y: number; onClose: () => void; children: React.ReactNode; ariaLabel: string
  returnFocusTo?: HTMLElement | null; testId?: string
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const pos = usePlacement(x, y, ref)
  React.useEffect(() => {
    const el = ref.current
    const first = el?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
    first?.focus()
    return () => { returnFocusTo?.focus?.() }
  }, [returnFocusTo])
  const onKey = (e: React.KeyboardEvent) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus() }
  }
  return (
    <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      <div
        ref={ref}
        className="fixed rounded-lg shadow-xl py-1 min-w-[210px] text-xs"
        style={{ ...pos, ...MENU_STYLE }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        role="menu"
        aria-label={ariaLabel}
        data-testid={testId ?? 'command-bar-menu'}
      >
        {children}
      </div>
    </div>
  )
}

export function MenuHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="px-3 pt-1.5 pb-2 mb-1" style={{ borderBottom: '1px solid var(--border-strong)' }}>
      <div className="font-semibold truncate max-w-[320px]" style={{ color: 'var(--text-primary)' }}>{title}</div>
      {sub && <div className="text-[11px] mt-0.5 truncate max-w-[320px]" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  )
}

export function MenuItem({ onClick, children, danger, disabled, hint, icon, testId, submenu, open }: {
  onClick?: () => void; children: React.ReactNode; danger?: boolean; disabled?: boolean; hint?: string
  icon?: React.ReactNode; testId?: string; submenu?: React.ReactNode; open?: boolean
}) {
  const [hover, setHover] = React.useState(false)
  const showSub = !!submenu && (hover || open)
  return (
    <div className="relative" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        type="button"
        role="menuitem"
        aria-disabled={disabled || undefined}
        aria-haspopup={submenu ? 'menu' : undefined}
        aria-expanded={submenu ? showSub : undefined}
        disabled={disabled}
        onClick={() => { if (!disabled) { if (submenu) setHover((h) => !h); else onClick?.() } }}
        onKeyDown={(e) => { if (submenu && e.key === 'ArrowRight') { e.preventDefault(); setHover(true) } if (submenu && e.key === 'ArrowLeft') { e.preventDefault(); setHover(false) } }}
        className="w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors disabled:opacity-50 rounded-sm focus:outline-none"
        style={{ color: danger ? 'var(--status-danger)' : 'var(--text-primary)' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-raised)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
        onFocus={(e) => { e.currentTarget.style.background = 'var(--surface-raised)' }}
        onBlur={(e) => { e.currentTarget.style.background = 'transparent' }}
        data-testid={testId}
      >
        {icon && <span className="w-3 h-3 inline-flex items-center justify-center shrink-0" style={{ color: danger ? 'var(--status-danger)' : 'var(--text-muted)' }}>{icon}</span>}
        <span className="flex-1 truncate">{children}</span>
        {hint && <span className="ml-3 text-[10.5px] font-mono shrink-0" style={{ color: danger ? 'var(--status-danger)' : 'var(--text-muted)' }}>{hint}</span>}
        {submenu && <span className="ml-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>▸</span>}
      </button>
      {showSub && (
        <div className="absolute left-full top-0 ml-0.5 rounded-lg shadow-xl py-1 min-w-[170px] z-10" style={MENU_STYLE} role="menu">
          {submenu}
        </div>
      )}
    </div>
  )
}

export function MenuRule() { return <div className="h-px my-1 mx-2" style={{ background: 'var(--border-strong)' }} /> }
export function MenuFoot({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pt-1 pb-1 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{children}</div>
}

const I = {
  play: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><polygon points="6 3 20 12 6 21 6 3" /></svg>,
  args: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h10M4 18h7" /></svg>,
  edit: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>,
  copy: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>,
  pin: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v5M5 8l7-5 7 5v9H5z" /></svg>,
  trash: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>,
  plus: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>,
  lines: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>,
  gear: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></svg>,
  eyeoff: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>,
  arrows: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 7h12M4 7l2-2M4 7l2 2M16 17H4M20 17l-2-2M20 17l-2 2" /></svg>,
  globe: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>,
  lock: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>,
  warn: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>,
}
export const MenuIcons = I

/* ------------------------------------------------------------------------ */
/* Icon + colour quick picker (shared with the dialog)                        */
/* ------------------------------------------------------------------------ */

export function IconColourPicker({ icon, color, label, onIcon, onColor, compact }: {
  icon?: string; color: string; label: string
  onIcon: (key: string | undefined) => void; onColor: (hex: string) => void; compact?: boolean
}) {
  const keys = compact ? COMMAND_ICON_KEYS.slice(0, 11) : COMMAND_ICON_KEYS
  const [expanded, setExpanded] = React.useState(!compact)
  const shown = expanded ? COMMAND_ICON_KEYS : keys
  return (
    <div className="px-2 py-1.5" data-testid="icon-colour-picker">
      <div className="flex flex-wrap gap-1 mb-2 max-w-[300px]">
        <button
          type="button"
          onClick={() => onIcon(undefined)}
          className={`w-7 h-7 rounded-md border grid place-items-center focus-ring ${!icon ? 'ring-2 ring-[var(--brand)]' : ''}`}
          style={{ background: 'var(--surface-base)', borderColor: 'var(--border-subtle)' }}
          title="No icon — the first letter of the label"
          aria-label="Monogram (no icon)"
          aria-pressed={!icon}
          data-testid="icon-pick-monogram"
        >
          <CommandIcon icon={undefined} color={color} label={label || '?'} size={14} />
        </button>
        {shown.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onIcon(k)}
            className={`w-7 h-7 rounded-md border grid place-items-center focus-ring ${icon === k ? 'ring-2 ring-[var(--brand)]' : ''}`}
            style={{ background: 'var(--surface-base)', borderColor: 'var(--border-subtle)' }}
            title={k}
            aria-label={`Icon ${k}`}
            aria-pressed={icon === k}
            data-testid={`icon-pick-${k}`}
          >
            <CommandIcon icon={k} color={color} label={label} size={14} />
          </button>
        ))}
        {!expanded && (
          <button type="button" onClick={() => setExpanded(true)} className="h-7 px-2 rounded-md border text-[10px] font-semibold focus-ring" style={{ background: 'var(--surface-base)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
            +{COMMAND_ICON_KEYS.length - keys.length} more…
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5" data-testid="colour-picks">
        {swatchesFor(color).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onColor(c)}
            aria-label={`Colour ${c}`}
            aria-pressed={c.toUpperCase() === color.toUpperCase()}
            className={`w-4 h-4 rounded-full border-2 transition-all ${c.toUpperCase() === color.toUpperCase() ? 'scale-110' : 'border-transparent'}`}
            style={{ backgroundColor: c, borderColor: c.toUpperCase() === color.toUpperCase() ? '#fff' : 'transparent' }}
          />
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The menus, one per surface                                                */
/* ------------------------------------------------------------------------ */

export interface UserButtonMenuProps {
  x: number; y: number; cmd: CustomCommand; caps: SessionCapabilities; sections: CommandSection[]
  sectionName?: string; hasConfig: boolean
  onClose: () => void
  onRun: () => void; onRunWithArgs: () => void; onEdit: () => void; onDuplicate: () => void
  onIcon: (key: string | undefined) => void; onColor: (hex: string) => void
  onTogglePin: () => void
  onShowIn: (band: CommandBand) => void
  onMoveToSection: (sectionId: string | undefined) => void
  onMove: (dir: 'left' | 'right' | 'start' | 'end') => void
  onDelete: () => void
  returnFocusTo?: HTMLElement | null
}

export function UserButtonMenu(p: UserButtonMenuProps) {
  const { cmd } = p
  const isPage = cmd.kind === 'page'
  const hasArgs = !isPage && !!(cmd.defaultArgs?.length || cmd.lastCustomArgs?.length)
  const isGlobal = cmd.scope === 'global'
  return (
    <Menu x={p.x} y={p.y} onClose={p.onClose} ariaLabel={`${cmd.label} menu`} returnFocusTo={p.returnFocusTo} testId="command-menu">
      <MenuHeader title={cmd.label} sub={chipTitle(cmd, p.caps, p.sectionName).replace(/^[^—]*— /, '')} />
      {cmd.needsReview?.length ? (
        <MenuItem onClick={p.onEdit} icon={I.warn} testId="menu-review">Review this button…<span className="ml-1" style={{ color: 'var(--status-warning)' }}>({cmd.needsReview.length})</span></MenuItem>
      ) : null}
      <MenuItem onClick={p.onRun} icon={I.play} testId="menu-run">{isPage ? 'Open' : 'Run'}</MenuItem>
      {!isPage && <MenuItem onClick={p.onRunWithArgs} icon={I.args} hint="Ctrl+click" disabled={!hasArgs} testId="menu-run-args">Run with arguments…</MenuItem>}
      <MenuRule />
      <MenuItem onClick={p.onEdit} icon={I.edit} testId="menu-edit">Edit…</MenuItem>
      <MenuItem onClick={p.onDuplicate} icon={I.copy} testId="menu-duplicate">Duplicate</MenuItem>
      <MenuItem icon={I.gear} testId="menu-icon-colour" submenu={
        <IconColourPicker icon={cmd.icon} color={cmd.color || DEFAULT_COMMAND_COLOR} label={cmd.label} onIcon={p.onIcon} onColor={p.onColor} compact />
      }>Icon and colour</MenuItem>
      <MenuItem onClick={p.onTogglePin} icon={I.pin} testId="menu-pin">{cmd.pinned ? 'Unpin from bar' : 'Pin to bar'}</MenuItem>
      <MenuRule />
      <MenuItem icon={I.globe} testId="menu-show-in" hint={isGlobal ? 'Global' : 'Session'} submenu={
        <>
          <MenuItem onClick={() => p.onShowIn('global')} disabled={isGlobal} testId="menu-show-global">{isGlobal ? '● ' : '○ '}Global — every config</MenuItem>
          <MenuItem onClick={() => p.onShowIn('config')} disabled={!isGlobal || !p.hasConfig} testId="menu-show-session">{!isGlobal ? '● ' : '○ '}Session — this config only</MenuItem>
          {!p.hasConfig && <MenuFoot>This session has no saved config.</MenuFoot>}
        </>
      }>Show in</MenuItem>
      <MenuItem icon={I.lines} testId="menu-move-section" submenu={
        <>
          <MenuItem onClick={() => p.onMoveToSection(undefined)} disabled={!cmd.sectionId} testId="menu-section-none">No section</MenuItem>
          {p.sections.map((s) => (
            <MenuItem key={s.id} onClick={() => p.onMoveToSection(s.id)} disabled={cmd.sectionId === s.id} testId={`menu-section-${s.id}`}>
              <span style={{ color: s.color || undefined }}>{s.name}</span>{cmd.sectionId === s.id ? ' · current' : ''}
            </MenuItem>
          ))}
          {p.sections.length === 0 && <MenuFoot>No sections in this band yet — Add ▾ → Add section.</MenuFoot>}
        </>
      }>Move to section</MenuItem>
      <MenuItem icon={I.arrows} testId="menu-move" submenu={
        <>
          <MenuItem onClick={() => p.onMove('left')} hint="Alt+←">Left</MenuItem>
          <MenuItem onClick={() => p.onMove('right')} hint="Alt+→">Right</MenuItem>
          <MenuItem onClick={() => p.onMove('start')}>To the start of the band</MenuItem>
          <MenuItem onClick={() => p.onMove('end')}>To the end of the band</MenuItem>
        </>
      }>Move</MenuItem>
      <MenuRule />
      <MenuItem onClick={p.onDelete} icon={I.trash} danger hint={isGlobal ? 'from every config' : undefined} testId="menu-delete">Delete…</MenuItem>
    </Menu>
  )
}

export function CoreToolMenu(p: {
  x: number; y: number; tool: CoreToolId; title: string; sub: string
  ownActions?: Array<{ label: string; onClick: () => void; testId?: string }>
  onHide: (where: 'session' | 'everywhere') => void
  /** Core order is not user-sortable yet; the item appears only when wired. */
  onMove?: (dir: 'left' | 'right') => void
  onClose: () => void; returnFocusTo?: HTMLElement | null
}) {
  return (
    <Menu x={p.x} y={p.y} onClose={p.onClose} ariaLabel={`${p.title} menu`} returnFocusTo={p.returnFocusTo} testId="core-tool-menu">
      <MenuHeader title={p.title} sub={p.sub} />
      {p.ownActions?.map((a) => <MenuItem key={a.label} onClick={a.onClick} testId={a.testId}>{a.label}</MenuItem>)}
      {p.ownActions?.length ? <MenuRule /> : null}
      <MenuItem icon={I.eyeoff} testId="menu-hide-tool" submenu={
        <>
          <MenuItem onClick={() => p.onHide('session')} testId="menu-hide-session">In this session</MenuItem>
          <MenuItem onClick={() => p.onHide('everywhere')} testId="menu-hide-everywhere">Everywhere</MenuItem>
        </>
      }>Hide this tool</MenuItem>
      {p.onMove && (
        <MenuItem icon={I.arrows} testId="menu-move-tool" submenu={
          <>
            <MenuItem onClick={() => p.onMove!('left')}>Left</MenuItem>
            <MenuItem onClick={() => p.onMove!('right')}>Right</MenuItem>
          </>
        }>Move</MenuItem>
      )}
      <MenuRule />
      <MenuFoot>Hidden tools come back from Settings → Custom Commands</MenuFoot>
    </Menu>
  )
}

export function SectionMenu(p: {
  x: number; y: number; section: CommandSection; count: number; collapsed: boolean; hasConfig: boolean
  onRename: () => void; onColor: (hex: string | undefined) => void; onCollapse: () => void
  onMoveBand: (band: CommandBand) => void; onAddCommand: () => void; onDelete: () => void
  onClose: () => void; returnFocusTo?: HTMLElement | null
}) {
  const s = p.section
  return (
    <Menu x={p.x} y={p.y} onClose={p.onClose} ariaLabel={`${s.name} section menu`} returnFocusTo={p.returnFocusTo} testId="section-menu">
      <MenuHeader title={s.name} sub={`section · ${s.scope === 'global' ? 'Global' : 'Session'} · ${p.count} button${p.count === 1 ? '' : 's'}`} />
      <MenuItem onClick={p.onRename} icon={I.edit} testId="menu-section-rename">Rename…</MenuItem>
      <MenuItem icon={I.gear} testId="menu-section-colour" submenu={
        <div className="px-2 py-1.5 flex flex-wrap gap-1.5 max-w-[200px]">
          <button type="button" onClick={() => p.onColor(undefined)} className="w-4 h-4 rounded-full border" style={{ background: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }} title="Default" aria-label="Default colour" />
          {COMMAND_SWATCHES.map((c) => (
            <button key={c} type="button" onClick={() => p.onColor(c)} className={`w-4 h-4 rounded-full border-2 ${c === s.color ? 'scale-110' : 'border-transparent'}`} style={{ backgroundColor: c, borderColor: c === s.color ? '#fff' : 'transparent' }} aria-label={`Colour ${c}`} />
          ))}
        </div>
      }>Colour</MenuItem>
      <MenuRule />
      <MenuItem onClick={p.onCollapse} testId="menu-section-collapse">{p.collapsed ? 'Expand' : 'Collapse to a chip'}</MenuItem>
      <MenuItem icon={I.arrows} testId="menu-section-move" submenu={
        <>
          <MenuItem onClick={() => p.onMoveBand('global')} disabled={s.scope === 'global'} testId="menu-section-to-global">To the Global band…</MenuItem>
          <MenuItem onClick={() => p.onMoveBand('config')} disabled={s.scope === 'config' || !p.hasConfig} testId="menu-section-to-session">To the Session band…</MenuItem>
        </>
      }>Move</MenuItem>
      <MenuRule />
      <MenuItem onClick={p.onAddCommand} icon={I.plus} testId="menu-section-add">Add command to this section…</MenuItem>
      <MenuRule />
      <MenuItem onClick={p.onDelete} icon={I.trash} danger hint={`keeps its ${p.count}`} testId="menu-section-delete">Delete section</MenuItem>
    </Menu>
  )
}

export function BarMenu(p: {
  x: number; y: number; overflow: CommandBarOverflow; hiddenTools: Array<{ tool: CoreToolId; label: string }>
  onAddCommand: () => void; onAddSection: () => void; onOverflow: (v: CommandBarOverflow) => void
  onShowTool: (tool: CoreToolId) => void; onManage: () => void; onHideBar: () => void
  onClose: () => void; returnFocusTo?: HTMLElement | null
}) {
  return (
    <Menu x={p.x} y={p.y} onClose={p.onClose} ariaLabel="Command bar menu" returnFocusTo={p.returnFocusTo} testId="bar-menu">
      <MenuItem onClick={p.onAddCommand} icon={I.plus} testId="bar-add-command">Add command…</MenuItem>
      <MenuItem onClick={p.onAddSection} icon={I.lines} testId="bar-add-section">Add section…</MenuItem>
      <MenuRule />
      <MenuItem onClick={() => p.onOverflow('fold')} testId="bar-overflow-fold">{p.overflow === 'fold' ? '● ' : '○ '}One row — fold the rest</MenuItem>
      <MenuItem onClick={() => p.onOverflow('wrap2')} testId="bar-overflow-wrap2">{p.overflow === 'wrap2' ? '● ' : '○ '}Two rows, then fold</MenuItem>
      <MenuItem icon={I.eyeoff} testId="bar-show-hidden" disabled={p.hiddenTools.length === 0} hint={p.hiddenTools.length ? String(p.hiddenTools.length) : 'none'} submenu={
        p.hiddenTools.length ? <>{p.hiddenTools.map((t) => <MenuItem key={t.tool} onClick={() => p.onShowTool(t.tool)} testId={`bar-show-${t.tool}`}>Show {t.label}</MenuItem>)}</> : undefined
      }>Show hidden tools</MenuItem>
      <MenuRule />
      <MenuItem onClick={p.onManage} icon={I.gear} testId="bar-manage">Manage commands…</MenuItem>
      <MenuItem onClick={p.onHideBar} icon={I.eyeoff} testId="bar-hide">Hide the command bar</MenuItem>
      <MenuFoot>comes back from Settings → Custom Commands</MenuFoot>
    </Menu>
  )
}

export function BandMenu(p: {
  x: number; y: number; band: CommandBand; configName?: string
  onAddCommand: () => void; onAddSection: () => void; onManage: () => void
  onClose: () => void; returnFocusTo?: HTMLElement | null
}) {
  const isGlobal = p.band === 'global'
  return (
    <Menu x={p.x} y={p.y} onClose={p.onClose} ariaLabel={`${isGlobal ? 'Global' : 'Session'} band menu`} returnFocusTo={p.returnFocusTo} testId="band-menu">
      <MenuHeader title={isGlobal ? 'Global' : 'Session'} sub={isGlobal ? 'shows in every config' : `this config only${p.configName ? ` — ${p.configName}` : ''}`} />
      <MenuItem onClick={p.onAddCommand} icon={I.plus} testId="band-add-command">Add command here…</MenuItem>
      <MenuItem onClick={p.onAddSection} icon={I.lines} testId="band-add-section">Add section here…</MenuItem>
      <MenuRule />
      <MenuItem onClick={p.onManage} icon={I.gear}>Manage commands…</MenuItem>
    </Menu>
  )
}

export function AddMenu(p: {
  x: number; y: number; reviewCount: number; notesEnabled: boolean
  onAddCommand: () => void; onAddSection: () => void; onAddNote?: () => void; onReview: () => void; onManage: () => void
  onClose: () => void; returnFocusTo?: HTMLElement | null
}) {
  return (
    <Menu x={p.x} y={p.y} onClose={p.onClose} ariaLabel="Add menu" returnFocusTo={p.returnFocusTo} testId="add-menu">
      <MenuItem onClick={p.onAddCommand} icon={I.plus} testId="add-command">Add command…</MenuItem>
      <MenuItem onClick={p.onAddSection} icon={I.lines} testId="add-section">Add section…</MenuItem>
      {p.notesEnabled && p.onAddNote && <MenuItem onClick={p.onAddNote} icon={I.lock} testId="add-note">Add note…</MenuItem>}
      {p.reviewCount > 0 && (
        <>
          <MenuRule />
          <MenuItem onClick={p.onReview} icon={I.warn} testId="add-review">Review {p.reviewCount} command{p.reviewCount === 1 ? '' : 's'}…</MenuItem>
        </>
      )}
      <MenuRule />
      <MenuItem onClick={p.onManage} icon={I.gear} testId="add-manage">Manage commands…</MenuItem>
    </Menu>
  )
}

/* ------------------------------------------------------------------------ */
/* Confirms (scope change on drop, hide a tool)                               */
/* ------------------------------------------------------------------------ */

export function ConfirmCard({ title, body, actions, onCancel, testId }: {
  title: string; body: React.ReactNode
  actions: Array<{ label: string; onClick: () => void; primary?: boolean; danger?: boolean; testId?: string }>
  onCancel: () => void; testId?: string
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid={testId ?? 'command-confirm'}>
      <div className="rounded-xl shadow-2xl w-[440px] max-w-[92vw]" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }} role="dialog" aria-modal="true" aria-labelledby="cmd-confirm-title">
        <div className="px-4 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <h3 id="cmd-confirm-title" className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
        </div>
        <div className="px-4 py-3 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{body}</div>
        <div className="px-4 pb-4 pt-1 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="h-7 px-3 rounded-md text-xs" style={{ background: 'var(--surface-overlay)', color: 'var(--text-secondary)' }}>Cancel</button>
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={a.onClick}
              data-testid={a.testId}
              className="h-7 px-3 rounded-md text-xs font-medium"
              style={a.danger
                ? { background: 'color-mix(in srgb, var(--status-danger) 16%, transparent)', color: 'var(--status-danger)', border: '1px solid color-mix(in srgb, var(--status-danger) 40%, transparent)' }
                : a.primary
                  ? { background: 'var(--brand)', color: '#0a0e13' }
                  : { background: 'var(--surface-overlay)', color: 'var(--text-primary)' }}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
