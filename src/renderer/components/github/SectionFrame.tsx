import type { ReactNode } from 'react'
import { useGitHubStore } from '../../stores/githubStore'

interface Props {
  sessionId: string
  id: string
  title: string
  summary?: ReactNode
  rightAction?: ReactNode
  emptyIndicator?: boolean
  defaultCollapsed?: boolean
  children: ReactNode
}

export default function SectionFrame({
  sessionId,
  id,
  title,
  summary,
  rightAction,
  emptyIndicator,
  defaultCollapsed,
  children,
}: Props) {
  const saved = useGitHubStore((s) => s.sessionStates[sessionId]?.collapsedSections[id])
  const collapsed = saved ?? defaultCollapsed ?? false
  const setCollapsed = useGitHubStore((s) => s.setSectionCollapsed)

  return (
    <section className="border-b border-surface0" data-section-id={id}>
      <button
        aria-expanded={!collapsed}
        aria-controls={`sec-body-${id}`}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface0/50 focus:outline focus:outline-2 focus:outline-blue"
        onClick={() => setCollapsed(sessionId, id, !collapsed)}
      >
        <span className="text-xs text-mauve w-3" aria-hidden="true">
          {collapsed ? String.fromCodePoint(0x25b6) : String.fromCodePoint(0x25bc)}
        </span>
        <span className="text-xs font-medium uppercase text-subtext0 tracking-wide">{title}</span>
        {summary && <span className="text-xs text-overlay1 ml-2 truncate">{summary}</span>}
        {/* Group right-side content in a single ml-auto container so emptyIndicator
            and rightAction can coexist without reflow ambiguity. */}
        {(emptyIndicator || rightAction) && (
          <span className="ml-auto flex items-center gap-2 shrink-0">
            {emptyIndicator && (
              <span className="text-xs text-overlay0" aria-label="empty">
                {String.fromCodePoint(0x2014)}
              </span>
            )}
            {rightAction && <span>{rightAction}</span>}
          </span>
        )}
      </button>
      {!collapsed && (
        <div id={`sec-body-${id}`} className="px-3 pb-3">
          {children}
        </div>
      )}
    </section>
  )
}
