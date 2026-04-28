import React from 'react'
import HeaderCluster from './HeaderCluster'

type Accent =
  | 'blue' | 'teal' | 'mauve' | 'peach' | 'green' | 'yellow' | 'red'
  | 'sapphire' | 'sky' | 'pink' | 'lavender' | 'rosewater' | 'flamingo'
  | 'maroon' | 'overlay1'

// Tailwind v4's JIT scans for *literal* class names, so `text-${accent}`
// would never get generated. Map the prop to a fixed string the scanner
// can see at build time.
const ACCENT_CLASS: Record<Accent, string> = {
  blue: 'text-blue', teal: 'text-teal', mauve: 'text-mauve', peach: 'text-peach',
  green: 'text-green', yellow: 'text-yellow', red: 'text-red',
  sapphire: 'text-sapphire', sky: 'text-sky', pink: 'text-pink',
  lavender: 'text-lavender', rosewater: 'text-rosewater', flamingo: 'text-flamingo',
  maroon: 'text-maroon', overlay1: 'text-overlay1',
}

interface Props {
  /** SVG glyph for the page. Inherits `currentColor` so the accent class on the wrapper colours it. */
  icon?: React.ReactNode
  /** Accent colour for the icon. Defaults to overlay1 (no accent). */
  iconAccent?: Accent
  /** Page name. Always required. */
  title: string
  /** Optional secondary line: active sub-section, key metric, breadcrumb, etc. */
  context?: React.ReactNode
  /** Right-aligned page-specific buttons / selectors (rendered before the global HeaderCluster). */
  actions?: React.ReactNode
  /** Optional left rail (sub-nav). When present, body sits to its right. */
  leftRail?: React.ReactNode
  /** When true (default), the body wraps its content in `overflow-y-auto`
   * so pages with simple top-down forms scroll automatically. Set false
   * for pages whose body is itself a horizontal split (Memory's
   * main+detail) or otherwise manages its own overflow. */
  scrollable?: boolean
  /** Body content. */
  children: React.ReactNode
}

/**
 * Shared chrome for global ("admin") views — Settings, Tokenomics,
 * Memory, Vision, Insights, Cloud Agents, Logs. Mirrors the visual
 * weight of <TabBar> (same `bg-crust border-b` strip, same height) so
 * switching from a session view to a global view doesn't shift the
 * page chrome around.
 *
 * Layout: one thin top strip (icon + title + context | actions +
 * HeaderCluster), then either a single body or a [left rail | body]
 * split. Body always uses full width — pages that want narrower
 * forms should self-impose `max-w-3xl mx-auto` *inside* their own
 * content, never on this frame.
 */
export default function PageFrame({
  icon,
  iconAccent = 'overlay1',
  title,
  context,
  actions,
  leftRail,
  scrollable = true,
  children,
}: Props) {
  return (
    <div className="flex-1 flex flex-col bg-base overflow-hidden min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface0 bg-crust shrink-0">
        {icon && (
          <span className={`${ACCENT_CLASS[iconAccent]} shrink-0 flex items-center`}>{icon}</span>
        )}
        {/* Title + context share an items-baseline flex so mixed font
            sizes line up on the text baseline instead of the visual
            centre — without this the smaller context text appears to
            float above the title baseline (Memory header bug). */}
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-xs font-medium text-text shrink-0">{title}</span>
          {context && (
            <>
              <span className="text-[11px] text-surface2 shrink-0">·</span>
              <span className="text-[11px] text-overlay0 truncate min-w-0">{context}</span>
            </>
          )}
        </div>
        <div className="flex-1" />
        {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
        <div className="w-px h-4 bg-surface0 mx-1 shrink-0" />
        <HeaderCluster />
      </div>
      {leftRail ? (
        <div className="flex-1 flex flex-row min-h-0">
          <div className="w-44 shrink-0 flex flex-col border-r border-surface0 bg-mantle/40 overflow-y-auto">
            {leftRail}
          </div>
          <div className={`flex-1 min-w-0 ${scrollable ? 'overflow-y-auto' : 'flex flex-col min-h-0'}`}>
            {children}
          </div>
        </div>
      ) : (
        <div className={`flex-1 min-h-0 ${scrollable ? 'overflow-y-auto' : 'flex flex-col'}`}>
          {children}
        </div>
      )}
    </div>
  )
}
