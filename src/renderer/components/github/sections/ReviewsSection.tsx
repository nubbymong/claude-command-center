import { useState } from 'react'
import SectionFrame from '../SectionFrame'
import { useGitHubStore } from '../../../stores/githubStore'
import { SanitizedMarkdown } from '../SanitizedMarkdown'

interface Props {
  sessionId: string
  slug?: string
}

export default function ReviewsSection({ sessionId, slug }: Props) {
  const data = useGitHubStore((s) => (slug ? s.repoData[slug] : undefined))
  const reviews = data?.reviews ?? []
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')

  const allThreads = reviews.flatMap((r) => r.threads)
  const unresolved = allThreads.filter((t) => !t.resolved)
  const empty = allThreads.length === 0 && reviews.length === 0

  const send = async (threadId: string) => {
    if (!slug) return
    await window.electronAPI.github.replyToReview(slug, threadId, replyText)
    setReplyingTo(null)
    setReplyText('')
  }

  return (
    <SectionFrame
      sessionId={sessionId}
      id="reviews"
      title="Reviews & Comments"
      summary={empty ? undefined : `${unresolved.length} open`}
      emptyIndicator={empty}
    >
      <div className="space-y-3 text-xs">
        {reviews.map((r) => (
          <div key={r.id} className="flex items-center gap-2 text-overlay1">
            {/* Initials monogram per spec §9 avatar strategy — CSP blocks
                remote https <img>, and the PR 2 plan captured avatarUrl
                for a future main-process data: URL proxy. */}
            <div
              className="w-5 h-5 rounded-full bg-surface0 text-text flex items-center justify-center text-[9px] font-semibold shrink-0"
              aria-hidden="true"
            >
              {r.reviewer.trim().slice(0, 2).toUpperCase()}
            </div>
            <span>@{r.reviewer}</span>
            <span
              className={
                r.state === 'APPROVED'
                  ? 'text-green'
                  : r.state === 'CHANGES_REQUESTED'
                  ? 'text-red'
                  : 'text-overlay1'
              }
            >
              {r.state.toLowerCase().replace('_', ' ')}
            </span>
          </div>
        ))}
        {unresolved.map((t) => (
          <div key={t.id} className="border-l-2 border-surface0 pl-2 space-y-1">
            <div className="text-overlay0">
              @{t.commenter} on{' '}
              <code className="text-peach">
                {t.file}:{t.line}
              </code>
            </div>
            {/* Spec §9: SanitizedMarkdown is the ONLY dangerouslySetInnerHTML
                render site in this feature. It routes <a href=https://...>
                clicks through window.electronAPI.shell.openExternal because
                the app blocks will-navigate and denies window.open — raw
                anchor clicks would otherwise be inert. */}
            <SanitizedMarkdown source={t.bodyMarkdown} />
            {replyingTo === t.id ? (
              <div className="flex gap-1">
                <input
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  className="flex-1 bg-surface0 p-1 rounded text-xs"
                  placeholder="Reply"
                />
                <button
                  onClick={() => send(t.id)}
                  className="bg-blue text-base px-2 py-0.5 rounded text-xs"
                >
                  Send
                </button>
                <button onClick={() => setReplyingTo(null)} className="text-overlay1">
                  {String.fromCodePoint(0x00d7)}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setReplyingTo(t.id)}
                className="text-blue text-xs"
              >
                Reply
              </button>
            )}
          </div>
        ))}
      </div>
    </SectionFrame>
  )
}
