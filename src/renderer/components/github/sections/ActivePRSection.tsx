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
  const ready = async () => {
    await window.electronAPI.github.readyPR(slug, pr.number)
  }
  const merge = async (method: 'merge' | 'squash' | 'rebase') => {
    await window.electronAPI.github.mergePR(slug, pr.number, method)
  }

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
              className="bg-surface0 hover:bg-surface1 px-2 py-0.5 rounded text-xs"
            >
              Ready for review
            </button>
          )}
          {pr.mergeableState === 'clean' &&
            pr.allowedMergeMethods?.map((m) => (
              <button
                key={m}
                onClick={() => merge(m)}
                className="bg-blue/20 hover:bg-blue/40 text-blue px-2 py-0.5 rounded text-xs capitalize"
              >
                {m}
              </button>
            ))}
        </div>
      </div>
    </SectionFrame>
  )
}
