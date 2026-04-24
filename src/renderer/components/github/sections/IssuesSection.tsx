import SectionFrame from '../SectionFrame'
import { useGitHubStore } from '../../../stores/githubStore'

interface Props {
  sessionId: string
  slug?: string
}

export default function IssuesSection({ sessionId, slug }: Props) {
  const data = useGitHubStore((s) => (slug ? s.repoData[slug] : undefined))
  const issues = data?.issues ?? []
  const empty = issues.length === 0

  return (
    <SectionFrame
      sessionId={sessionId}
      id="issues"
      title="Issues"
      summary={empty ? undefined : `${issues.length}`}
      emptyIndicator={empty}
    >
      <ul className="space-y-1 text-xs">
        {issues.map((i) => (
          <li key={i.number} className="flex items-start gap-2">
            <button
              onClick={() => void window.electronAPI.shell.openExternal(i.url)}
              className="text-blue hover:underline"
            >
              #{i.number}
            </button>
            {i.primary && (
              <span className="bg-mauve/20 text-mauve text-[10px] px-1 rounded">
                primary
              </span>
            )}
            <span className={i.state === 'open' ? 'text-green' : 'text-overlay0'}>
              {i.state}
            </span>
            <span className="text-text truncate flex-1" title={i.title}>
              {i.title}
            </span>
            {i.assignee && <span className="text-overlay1">@{i.assignee}</span>}
          </li>
        ))}
      </ul>
    </SectionFrame>
  )
}
