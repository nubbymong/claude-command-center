import React, { useState } from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTipsStore, countUnseenTips } from '../../stores/tipsStore'
import { launchAskConductor, useAskErrorStore, ASK_LABEL } from '../../lib/askConductor'
import { BrandMark } from '../BrandMark'
import DockRowMenu from './DockRowMenu'
import HideDockFeatureDialog, { type DockFeature } from '../HideDockFeatureDialog'

/**
 * The sidebar dock: Ask Conductor, and the tip of the day beneath it.
 *
 * The separation from project sessions is positional, not structural: Ask is a
 * real session with a real tab like any other, it just does not belong in your
 * project list because you did not create it and it is not about your code. It
 * sits below a divider, pinned under the scrolling session list.
 *
 * Tips moved here out of the per-session header (where they were a pill with
 * room for an icon and nothing else, competing with the account and notes
 * controls, and in a different place depending on which session was in front).
 * In the dock the trigger is always in the same place and wide enough to carry
 * the tip itself plus how many are new. The two rows are siblings because both
 * are "the app talking to you" rather than "your work" -- Ask in the brand
 * colour, tips in peach, so they read as a pair and not as duplicates.
 *
 * Either row can be hidden from its own right-click menu. That turns the
 * FEATURE off, not just the row (see HideDockFeatureDialog), and Settings ->
 * General is the way back.
 */

interface Props {
  /** Collapsed icon rail: no label, no subtitle, just the marks. */
  collapsed?: boolean
  /** Bring the sessions view forward after opening (the Ask tab is a session
   *  tab, so a page tab would otherwise stay in front of it). */
  onOpened: () => void
  /** True when the sessions view is showing and the Ask session is the active tab. */
  isActive: boolean
  /** Raise the tip modal. Absent means the host has no tip modal to raise, in
   *  which case the tip row is not rendered at all -- a trigger that does
   *  nothing is worse than no trigger. */
  onShowTip?: () => void
}

function LightbulbMark({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2z" />
    </svg>
  )
}

