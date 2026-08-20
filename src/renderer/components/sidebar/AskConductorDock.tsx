import { useSessionStore } from '../../stores/sessionStore'
import { launchAskConductor, useAskErrorStore, ASK_LABEL } from '../../lib/askConductor'
import { BrandMark } from '../BrandMark'

/**
 * Ask Conductor, docked at the bottom of the sidebar.
 *
 * The separation from project sessions is positional, not structural: this is a
 * real session with a real tab like any other, it just does not belong in your
 * project list because you did not create it and it is not about your code. It
 * sits below a divider, pinned under the scrolling session list.
 */

interface Props {
  /** Collapsed icon rail: no label, no subtitle, just the mark. */
  collapsed?: boolean
  /** Bring the sessions view forward after opening (the Ask tab is a session
   *  tab, so a page tab would otherwise stay in front of it). */
  onOpened: () => void
  /** True when the sessions view is showing and the Ask session is the active tab. */
  isActive: boolean
}

export default function AskConductorDock({ collapsed, onOpened, isActive }: Props) {
  const askSession = useSessionStore((s) => s.sessions.find((sess) => sess.kind === 'ask'))
  const error = useAskErrorStore((s) => s.error)
  const running = !!askSession

  const open = () => {
    void launchAskConductor().then((id) => { if (id) onOpened() })
  }

  const title = running
    ? `${ASK_LABEL} -- go to the open session`
    : `${ASK_LABEL} -- ask about this app`

  if (collapsed) {
    return (
      <div className="mt-auto shrink-0 p-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
        <button
          type="button"
          data-ux-id="sidebar-ask-pill"
          onClick={open}
          title={title}
          aria-label={title}
          className="w-8 h-8 mx-auto flex items-center justify-center rounded-lg transition-colors focus-ring relative"
          style={{
            background: `color-mix(in srgb, var(--brand) ${isActive ? 22 : 13}%, transparent)`,
            border: '1px solid color-mix(in srgb, var(--brand) 42%, transparent)',
          }}
        >
          <BrandMark className="w-4 h-4" />
          {running && (
            <span
              className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
              style={{ background: 'var(--status-success)' }}
              aria-hidden
            />
          )}
        </button>
      </div>
    )
  }

  return (
    <div
      data-ux-id="sidebar-dockzone"
      className="shrink-0 p-2 border-t"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'linear-gradient(180deg, transparent, color-mix(in srgb, var(--brand) 7%, transparent))',
      }}
    >
      <button
        type="button"
        data-ux-id="sidebar-ask-pill"
        onClick={open}
        title={title}
        className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left transition-colors focus-ring"
        style={{
          background: `color-mix(in srgb, var(--brand) ${isActive ? 22 : 13}%, transparent)`,
          border: '1px solid color-mix(in srgb, var(--brand) 42%, transparent)',
        }}
      >
        <BrandMark className="w-[17px] h-[17px] shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {ASK_LABEL}
          </span>
          <span className="block text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
            About this app
          </span>
        </span>
        {running && (
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: 'var(--status-success)' }}
            title="Running"
            aria-label="Running"
          />
        )}
      </button>
      {/* `help:workspace` fails closed to null when the resources directory
          cannot be written. Every entry point routes through this one dock, so
          this is the single place a silent no-op becomes visible. */}
      {error && (
        <p data-ux-id="sidebar-ask-error" className="mt-1.5 px-1 text-[10px] leading-snug" style={{ color: 'var(--status-danger)' }}>
          {error}
        </p>
      )}
    </div>
  )
}
