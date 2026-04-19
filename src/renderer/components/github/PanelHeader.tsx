import { relativeTime } from '../../utils/relativeTime'

interface Props {
  branch?: string
  ahead?: number
  behind?: number
  dirty?: number
  syncState: 'idle' | 'syncing' | 'synced' | 'rate-limited' | 'error'
  syncedAt?: number
  nextResetAt?: number
  onRefresh: () => void
}

export default function PanelHeader({
  branch,
  ahead,
  behind,
  dirty,
  syncState,
  syncedAt,
  nextResetAt,
  onRefresh,
}: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-surface0 bg-mantle">
      {branch && (
        <span
          className="text-sm bg-surface0 px-2 py-0.5 rounded truncate max-w-[60%]"
          title={branch}
        >
          {branch}
        </span>
      )}
      {typeof ahead === 'number' && ahead > 0 && (
        <span className="text-green text-xs">
          {String.fromCodePoint(0x2191)}
          {ahead}
        </span>
      )}
      {typeof behind === 'number' && behind > 0 && (
        <span className="text-teal text-xs">
          {String.fromCodePoint(0x2193)}
          {behind}
        </span>
      )}
      {typeof dirty === 'number' && dirty > 0 && (
        <span className="text-peach text-xs">
          {String.fromCodePoint(0x25cf)}
          {dirty}
        </span>
      )}

      <span className="ml-auto text-xs" aria-live="polite">
        {syncState === 'idle' && <span className="text-overlay0">idle</span>}
        {syncState === 'syncing' && (
          <span className="text-yellow">
            {String.fromCodePoint(0x25cf)} syncing
          </span>
        )}
        {syncState === 'synced' && syncedAt && (
          <span className="text-green">synced {relativeTime(syncedAt)}</span>
        )}
        {syncState === 'rate-limited' && (
          <span
            className="text-yellow"
            title={
              nextResetAt
                ? `resets at ${new Date(nextResetAt).toLocaleTimeString()}`
                : undefined
            }
          >
            rate limited
          </span>
        )}
        {syncState === 'error' && <span className="text-red">error</span>}
      </span>
      <button
        onClick={onRefresh}
        title="Refresh"
        aria-label="Refresh"
        className="text-overlay1 hover:text-text"
      >
        {String.fromCodePoint(0x21bb)}
      </button>
    </div>
  )
}
