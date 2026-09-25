// WP2 commit 6: small building blocks the Accounts surface shares between
// its provider sections (Claude's existing profile panel and the managed
// provider sections). Semantic tokens only.
import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ProviderId } from '../../../../shared/providers'
import { useProviderAccountsStore, reviewerLine, reviewerNotice, providerView, type StatusTone } from '../../../stores/providerAccountsStore'
import { DialogCallout, DialogOverlay, DialogPanel } from '../../ui/Dialog'
import { useFocusTrap } from '../../../hooks/useFocusTrap'

export type PillTone = 'default' | 'reviewer' | 'warn' | 'beta' | 'muted'

const PILL_TOKEN: Record<PillTone, string> = {
  default: 'var(--brand)',
  reviewer: 'var(--status-info)',
  warn: 'var(--status-warning)',
  beta: 'var(--brand)',
  muted: 'var(--text-muted)',
}

/** A rounded badge ("Default", "Reviewer", "Beta", "Confirm each launch"). */
export function Pill({ tone, children, testId, title }: { tone: PillTone; children: React.ReactNode; testId?: string; title?: string }) {
  const t = PILL_TOKEN[tone]
  return (
    <span
      className="inline-flex items-center rounded-full border px-[7px] py-px text-[10.5px] font-medium whitespace-nowrap shrink-0"
      style={{ borderColor: `color-mix(in srgb, ${t} 50%, transparent)`, color: t, background: `color-mix(in srgb, ${t} 10%, transparent)` }}
      data-testid={testId}
      title={title}
    >
      {children}
    </span>
  )
}

const TONE_TOKEN: Record<StatusTone, string> = {
  ok: 'var(--status-success)',
  warn: 'var(--status-warning)',
  muted: 'var(--text-muted)',
}

/** A status dot and its sentence ("Signed in", "Codex 0.155.1 - ready"). */
export function StatusText({ tone, children, testId }: { tone: StatusTone; children: React.ReactNode; testId?: string }) {
  const t = TONE_TOKEN[tone]
  return (
    <span className="inline-flex items-start gap-1.5 text-xs" style={{ color: tone === 'ok' ? 'var(--text-secondary)' : t }} data-testid={testId} data-tone={tone}>
      <span className="w-[7px] h-[7px] rounded-full shrink-0 mt-[5px]" style={{ background: t }} aria-hidden />
      <span>{children}</span>
    </span>
  )
}

export function MutedLine({ children, testId, className = '' }: { children: React.ReactNode; testId?: string; className?: string }) {
  return <div className={`text-[11.5px] leading-snug ${className}`} style={{ color: 'var(--text-muted)' }} data-testid={testId}>{children}</div>
}

export function ErrorLine({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return <div className="text-[11.5px] leading-snug mt-1" style={{ color: 'var(--status-danger)' }} role="alert" data-testid={testId}>{children}</div>
}

/** A small secondary button for row-level actions. */
export function RowButton({ children, onClick, disabled, testId, title }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; testId?: string; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center rounded-[6px] border px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap focus-ring transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--surface-overlay)]"
      style={{ borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
      data-testid={testId}
    >
      {children}
    </button>
  )
}

/**
 * The reviewer line under a provider's section header: which account this
 * provider's code reviews use, and why, plus a cleared-reviewer notice when
 * the app had to drop an earlier choice. Nothing when the provider does not
 * review here, and nothing while it is off: no review runs on a provider
 * that is off, so which account "reviews use" is not a thing to say (VM
 * audit 2026-09-25: the Claude card said "No account can run code reviews
 * yet" with Claude Code off).
 */
export function ReviewerLineBlock({ providerId }: { providerId: ProviderId }) {
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const line = reviewerLine(snapshot, providerId)
  if (!line || providerView(snapshot, providerId)?.enabled === false) return null
  const platform = typeof window !== 'undefined' ? window.electronPlatform : ''
  const notice = reviewerNotice(snapshot, providerId, platform)
  const macClaude = providerId === 'claude' && platform === 'darwin' && !!providerView(snapshot, 'claude')?.review
  return (
    <div className="text-[12.5px] leading-snug space-y-1" data-testid={`reviewer-line-${providerId}`}>
      {line.kind === 'no-account' ? (
        <div style={{ color: 'var(--text-secondary)' }}>No account can run code reviews yet.</div>
      ) : (
        <div style={{ color: 'var(--text-secondary)' }}>
          Code reviews use:{' '}
          <b className="font-semibold" style={{ color: 'var(--text-primary)' }} data-testid={`reviewer-line-${providerId}-account`}>
            {line.name}{line.label ? ` (${line.label})` : ''}
          </b>
        </div>
      )}
      <MutedLine>When none is set, reviews use the default account.</MutedLine>
      {line.kind === 'account' && !line.ready && (
        <div className="text-[11.5px]" style={{ color: 'var(--status-warning)' }} data-testid={`reviewer-not-ready-${providerId}`}>
          Reviews can't run on it right now.
        </div>
      )}
      {notice && <MutedLine testId={`reviewer-notice-${providerId}`}>{notice}</MutedLine>}
      {macClaude && (
        <DialogCallout tone="info" className="mt-2" testId="reviewer-mac-callout">
          Claude reviews on macOS use your normal Claude sign-in.
        </DialogCallout>
      )}
    </div>
  )
}

/**
 * The Accounts surface's modal frame: portalled to document.body (no card
 * clips or stacks over it), with focus trapped inside. On open, and again
 * whenever `focusKey` changes (a dialog's step), focus goes to the element
 * marked `data-autofocus`, else to the first control.
 */
export function AccountsModal({ labelledBy, testId, overlayTestId, width, role = 'dialog', focusKey, z, children }: {
  labelledBy: string
  testId?: string
  overlayTestId?: string
  width?: string
  role?: 'dialog' | 'alertdialog'
  focusKey?: string
  /** The overlay's stacking class, when it opens over a surface that sits
   *  above the usual dialogs (the onboarding pages). */
  z?: string
  children: React.ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [focusKey])
  return createPortal(
    <DialogOverlay testId={overlayTestId} z={z}>
      <DialogPanel panelRef={panelRef} labelledBy={labelledBy} width={width} role={role} testId={testId}>
        {children}
      </DialogPanel>
    </DialogOverlay>,
    document.body,
  )
}
