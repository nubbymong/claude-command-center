import { memo, useState } from 'react'
import { SanitizedMarkdown } from '../github/SanitizedMarkdown'
import { renderTranscriptMarkdown } from '../../utils/markdownSanitizer'

/**
 * Renders one transcript message body (kind==='message') as sanitized markdown.
 *
 * Security: routes through the single audited `SanitizedMarkdown` render site
 * with `renderTranscriptMarkdown` — the IDENTICAL hardened allowlist used for
 * GitHub comments (https-only links, no <img>, no inline event handlers, no
 * <script>). Transcript content is untrusted, so the allowlist is not loosened.
 *
 * Long messages: clamped to ~`clampLines` rendered lines with a "Show more"
 * expander. The collapsed body is capped by max-height (CSS line-clamp by row
 * count) so a wall-of-text turn doesn't dominate the transcript; the expander
 * only appears once the content is long enough to be clipped.
 *
 * Memoized: re-renders only when `content`/`clampLines` change (shallow primitive
 * compare). The transcript window can re-render frequently as new turns stream
 * in; this keeps already-rendered messages stable.
 */
export interface MarkdownMessageProps {
  content: string
  /** Rendered-line clamp before the "show more" expander appears. Default ~80. */
  clampLines?: number
}

function MarkdownMessageImpl({ content, clampLines = 80 }: MarkdownMessageProps) {
  const [expanded, setExpanded] = useState(false)

  // Heuristic line count: source newlines are a faithful proxy for rendered
  // rows for transcript prose (jsdom has no layout, and measuring scrollHeight
  // at runtime would flash the full content before clamping). A turn longer
  // than the clamp gets the expander; shorter turns render verbatim.
  const lineCount = content.length === 0 ? 0 : content.split('\n').length
  const clampable = lineCount > clampLines
  const clamped = clampable && !expanded

  return (
    <div className="logs-md">
      <div
        data-clamped={clamped ? 'true' : 'false'}
        className="overflow-hidden transition-[max-height] duration-200 ease-out"
        style={
          clamped
            ? // ~1.5rem per clamped row — a soft cap that fades the tail.
              { maxHeight: `${clampLines * 1.5}rem` }
            : undefined
        }
      >
        <SanitizedMarkdown
          source={content}
          render={renderTranscriptMarkdown}
          className="logs-md-body text-sm leading-relaxed text-[var(--text-primary)] max-w-none"
        />
      </div>
      {clampable && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs font-medium text-[var(--accent)] hover:underline focus:outline focus:outline-1 focus:outline-[var(--accent)] rounded"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

const MarkdownMessage = memo(MarkdownMessageImpl)
MarkdownMessage.displayName = 'MarkdownMessage'

export default MarkdownMessage
