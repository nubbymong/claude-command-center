import React from 'react'

/**
 * The curated glyph set a command button can wear -- one stroked family, one
 * line weight, the same species as the Core tool buttons (Snap, Canvas, Logs,
 * Browser, Partner). A command stores the KEY, never SVG, so the set can be
 * redrawn without touching anyone's data; an unknown key falls back to the
 * monogram tile exactly as "no icon" does. First cut (owner: first cut, then
 * prune) -- keep it under ~40 and keep every path 24x24 stroke-only.
 */
export const COMMAND_ICON_KEYS = [
  'terminal', 'play', 'stop', 'refresh', 'wrench', 'hammer', 'box', 'rocket', 'flag', 'bolt',
  'check', 'x', 'bug', 'search', 'eye', 'edit', 'copy', 'trash', 'upload', 'download',
  'cloud', 'server', 'database', 'git', 'branch', 'pull', 'tag', 'lock', 'key', 'shield',
  'file', 'folder', 'list', 'chart', 'clock', 'bell', 'chat', 'globe', 'link', 'star',
] as const
export type CommandIconKey = typeof COMMAND_ICON_KEYS[number]

/** SVG path data per key (viewBox 0 0 24 24, stroke-only). */
const PATHS: Record<CommandIconKey, string> = {
  terminal: 'M4 17l6-6-6-6M12 19h8',
  play: 'M6 3l14 9-14 9z',
  stop: 'M6 6h12v12H6z',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  hammer: 'M15 12l-8.5 8.5a2.12 2.12 0 0 1-3-3L12 9M17.64 15L22 10.64M20.91 11.7l-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47l2.26 1.91',
  box: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12',
  rocket: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
  bolt: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  bug: 'M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  cloud: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z',
  server: 'M2 2h20v8H2zM2 14h20v8H2zM6 6h.01M6 18h.01',
  database: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3zM21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5',
  git: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  branch: 'M6 3v12M18 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 12c0 3-3 4-6 4-2 0-4 0-6 2',
  pull: 'M16 4h4v4M20 4l-7 7M8 20H4v-4M4 20l7-7',
  tag: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01',
  lock: 'M4 11h16v10H4zM8 11V7a4 4 0 0 1 8 0v4',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  chart: 'M18 20V10M12 20V4M6 20v-6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 6v6l4 2',
  bell: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  chat: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
}

export function isCommandIconKey(key: unknown): key is CommandIconKey {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(PATHS, key)
}

/** The first letter of a label, for the monogram tile. */
export function monogramOf(label: string): string {
  const ch = (label || '').trim().charAt(0)
  return ch ? ch.toUpperCase() : '?'
}

interface IconProps {
  icon?: string | null
  /** The command's colour; drives the glyph stroke or the tile tint. */
  color: string
  label: string
  /** Pixel size of the glyph / tile. 13 on the bar, 14 in lists. */
  size?: number
  className?: string
}

/**
 * The icon a command chip wears: the chosen glyph drawn in the command's
 * colour, or -- when none is chosen or the key is unknown -- a monogram tile:
 * the label's first letter on a 15% tint of the colour. Colour lives HERE and
 * never on the chip surface, so a row of buttons stays calm.
 */
export function CommandIcon({ icon, color, label, size = 13, className }: IconProps) {
  if (isCommandIconKey(icon)) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`shrink-0 ${className ?? ''}`}
        aria-hidden
        data-testid="command-icon-glyph"
        data-icon={icon}
      >
        <path d={PATHS[icon]} />
      </svg>
    )
  }
  return (
    <span
      className={`inline-grid place-items-center shrink-0 rounded font-extrabold leading-none ${className ?? ''}`}
      style={{
        width: size + 1,
        height: size + 1,
        fontSize: Math.round(size * 0.62),
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
      aria-hidden
      data-testid="command-icon-monogram"
    >
      {monogramOf(label)}
    </span>
  )
}
