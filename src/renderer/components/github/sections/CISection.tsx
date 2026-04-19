import { useState } from 'react'
import SectionFrame from '../SectionFrame'
import { useGitHubStore } from '../../../stores/githubStore'
import type { WorkflowRunSnapshot } from '../../../../shared/github-types'

interface Props {
  sessionId: string
  slug?: string
}

function runIcon(r: WorkflowRunSnapshot): string {
  if (r.conclusion === 'success') return String.fromCodePoint(0x2713)
  if (r.conclusion === 'failure') return String.fromCodePoint(0x2717)
  if (r.status === 'in_progress' || r.status === 'queued') return String.fromCodePoint(0x25cc)
  return String.fromCodePoint(0x2014)
}

function runColor(r: WorkflowRunSnapshot): string {
  if (r.conclusion === 'success') return 'text-green'
  if (r.conclusion === 'failure') return 'text-red'
  if (r.status !== 'completed') return 'text-yellow'
  return 'text-overlay1'
}

export default function CISection({ sessionId, slug }: Props) {
  const data = useGitHubStore((s) => (slug ? s.repoData[slug] : undefined))
  const runs = data?.actions ?? []
  const [rerunning, setRerunning] = useState<number | null>(null)
  const empty = runs.length === 0

  const rerun = async (id: number) => {
    if (!slug) return
    setRerunning(id)
    try {
      await window.electronAPI.github.rerunActionsRun(slug, id)
    } finally {
      // Always clear, even on rejection — otherwise a network error leaves
      // the Re-run button permanently disabled.
      setRerunning(null)
    }
  }

  const failed = runs.filter((r) => r.conclusion === 'failure').length
  const summary = empty ? undefined : failed > 0 ? `${failed} failed` : 'all passing'

  return (
    <SectionFrame
      sessionId={sessionId}
      id="ci"
      title="CI / Actions"
      summary={summary}
      emptyIndicator={empty}
    >
      <div className="space-y-1 text-xs">
        {runs.map((r) => (
          <div key={r.id} className="flex items-center gap-2">
            <span className={runColor(r)} aria-label={r.conclusion ?? r.status}>
              {runIcon(r)}
            </span>
            <span className="text-text truncate flex-1" title={r.workflowName}>
              {r.workflowName}
            </span>
            <button
              onClick={() => void window.electronAPI.shell.openExternal(r.url)}
              className="text-overlay1 hover:text-text"
              aria-label="Open run in GitHub"
            >
              {String.fromCodePoint(0x2197)}
            </button>
            {r.conclusion === 'failure' && slug && (
              <button
                onClick={() => rerun(r.id)}
                disabled={rerunning === r.id}
                className="bg-surface0 hover:bg-surface1 px-1.5 py-0.5 rounded text-xs"
              >
                {rerunning === r.id ? '...' : 'Re-run'}
              </button>
            )}
          </div>
        ))}
      </div>
    </SectionFrame>
  )
}