export default function AskConductorDock({ collapsed, onOpened, isActive, onShowTip }: Props) {
  const askSession = useSessionStore((s) => s.sessions.find((sess) => sess.kind === 'ask'))
  const error = useAskErrorStore((s) => s.error)
  const running = !!askSession

  // Absent means shown: an install that predates the setting must not silently
  // lose either entry point on upgrade.
  const showAsk = useSettingsStore((s) => s.settings.showAskConductor ?? true)
  const showTips = useSettingsStore((s) => s.settings.showTips ?? true)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const tracking = useTipsStore((s) => s.tracking)
  const currentTipId = useTipsStore((s) => s.currentTipId)
  const silenced = useTipsStore((s) => s.silencedUntilRestart)
  // Derived OUTSIDE the selector on purpose: getCurrentTip() builds a fresh
  // { tip, content } object every call, so selecting it directly would fail
  // zustand's Object.is check on every store touch and re-render for ever. Its
  // only inputs are the two values already selected above.
  const currentTip = React.useMemo(
    () => (currentTipId ? useTipsStore.getState().getCurrentTip() : null),
    [currentTipId, tracking],
  )

  const [menu, setMenu] = useState<{ feature: DockFeature; x: number; y: number } | null>(null)
  const [confirming, setConfirming] = useState<DockFeature | null>(null)

  const openMenu = (feature: DockFeature) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ feature, x: e.clientX, y: e.clientY })
  }

  const hide = (feature: DockFeature) => {
    setConfirming(null)
    void updateSettings(feature === 'tips' ? { showTips: false } : { showAskConductor: false })
    // Tips are switched OFF, not merely unmounted: drop the tip already picked
    // for this launch so nothing can raise it from another entry point, and so
    // re-enabling starts from a clean slate rather than a stale selection.
    if (feature === 'tips') useTipsStore.getState().silenceUntilRestart()
  }

  const askTitle = running
    ? `${ASK_LABEL} -- go to the open session`
    : `${ASK_LABEL} -- ask about this app`

  const open = () => {
    void launchAskConductor().then((id) => { if (id) onOpened() })
  }

  // The tip row needs somewhere to send the click, tips switched on, a tip that
  // has actually been picked, and content that still resolves. `silenced` is the
  // "not now" the user chose in the modal -- honoured until the next launch.
  const tipReady = !!onShowTip && showTips && !silenced && !!currentTipId && !!currentTip
  const unseen = showTips ? countUnseenTips(tracking) : 0

  // Nothing left to dock: skip the divider and the padding too, rather than
  // leaving an empty bordered strip at the bottom of the rail.
  if (!showAsk && !tipReady) return null

  const shell = (children: React.ReactNode) => (
    <div
      data-ux-id="sidebar-dockzone"
      className={`shrink-0 p-2 border-t ${collapsed ? 'mt-auto' : ''}`}
      style={{
        borderColor: 'var(--border-subtle)',
        background: collapsed
          ? undefined
          : 'linear-gradient(180deg, transparent, color-mix(in srgb, var(--brand) 7%, transparent))',
      }}
    >
      {children}
    </div>
  )

  const menus = (
    <>
      {menu && (
        <DockRowMenu
          x={menu.x}
          y={menu.y}
          label={menu.feature === 'tips' ? 'tips' : ASK_LABEL}
          onHide={() => { setConfirming(menu.feature); setMenu(null) }}
          onClose={() => setMenu(null)}
        />
      )}
      {confirming && (
        <HideDockFeatureDialog
          feature={confirming}
          onConfirm={() => hide(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  )

  if (collapsed) {
    return shell(
      <div className="flex flex-col items-center gap-1.5">
        {showAsk && (
          <button
            type="button"
            data-ux-id="sidebar-ask-pill"
            onClick={open}
            onContextMenu={openMenu('ask')}
            title={askTitle}
            aria-label={askTitle}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors focus-ring relative"
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
        )}
        {tipReady && (
          <button
            type="button"
            data-ux-id="sidebar-tip-pill"
            onClick={onShowTip}
            onContextMenu={openMenu('tips')}
            title={`Tip of the day -- ${currentTip!.content.shortText}`}
            aria-label={`Tip of the day. ${currentTip!.content.shortText}`}
            className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors focus-ring relative"
            style={{
              background: 'color-mix(in srgb, var(--color-peach) 13%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-peach) 42%, transparent)',
              color: 'var(--color-peach)',
            }}
          >
            <LightbulbMark className="w-4 h-4" />
            {unseen > 0 && (
              // The collapsed rail has no room for the count, so it degrades to
              // a presence dot -- the number is in the expanded row.
              <span
                className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
                style={{ background: 'var(--color-peach)' }}
                aria-hidden
              />
            )}
          </button>
        )}
        {menus}
      </div>,
    )
  }

  return shell(
    <div className="flex flex-col gap-1.5">
      {showAsk && (
        <>
          <button
            type="button"
            data-ux-id="sidebar-ask-pill"
            onClick={open}
            onContextMenu={openMenu('ask')}
            title={askTitle}
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
            <p data-ux-id="sidebar-ask-error" className="px-1 text-[10px] leading-snug" style={{ color: 'var(--status-danger)' }}>
              {error}
            </p>
          )}
        </>
      )}

      {tipReady && (
        <button
          type="button"
          data-ux-id="sidebar-tip-pill"
          onClick={onShowTip}
          onContextMenu={openMenu('tips')}
          title={currentTip!.content.shortText}
          className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left transition-colors focus-ring"
          style={{
            background: 'color-mix(in srgb, var(--color-peach) 13%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-peach) 42%, transparent)',
          }}
        >
          <LightbulbMark className="w-[17px] h-[17px] shrink-0" style={{ color: 'var(--color-peach)' }} />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              Tip of the day
            </span>
            {/* The reason the trigger moved: the header pill had room for an icon,
                this has room for the tip. */}
            <span className="block text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
              {currentTip!.content.shortText}
            </span>
          </span>
          {unseen > 0 && (
            <span
              data-ux-id="sidebar-tip-count"
              className="shrink-0 text-[9.5px] tabular-nums rounded-full px-1.5 py-px"
              style={{
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-strong)',
              }}
              title={`${unseen} tip${unseen === 1 ? '' : 's'} you have not been shown yet`}
            >
              {unseen} new
            </span>
          )}
        </button>
      )}

      {menus}
    </div>,
  )
}
