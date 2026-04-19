import { useState } from 'react'
import SectionFrame from '../SectionFrame'
import { useGitHubStore } from '../../../stores/githubStore'
import { relativeTime } from '../../../utils/relativeTime'

interface Props {
  sessionId: string
  slug?: string
}

export default function ActivePRSection({ sessionId, slug }: Props) {
  const data = useGitHubStore((s) => (slug ? s.repoData[slug] : undefined))
  const pr = data?.pr
  const [pending, setPending] = useState<'ready' | 'merge' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  if (!slug) {
    return (
      <SectionFrame sessionId={sessionId} id="activePR" title="Active PR" emptyIndicator>
        <div className="text-xs text-overlay0">No repo configured</div>
      </SectionFrame>
    )
  }
  if (!pr) {
    return (
      <SectionFrame sessionId={sessionId} id="activePR" title="Active PR" emptyIndicator>
        <div className="text-xs text-overlay0">No PR for this branch</div>
      </SectionFrame>
    )
  }

  // The app denies window.open via setWindowOpenHandler, so external links
  // must route through shell.openExternal (https-only enforcement lives
  // in the main-side handler).
  const open = () => void window.electronAPI.shell.openExternal(pr.url)

  const runAction = async (
    kind: 'ready' | 'merge',
    fn: () => Promise<{ ok: boolean; error?: string }>,
  ) => {
    setPending(kind)
    setActionError(null)
    try {
      const r = await fn()
      if (!r.ok) {
        setActionError(r.error ?? `${kind} failed`)
        setTimeout(() => setActionError(null), 4000)
      }
    } finally {
      setPending(null)
    }
  }
  const ready = () =>
    runAction('ready', () => window.electronAPI.github.readyPR(slug, pr.number))
  const merge = (method: 'merge' | 'squash' | 'rebase') =>
    runAction('merge', () => window.electronAPI.github.mergePR(slug, pr.number, method))

  return (
    <SectionFrame sessionId={sessionId} id="activePR" title="Active PR" summary={`#${pr.number}`}>
      <div className="text-xs space-y-1">
        <div className="text-text">{pr.title}</div>
        <div className="text-overlay1">
          @{pr.author} · {pr.draft ? 'draft' : pr.state} · {relativeTime(pr.updatedAt)}
        </div>
        <div className="text-subtext0">
          Mergeable:{' '}
          <span
            className={
              pr.mergeableState === 'clean'
                ? 'text-green'
                : pr.mergeableState === 'conflict'
                ? 'text-red'
                : 'text-overlay1'
            }
          >
            {pr.mergeableState}
          </span>
        </div>
        <div className="flex gap-1 pt-2 flex-wrap">
          <button
            onClick={open}
            className="bg-surface0 hover:bg-surface1 px-2 py-0.5 rounded text-xs"
          >
            Open in GitHub
          </button>
          {pr.draft && (
            <button
              onClick={ready}
              disabled={pending === 'ready'}
              className="bg-surface0 hover:bg-surface1 px-2 py-0.5 rounded text-xs disabled:opacity-50"
            >
              {pending === 'ready' ? 'Marking' : 'Ready for review'}
            </button>
          )}
          {pr.mergeableState === 'clean' &&
            pr.allowedMergeMethods?.map((m) => (
              <button
                key={m}
                onClick={() => merge(m)}
                disabled={pending === 'merge'}
                className="bg-blue/20 hover:bg-blue/40 text-blue px-2 py-0.5 rounded text-xs capitalize disabled:opacity-50"
              >
                {m}
              </button>
            ))}
        </div>
        {actionError && <div className="text-red text-[10px]">{actionError}</div>}
      </div>
    </SectionFrame>
  )
}
