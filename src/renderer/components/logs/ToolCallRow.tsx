import { memo, useState } from 'react'

/**
 * One collapsed tool-call row in the transcript (kind==='tool_call').
 *
 * Collapsed:  ⏺ {toolName} {preview} ▸
 * Expanded:   reveals the `toolMeta` args preview below the header.
 *
 * Sidechain variant (kind==='sidechain'): rendered muted (subagent / off the
 * main thread) per spec decision 3 / F9 — same shape, lower contrast.
 *
 * The ⏺ glyph is produced via `String.fromCodePoint(0x23FA)` — esbuild rejects
 * `\u{...}` escapes in JSX (CLAUDE.md), so we never inline the literal.
 */
const DOT = String.fromCodePoint(0x23fa) // ⏺ BLACK CIRCLE FOR RECORD
const CHEVRON_COLLAPSED = String.fromCodePoint(0x25b8) // ▸
const CHEVRON_EXPANDED = String.fromCodePoint(0x25be) // ▾

export interface ToolCallRowProps {
  toolName: string
  /** Args preview (JSON or string) as stored in messages.toolMeta; may be null. */
  toolMeta: string | null
  /** 'sidechain' renders the muted subagent variant. */
  kind?: 'tool_call' | 'sidechain'
}

/** First-line, length-bounded summary of the args for the collapsed row. */
function previewOf(meta: string | null): string {
  if (!meta) return ''
  const firstLine = meta.split('\n')[0].trim()
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
}

function ToolCallRowImpl({ toolName, toolMeta, kind = 'tool_call' }: ToolCallRowProps) {
  const [expanded, setExpanded] = useState(false)
  const isSidechain = kind === 'sidechain'
  const preview = previewOf(toolMeta)
  const hasDetail = !!toolMeta

  return (
    <div
      data-sidechain={isSidechain ? 'true' : undefined}
      className={
        isSidechain
          ? 'text-[var(--text-muted)]'
          : 'text-[var(--text-secondary)]'
      }
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1 text-left text-xs font-mono rounded hover:bg-[var(--surface-raised)]/50 focus:outline focus:outline-1 focus:outline-[var(--accent)] transition-colors duration-150"
      >
        <span aria-hidden="true" className={isSidechain ? 'text-[var(--text-muted)]' : 'text-[var(--accent)]'}>
          {DOT}
        </span>
        <span className="font-semibold text-[var(--text-primary)]">{toolName}</span>
        {preview && <span className="truncate text-[var(--text-muted)]">{preview}</span>}
        <span aria-hidden="true" className="ml-auto shrink-0 text-[var(--text-muted)]">
          {expanded ? CHEVRON_EXPANDED : CHEVRON_COLLAPSED}
        </span>
      </button>
      {expanded && hasDetail && (
        <pre
          data-tool-detail
          className="mt-1 ml-6 mr-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[var(--surface-sunken)] px-2 py-1.5 text-xs font-mono text-[var(--text-secondary)]"
        >
          {toolMeta}
        </pre>
      )}
    </div>
  )
}

const ToolCallRow = memo(ToolCallRowImpl)
ToolCallRow.displayName = 'ToolCallRow'

export default ToolCallRow
