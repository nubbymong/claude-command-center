import { ChangelogEntry } from '../changelog'

// Shared renderer for the What's New changelog, used by BOTH surfaces so they
// never drift: the full-screen WhatsNewModal shown after install/upgrade, and
// the browsable "What's New" section inside the Feature Guide.

const TYPE_COLORS: Record<string, string> = {
  feature: 'text-green',
  fix: 'text-red',
  improvement: 'text-blue',
}
const TYPE_LABELS: Record<string, string> = {
  feature: 'New',
  fix: 'Fix',
  improvement: 'Improved',
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function VersionSection({ entry }: { entry: ChangelogEntry }) {
  return (
    <div className="mb-6 last:mb-0">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-lg font-bold text-text">v{entry.version}</span>
        <span className="text-xs text-overlay0">{formatDate(entry.date)}</span>
      </div>
      {entry.highlights && (
        <p className="text-sm text-subtext1 mb-3 italic">{entry.highlights}</p>
      )}
      <ul className="space-y-1.5">
        {entry.changes.map((change, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className={`${TYPE_COLORS[change.type]} font-medium shrink-0 w-16`}>
              {TYPE_LABELS[change.type]}
            </span>
            <span className="text-subtext0">{change.description}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The changelog as a stack of version sections, newest first (as ordered). */
export function WhatsNewEntries({ entries }: { entries: ChangelogEntry[] }) {
  return (
    <>
      {entries.map((entry) => (
        <VersionSection key={entry.version} entry={entry} />
      ))}
    </>
  )
}
