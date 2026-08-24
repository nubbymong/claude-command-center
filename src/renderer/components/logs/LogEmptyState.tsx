// src/renderer/components/logs/LogEmptyState.tsx
//
// Layout C empty states for the chat-transcript surfaces. These render in the
// pane chrome INSTEAD of the transcript when there is nothing (or nothing that
// will ever be) indexed for the current scope. Copy follows the spec
// (2026-06-06 design, decision 11 / empty-states list): each named regression
// (SSH remote, Codex) is surfaced HONESTLY, not silently blank.
//
// Pure/presentational; Catppuccin tokens; a 200ms fade matches the rest of the
// logs UI.

/** The distinct empty reasons a transcript surface can render. */
export type LogEmptyReason =
  | 'shell-only'
  | 'ssh'
  | 'codex'
  | 'logging-off'
  | 'no-transcript'
  | 'select' // global view, nothing selected yet

export interface LogEmptyStateProps {
  reason: LogEmptyReason
  /** For 'no-transcript': the cwd CCC is watching for a transcript (diagnosable). */
  watchedCwd?: string | null
  className?: string
}

interface Copy {
  title: string
  body: string
}

function copyFor(reason: LogEmptyReason, watchedCwd?: string | null): Copy {
  switch (reason) {
    case 'shell-only':
      return {
        title: 'No transcript for shell sessions',
        body: 'Shell-only sessions do not run Claude, so there is no conversation to index.',
      }
    case 'ssh':
      return {
        title: 'Remote session — no local transcript',
        body: "SSH sessions write their transcript on the remote host, so AI Code Conductor can't index them here.",
      }
    case 'codex':
      return {
        title: "Codex sessions aren't indexed",
        body: 'Codex uses a different transcript format. Indexing Codex conversations is planned for a future release.',
      }
    case 'logging-off':
      return {
        title: 'Conversation indexing is off',
        body: 'Turn indexing on in Settings (or for this session) to record and browse the conversation.',
      }
    case 'no-transcript':
      return {
        title: 'No conversation detected yet',
        body: watchedCwd
          ? `Watching ${watchedCwd} for Claude's transcript — turns appear here as the conversation starts.`
          : "Watching for Claude's transcript — turns appear here as the conversation starts.",
      }
    case 'select':
    default:
      return {
        title: 'Select a slot',
        body: 'Choose a session slot on the left to view its conversation, or search across everything above.',
      }
  }
}

/** A centred, muted empty state matching the Layout C transcript chrome. */
export default function LogEmptyState({ reason, watchedCwd, className }: LogEmptyStateProps) {
  const { title, body } = copyFor(reason, watchedCwd)
  return (
    <div
      data-testid="log-empty-state"
      data-reason={reason}
      className={`flex h-full flex-1 items-center justify-center bg-[var(--surface-stage)] ${className ?? ''}`}
      style={{ transition: 'opacity 200ms ease' }}
    >
      <div className="max-w-[300px] px-6 text-center">
        <h3 className="mb-1.5 text-sm font-medium text-[var(--text-secondary)]">{title}</h3>
        <p className="text-xs leading-relaxed text-[var(--text-muted)] break-words">{body}</p>
      </div>
    </div>
  )
}
