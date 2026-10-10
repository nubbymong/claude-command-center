// P3.2 (rows 8, 10, 24): one account row for every provider, to the approved
// Accounts design (canvas "Accounts: identities across providers" v1,
// option B, 2026-09-26). The avatar chip opens the identity editor; the name,
// the provider's label and a "Linked with" line; plan and sign-in method;
// badges; state with "N running"; the "..." menu. Below it, whatever the row
// has to say (an error, a blocker naming the sessions that hold the account,
// per-account notices). Claude's rows and every managed provider's rows are
// this component: the provider decides what goes in each cell, never the
// layout.
import React from 'react'
import type { ProviderId } from '../../../../shared/providers'
import { ProviderMark } from '../../sidebar/Badges'
import { goToSession } from '../../../lib/goToSession'

export interface AccountChipProps {
  /** The initial the chip shows ("~" for this computer's own sign-in). */
  letter: string
  /** The identity colour, resolved for the theme. */
  tint: string
  /** Opens the identity editor; absent = the chip is only a marker. */
  onOpen?: () => void
  open?: boolean
  /** Names the chip button for assistive technology. */
  label: string
  testId?: string
  chipRef?: React.Ref<HTMLButtonElement>
}

export function AccountChip({ letter, tint, onOpen, open, label, testId, chipRef }: AccountChipProps) {
  const style: React.CSSProperties = {
    background: 'var(--surface-overlay)',
    color: tint,
    borderColor: `color-mix(in srgb, ${tint} 50%, transparent)`,
    boxShadow: open ? '0 0 0 2px var(--brand)' : undefined,
  }
  if (!onOpen) return <span className="w-[26px] h-[26px] rounded-full inline-grid place-items-center text-[11px] font-bold border-2" style={style} aria-hidden data-testid={testId}>{letter}</span>
  // The open state is a box-shadow ring: the focus ring sits outside it.
  return (
    <button
      ref={chipRef}
      type="button"
      onClick={onOpen}
      className="w-[26px] h-[26px] rounded-full inline-grid place-items-center text-[11px] font-bold border-2 focus-ring-strong-outset cursor-pointer"
      style={style}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open === true}
      title={label}
      data-testid={testId}
    >
      {letter}
    </button>
  )
}

/** "Linked with <provider>: <label>" under the account's name. */
export function LinkedLine({ providerId, providerName, label, testId }: { providerId: ProviderId; providerName: string; label: string; testId?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] min-w-0 max-w-full" style={{ color: 'var(--text-secondary)' }} data-testid={testId}>
      <ProviderMark providerId={providerId} size={12} />
      <span className="truncate" title={`Linked with ${providerName}: ${label}`}>Linked with {providerName}: {label}</span>
    </span>
  )
}

/** A refused inactivate, archive or removal that names what holds the
 *  account (design 5.3): "<name> can't be made inactive while these use it:"
 *  and one "Go to <session>" per session. */
export function BlockerLine({ name, verb, sessions, more = 0, testId }: {
  name: string
  verb: string
  sessions: readonly { id: string; title: string }[]
  /** What else holds it that this window cannot name (a sign-in, an
   *  operation, a session in another window). */
  more?: number
  testId?: string
}) {
  return (
    <div
      className="mt-2 px-2.5 py-2 rounded-lg border text-[12px] flex flex-wrap items-center gap-2"
      style={{
        background: 'color-mix(in srgb, var(--status-danger) 8%, transparent)',
        borderColor: 'color-mix(in srgb, var(--status-danger) 30%, transparent)',
        color: 'var(--text-primary)',
      }}
      role="alert"
      data-testid={testId}
    >
      <span>{name} can't be {verb} while these use it:</span>
      {sessions.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => goToSession(s.id)}
          className="inline-flex items-center gap-1 rounded-[6px] border px-2 py-px text-[11.5px] focus-ring-strong"
          style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-overlay)', color: 'var(--text-primary)' }}
          data-testid={testId ? `${testId}-go-${s.id}` : undefined}
        >
          Go to {s.title}
          <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      ))}
      {more > 0 && <span data-testid={testId ? `${testId}-more` : undefined}>and {more} more</span>}
    </div>
  )
}

export function AccountRow({ testId, chip, name, nameMuted, nameTestId, secondary, linked, planCell, badges, stateCell, menu, children }: {
  testId: string
  chip: React.ReactNode
  name: string
  nameMuted?: boolean
  nameTestId?: string
  /** Under the name: the provider's label (an email), or a note. */
  secondary?: React.ReactNode
  linked?: React.ReactNode
  /** Plan and sign-in method. Absent (null) when the row has neither: the
   *  name then takes the plan track. */
  planCell?: React.ReactNode
  badges?: React.ReactNode
  stateCell?: React.ReactNode
  menu: React.ReactNode
  /** Below the row, aligned with the name. */
  children?: React.ReactNode
}) {
  // Every cell sits on the first line of text (baseline), level with the
  // chip's initial, however far the cells below it run; centring each cell on
  // its own height scattered them. The tracks never depend on what a row
  // holds, so columns line up from row to row; a row with no plan gives that
  // track to its name. A long name wraps to a second line, never truncated,
  // so it stays whole when a plan, recorded later, takes its track back. The
  // badge track keeps 128px, in px like the pills it holds, so a pill never
  // runs into the state column; on a narrow card that floor comes out of the
  // other text tracks, and the state cell breaks a long email anywhere
  // rather than run it under the menu.
  return (
    <div className="py-3" style={{ borderTop: '1px solid var(--border-subtle)' }} data-testid={testId}>
      <div className="grid items-baseline gap-3 text-[13px] grid-cols-[26px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(128px,1.1fr)_minmax(0,1.5fr)_28px]">
        {chip}
        <div className={`flex flex-col items-start gap-0.5 min-w-0${planCell ? '' : ' col-span-2'}`}>
          <span className="font-semibold max-w-full line-clamp-2 [overflow-wrap:anywhere]" style={{ color: nameMuted ? 'var(--text-muted)' : 'var(--text-primary)' }} title={name} data-testid={nameTestId}>{name}</span>
          {secondary}
          {linked}
        </div>
        {planCell ? <div className="flex flex-col items-start gap-0.5 min-w-0">{planCell}</div> : null}
        <div className="flex flex-col items-start gap-1 min-w-0">{badges}</div>
        <div className="flex flex-col items-start gap-1 min-w-0 [overflow-wrap:anywhere]">{stateCell}</div>
        {menu}
      </div>
      {children && <div className="pl-[38px]">{children}</div>}
    </div>
  )
}
