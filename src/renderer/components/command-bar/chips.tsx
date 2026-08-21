import React from 'react'
import type { CustomCommand, CommandSection } from '../../stores/commandStore'
import type { SessionCapabilities } from '../../lib/session-capabilities'
import { CommandIcon } from '../command-icons'
import { DEFAULT_COMMAND_COLOR } from '../../lib/command-swatches'
import { chipTitle, clusterTitle, effectiveKind, type ClusterKind } from './layout'

/** The neutral chip every Core tool and user button shares (D1, D4). */
export const CHIP_CLASS = 'flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-md border whitespace-nowrap shrink-0 transition-colors duration-150 focus-ring'
export const CHIP_STYLE: React.CSSProperties = { background: 'var(--surface-raised)', color: 'var(--text-secondary)', borderColor: 'var(--border-subtle)' }

// Stroked marks, the same family as the Core tool glyphs.
const Paths = {
  claude: 'M12 2v8.5M12 13.5V22M2 12h8.5M13.5 12H22M4.93 4.93l6.01 6.01M13.06 13.06l6.01 6.01M19.07 4.93l-6.01 6.01M10.94 13.06l-6.01 6.01',
  codex: 'M12 3l8 4.6v8.8L12 21l-8-4.6V7.6zM12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z',
  shell: 'M4 17l6-6-6-6M12 19h8',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  lock: 'M4 11h16v10H4zM8 11V7a4 4 0 0 1 8 0v4',
  pin: 'M12 17v5M5 8l7-5 7 5v9H5z',
  browser: 'M2 4h20v16H2zM2 8h20',
} as const

function Mark({ d, size = 11, className, style }: { d: string; size?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden>
      <path d={d} />
    </svg>
  )
}

