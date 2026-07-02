import React from 'react'

// Theme-aware badge colours: foreground reads a semantic token, background is a
// low-opacity tint of the same token via color-mix so the badge stays legible in
// both light and dark themes (previously these were hardcoded dark-only hexes).
export const tint = (token: string) => `color-mix(in srgb, var(${token}) 14%, transparent)`
export const TYPE_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  user:          { bg: tint('--status-info'),    fg: 'var(--status-info)',     label: 'User' },
  feedback:      { bg: tint('--status-warning'), fg: 'var(--status-warning)',  label: 'Feedback' },
  project:       { bg: tint('--status-success'), fg: 'var(--status-success)',  label: 'Project' },
  reference:     { bg: tint('--chart-other'),    fg: 'var(--chart-other)',     label: 'Reference' },
  snapshot:      { bg: tint('--text-secondary'), fg: 'var(--text-secondary)',  label: 'Snapshot' },
  uncategorized: { bg: tint('--text-muted'),     fg: 'var(--text-muted)',      label: 'Uncategorized' },
}
export const TYPE_ORDER = ['user', 'feedback', 'project', 'reference', 'snapshot', 'uncategorized']

export function fmt(bytes: number) { return bytes < 1024 ? bytes + 'B' : (bytes / 1024).toFixed(1) + 'KB' }
export function fmtRel(ts: number) {
  const d = Math.floor((Date.now() - ts) / 86400000)
  if (d === 0) return 'today'
  if (d === 1) return '1d ago'
  if (d < 30) return d + 'd ago'
  return Math.floor(d / 30) + 'mo ago'
}
// Freshness ramp ends in a calm dormant grey, not red: a memory being old is
// not an error, and red is reserved for genuine problem states.
export function staleClass(ts: number) {
  const d = (Date.now() - ts) / 86400000
  return d < 7 ? 'bg-green' : d < 30 ? 'bg-yellow' : 'bg-overlay0'
}
export function staleShadow(ts: number) {
  const d = (Date.now() - ts) / 86400000
  return d < 7 ? '0 0 4px rgba(166,227,161,0.4)' : d < 30 ? '0 0 4px rgba(249,226,175,0.3)' : 'none'
}

export function TypeBadge({ type }: { type: string }) {
  const tc = TYPE_COLORS[type] || TYPE_COLORS.uncategorized
  return (
    <span
      className="font-mono text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm shrink-0"
      style={{ background: tc.bg, color: tc.fg }}
    >
      {tc.label}
    </span>
  )
}

// Escape HTML entities to prevent XSS in dangerouslySetInnerHTML
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Simple markdown renderer (content is escaped first to prevent injection)
export function renderMarkdown(content: string): string {
  return escapeHtml(content)
    .replace(/^---[\s\S]*?---\n*/m, '') // strip frontmatter
    .replace(/^### (.+)$/gm, '<h3 class="font-mono text-xs text-subtext0 font-semibold mt-4 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="font-mono text-[13px] text-blue font-semibold mt-4 mb-1">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="font-mono text-[15px] text-text font-semibold mt-4 mb-2">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-text font-semibold">$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="font-mono text-[11px] bg-surface0 px-1 py-0.5 rounded text-peach">$1</code>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 mb-0.5">$1</li>')
    .replace(/\n{2,}/g, '</p><p class="mb-2">')
    .replace(/\n/g, '<br>')
}
