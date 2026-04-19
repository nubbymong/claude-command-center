import { useEffect, useState } from 'react'
import SectionFrame from '../SectionFrame'
import type { SessionContextResult } from '../../../../shared/github-types'
import { relativeTime } from '../../../utils/relativeTime'

interface Props {
  sessionId: string
}

export default function SessionContextSection({ sessionId }: Props) {
  const [ctx, setCtx] = useState<SessionContextResult | null>(null)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const r = await window.electronAPI.github.getSessionContext(sessionId)
        if (alive && r.ok) setCtx(r.data as SessionContextResult | null)
      } catch {
        // Swallow — preserve the last good context rather than crashing
        // the poll loop on a transient IPC failure.
      }
    }
    void poll()
    const t = setInterval(poll, 20_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [sessionId])

  const empty =
    !ctx || (!ctx.primaryIssue && !ctx.activePR && ctx.recentFiles.length === 0)
  const summary = ctx?.primaryIssue ? `#${ctx.primaryIssue.number}` : undefined

  return (
    <SectionFrame
      sessionId={sessionId}
      id="sessionContext"
      title="Session Context"
      summary={summary}
      emptyIndicator={empty}
    >
      {ctx && !empty ? (
        <div className="text-xs space-y-2">
          {ctx.primaryIssue && (
            <div>
              <span className="text-subtext0">Working on: </span>
              <span className="text-blue">#{ctx.primaryIssue.number}</span>
              {ctx.primaryIssue.title && (
                <span className="text-text ml-1">{ctx.primaryIssue.title}</span>
              )}
              {ctx.primaryIssue.state && (
                <span
                  className={`ml-2 text-[10px] px-1 rounded ${
                    ctx.primaryIssue.state === 'open'
                      ? 'bg-green/20 text-green'
                      : 'bg-overlay0/20 text-overlay1'
                  }`}
                >
                  {ctx.primaryIssue.state}
                </span>
              )}
            </div>
          )}
          {ctx.otherSignals.length > 0 && (
            <details className="text-overlay1">
              <summary className="cursor-pointer">
                Other signals ({ctx.otherSignals.length})
              </summary>
              <ul className="ml-4">
                {ctx.otherSignals.map((s) => (
                  <li key={`${s.source}:${s.repo ?? ''}:${s.number}`}>
                    #{s.number} <span className="text-overlay0">({s.source})</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {ctx.activePR && (
            <div>
              <span className="text-subtext0">Related PR: </span>
              <span className="text-mauve">#{ctx.activePR.number}</span>
              <span className="text-overlay0 ml-1">
                {ctx.activePR.draft ? 'draft' : ctx.activePR.state}
              </span>
            </div>
          )}
          {ctx.recentFiles.length > 0 && (
            <div>
              <div className="text-subtext0">Claude recently edited:</div>
              <ul className="ml-3">
                {ctx.recentFiles.slice(0, 5).map((f) => (
                  <li key={f.filePath} className="flex gap-2">
                    <code className="text-peach truncate" title={f.filePath}>
                      {f.filePath}
                    </code>
                    <span className="text-overlay0 shrink-0">{relativeTime(f.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-overlay0">No session context yet</div>
      )}
    </SectionFrame>
  )
}
