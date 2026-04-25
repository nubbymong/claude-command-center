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
  // Auto-collapse empty sections so the right rail isn't dominated by
  // four "No PR for this branch / No issues / No reviews / No context"
  // body strings stacked vertically. Header still shows with its em-dash
  // empty indicator; user can expand to read the placeholder if curious.
  // Once the user makes an explicit choice (saved !== undefined), respect
  // it — that includes "I expanded the empty section deliberately".
  const collapsed = saved ?? (emptyIndicator ? true : (defaultCollapsed ?? false))
  const setCollapsed = useGitHubStore((s) => s.setSectionCollapsed)

  return (
    <section className="border-b border-surface0" data-section-id={id}>
      <button
        aria-expanded={!collapsed}
        aria-controls={`sec-body-${id}`}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface0/50 focus:outline focus:outline-2 focus:outline-blue"
        onClick={() => setCollapsed(sessionId, id, !collapsed)}
      >
        {/* Expanded chevron picks up the per-session accent (CSS var set by
            GitHubPanel) so the active section feels owned by this session.
            Collapsed chevron stays muted — colorising the closed state would
            shout from every empty section header. */}
        <span
          className="text-xs w-3"
          style={{ color: collapsed ? 'var(--color-overlay0)' : 'var(--session-color, var(--color-mauve))' }}
          aria-hidden="true"
        >
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
