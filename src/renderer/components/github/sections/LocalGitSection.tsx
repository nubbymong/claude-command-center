import { useEffect, useState } from 'react'
import SectionFrame from '../SectionFrame'
import type { LocalGitState } from '../../../../shared/github-types'
import { relativeTime } from '../../../utils/relativeTime'

interface Props {
  sessionId: string
  cwd?: string
}

export default function LocalGitSection({ sessionId, cwd }: Props) {
  const [state, setState] = useState<LocalGitState | null>(null)

  useEffect(() => {
    // Reset to loading state on cwd change so the section doesn't briefly
    // render the previous repo's branch/status while the first new poll
    // is in flight.
    setState(null)
    if (!cwd) return
    let alive = true
    const poll = async () => {
      try {
        const r = await window.electronAPI.github.getLocalGit(cwd)
        if (alive && r.ok) setState(r.state as LocalGitState)
      } catch {
        // Keep the previous state; a transient IPC failure shouldn't
        // flip the section to empty, and swallowing here prevents an
        // unhandled rejection every poll tick.
      }
    }
    void poll()
    const t = setInterval(poll, 15_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [cwd])

  if (!cwd) {
    return (
      <SectionFrame sessionId={sessionId} id="localGit" title="Local Git" emptyIndicator>
        <div className="text-xs text-overlay0">No working directory</div>
      </SectionFrame>
    )
  }

  if (!state) {
    return (
      <SectionFrame sessionId={sessionId} id="localGit" title="Local Git" emptyIndicator>
        <div className="text-xs text-overlay0">Loading</div>
      </SectionFrame>
    )
  }

  const dirtyCount = state.staged.length + state.unstaged.length + state.untracked.length
  const empty = !state.branch
  // Suppress summary when there's no branch — "clean" against a missing
  // repo would mislead the user. The empty indicator in the section
  // header already conveys the "no git here" state at a glance.
  const summary = empty ? undefined : dirtyCount > 0 ? `${dirtyCount} changes` : 'clean'

  return (
    <SectionFrame
      sessionId={sessionId}
      id="localGit"
      title="Local Git"
      summary={summary}
      emptyIndicator={empty}
    >
      {state.branch && (
        <div className="space-y-2 text-xs">
          <div className="text-subtext0">
            On <span className="text-text">{state.branch}</span>
            {state.ahead > 0 && (
              <span className="text-green ml-2">
                {String.fromCodePoint(0x2191)}
                {state.ahead}
              </span>
            )}
            {state.behind > 0 && (
              <span className="text-teal ml-1">
                {String.fromCodePoint(0x2193)}
                {state.behind}
              </span>
            )}
          </div>
          {state.staged.length > 0 && (
            <details>
              <summary className="cursor-pointer text-green">
                Staged ({state.staged.length})
              </summary>
              <ul className="ml-4 text-overlay1">
                {state.staged.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </details>
          )}
          {state.unstaged.length > 0 && (
            <details>
              <summary className="cursor-pointer text-peach">
                Unstaged ({state.unstaged.length})
              </summary>
              <ul className="ml-4 text-overlay1">
                {state.unstaged.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </details>
          )}
          {state.untracked.length > 0 && (
            <details>
              <summary className="cursor-pointer text-overlay1">
                Untracked ({state.untracked.length})
              </summary>
              <ul className="ml-4 text-overlay1">
                {state.untracked.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </details>
          )}
          {state.recentCommits.length > 0 && (
            <div className="pt-2 border-t border-surface0">
              <div className="text-subtext0 mb-1">Recent commits</div>
              <ul className="space-y-0.5">
                {state.recentCommits.map((c) => (
                  <li key={c.sha} className="flex gap-2">
                    <code className="text-mauve">{c.sha}</code>
                    <span className="text-overlay1 truncate flex-1" title={c.subject}>
                      {c.subject}
                    </span>
                    <span className="text-overlay0 shrink-0">{relativeTime(c.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {state.stashCount > 0 && (
            <div className="text-overlay1 pt-1">Stash: {state.stashCount}</div>
          )}
        </div>
      )}
    </SectionFrame>
  )
}