/** The small badge that says which COMPUTER, shown only when the panes differ (SSH). */
export function MachineBadge({ text, className }: { text: string; className?: string }) {
  return (
    <span
      className={`inline-block rounded px-1 text-[7.5px] font-bold uppercase tracking-wide leading-[11px] border ${className ?? ''}`}
      style={{ background: 'var(--surface-overlay)', borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
      data-testid="command-machine-badge"
    >
      {text}
    </span>
  )
}

/** The muted mark that opens a target cluster inside a band (D4). */
export function TargetMark({ kind, caps }: { kind: ClusterKind; caps: SessionCapabilities }) {
  const d = kind === 'agent' ? (caps.agent === 'codex' ? Paths.codex : Paths.claude)
    : kind === 'page' ? Paths.globe
    : Paths.shell
  const badge = caps.panesOnDifferentMachines
    ? (kind === 'partner' ? 'this PC' : kind === 'main-shell' || kind === 'agent' ? (caps.remoteHost ?? 'remote') : null)
    : null
  return (
    <span
      className="relative inline-flex items-center justify-center w-4 h-4 shrink-0"
      style={{ color: 'var(--text-muted)' }}
      title={clusterTitle(kind, caps)}
      aria-label={clusterTitle(kind, caps)}
      data-testid={`command-cluster-${kind}`}
    >
      <Mark d={d} />
      {badge && <MachineBadge text={badge} className="absolute -top-1.5 left-3" />}
    </span>
  )
}

/** A user section drawn INSIDE a band: a coloured label before its chips (D9). */
export function SectionLabel({ section, onContextMenu, onClick, draggable, onDragStart, onDragOver, onDrop, onDragEnd, isDropTarget }: {
  section: CommandSection
  onContextMenu: (e: React.MouseEvent) => void
  onClick?: () => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  isDropTarget?: boolean
}) {
  return (
    <button
      type="button"
      className={`shrink-0 flex items-center h-4 pl-1.5 pr-1 ml-0.5 text-[9.5px] font-semibold uppercase tracking-[.08em] rounded border-l cursor-grab focus-ring ${isDropTarget ? 'ring-1 ring-[var(--brand)]' : ''}`}
      style={{ color: section.color || 'var(--text-secondary)', borderColor: 'var(--border-strong)' }}
      title={`${section.name} — section. Right-click to rename, recolour, collapse or move; drag to reorder`}
      onContextMenu={onContextMenu}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-testid="command-section-label"
      data-section-id={section.id}
    >
      {section.name}
    </button>
  )
}

export interface CommandChipProps {
  cmd: CustomCommand
  caps: SessionCapabilities
  sectionName?: string
  onClick: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  // drag
  draggable?: boolean
  isDragging?: boolean
  isDropTarget?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  // keyboard (roving tabindex)
  tabIndex?: number
  onKeyDown?: (e: React.KeyboardEvent) => void
  buttonRef?: (el: HTMLButtonElement | null) => void
}

/**
 * A user button: icon + label like the Core tools, the colour in the ICON
 * (glyph or monogram tile) never on the surface, and right-edge marks only
 * -- lock (carries a secret), browser (watches a page), chevron (has args),
 * pin (pinned), and an amber dot when the upgrade review wants a look (D13).
 */
export function CommandChip(p: CommandChipProps) {
  const { cmd, caps } = p
  const color = cmd.color || DEFAULT_COMMAND_COLOR
  const kind = effectiveKind(cmd, caps)
  const hasArgs = !!(cmd.defaultArgs?.length || cmd.lastCustomArgs?.length)
  const needsReview = !!cmd.needsReview?.length
  return (
    <button
      type="button"
      ref={p.buttonRef}
      draggable={p.draggable}
      onDragStart={p.onDragStart}
      onDragOver={p.onDragOver}
      onDrop={p.onDrop}
      onDragEnd={p.onDragEnd}
      onClick={p.onClick}
      onContextMenu={p.onContextMenu}
      onKeyDown={p.onKeyDown}
      tabIndex={p.tabIndex}
      className={CHIP_CLASS}
      style={{
        ...CHIP_STYLE,
        opacity: p.isDragging ? 0.4 : 1,
        cursor: p.isDragging ? 'grabbing' : 'grab',
        background: p.isDropTarget ? 'var(--surface-overlay)' : 'var(--surface-raised)',
        borderColor: p.isDropTarget ? 'var(--brand)' : 'var(--border-subtle)',
        borderLeftWidth: p.isDropTarget ? 2 : undefined,
      }}
      onMouseEnter={(e) => { if (!p.isDragging) { e.currentTarget.style.background = 'var(--surface-overlay)'; e.currentTarget.style.color = 'var(--text-primary)' } }}
      onMouseLeave={(e) => { if (!p.isDropTarget) { e.currentTarget.style.background = 'var(--surface-raised)'; e.currentTarget.style.color = 'var(--text-secondary)' } }}
      title={chipTitle(cmd, caps, p.sectionName)}
      data-testid="command-chip"
      data-command-id={cmd.id}
      data-kind={kind}
    >
      {kind === 'page' ? (
        // A page button is drawn with a small globe in its colour, so a button
        // that runs nothing cannot be mistaken for one that does.
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden data-testid="command-page-glyph">
          <path d={Paths.globe} />
        </svg>
      ) : (
        <CommandIcon icon={cmd.icon} color={color} label={cmd.label} size={13} />
      )}
      <span className="truncate max-w-[160px]">{cmd.label}</span>
      {cmd.hasSecretArg && <Mark d={Paths.lock} size={9} style={{ color: 'var(--color-yellow)' }} />}
      {cmd.webView?.enabled && <Mark d={Paths.browser} size={9} style={{ color: 'var(--color-blue)' }} />}
      {hasArgs && (
        <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 opacity-50" style={{ color: 'var(--text-muted)' }} aria-hidden data-testid="command-args-mark">
          <path d="M2 3.5l3 3 3-3" />
        </svg>
      )}
      {cmd.pinned && <Mark d={Paths.pin} size={9} style={{ color: 'var(--text-muted)' }} />}
      {needsReview && (
        <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--status-warning)' }} aria-label="needs review" data-testid="command-review-mark" />
      )}
    </button>
  )
}
