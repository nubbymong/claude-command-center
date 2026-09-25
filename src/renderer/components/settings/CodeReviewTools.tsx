// WP2 commit 6 (F8, F9 cards 1-4): Settings, General, Built-in Tools, the
// "Code review" group. One switch per direction: Codex reviewing for Claude
// sessions, Claude reviewing for Codex sessions. Each switch is live only
// while that review could actually run (the main process offers the tool on
// exactly that answer, `providers[].review.ready`), and says why otherwise.
// A disabled switch never rewrites the stored choice.
import React from 'react'
import type { AccountsSnapshot, ProviderId, ReviewReadinessView } from '../../../shared/providers'
import { providerOffMessage } from '../../../shared/providers'
import { useSettingsStore, DEFAULT_CONDUCTOR_TOOLS } from '../../stores/settingsStore'
import { useProviderAccountsStore, providerView, reviewerLine, reviewerNotice, accountDisplayName, savedOff } from '../../stores/providerAccountsStore'
import ToggleSwitch from '../github/config/ToggleSwitch'
import { ProviderMark } from '../sidebar/Badges'
import { DialogCallout } from '../ui/Dialog'

export type ReviewToolKey = 'codexReview' | 'claudeReview'

export interface ReviewToolView {
  /** The switch cannot be used now. */
  disabled: boolean
  /** Why it is disabled, when a provider or account state is the reason. */
  message: string | null
  /** A warning (no account can run it) rather than a plain state (off). */
  warn?: boolean
  /** "Reviews use: <text> (<suffix>)". Absent when nothing is known yet,
   *  or when the switch is disabled. */
  reviewer: { text: string; suffix: string | null; changeable: boolean } | null
  /** A reviewer choice the app cleared. */
  notice: string | null
  /** A muted fact beside a usable switch (Claude review while Codex is off). */
  note?: string | null
}

const REVIEWER_OF: Record<ReviewToolKey, ProviderId> = { codexReview: 'codex', claudeReview: 'claude' }

export interface ReviewToolContext {
  masterOn: boolean
  platform: string
  /** The first snapshot request has answered (a null answer included). */
  loaded?: boolean
  /** The saved on/off: a provider is off when the saved setting OR the
   *  main process says so (main needs both to offer it). */
  settings: { claudeEnabled?: boolean; codexEnabled?: boolean }
}

/** Why no review can run on this provider now, from which account the
 *  review would use and that account's own state. */
function noReviewMessage(snapshot: AccountsSnapshot, id: ProviderId, review: ReviewReadinessView): string {
  const isCodex = id === 'codex'
  if (snapshot.registry.mode !== 'ready') return 'The account list is not available right now.'
  const account = review.accountId ? snapshot.accounts.find((a) => a.id === review.accountId) : undefined
  if (!account) {
    return isCodex ? 'No Codex account can run reviews. Add a Codex account (a sign-in from ~/.codex cannot review).' : 'No Claude account can run reviews right now.'
  }
  if (account.external || account.unverified) {
    // Only point at making another account the reviewer when one exists:
    // an active, vouched-for, unblocked account of this provider. With none,
    // the way forward is adding one.
    const another = snapshot.accounts.some((a) => a.id !== account.id && a.providerId === id && a.lifecycle === 'active'
      && a.operationalState !== 'blocked' && !a.unverified && !a.external)
    if (!another) {
      return isCodex ? 'No Codex account can run reviews. Add a Codex account (a sign-in from ~/.codex cannot review).' : 'No Claude account can run reviews right now.'
    }
    return isCodex
      ? 'Make a Codex account the reviewer in Accounts (a sign-in from ~/.codex cannot review).'
      : 'Make another Claude account the reviewer in Accounts (an unverified sign-in cannot review).'
  }
  // Inactive, archived, blocked, signed out, signing in, or refused here.
  const name = !isCodex && account.providerLabel ? account.providerLabel : accountDisplayName(snapshot, account)
  return `Reviews can't run on ${name} right now. Check it in Accounts.`
}

/**
 * What a review switch shows. In order: the tools master; the reviewing
 * provider off (saved or live); the account snapshot not here yet; whether a
 * review could run on the reviewer account now, and why not. A refused
 * account is never named as the reviewer.
 */
export function reviewToolView(snapshot: AccountsSnapshot | null, tool: ReviewToolKey, ctx: ReviewToolContext): ReviewToolView {
  const id = REVIEWER_OF[tool]
  const isCodex = id === 'codex'
  if (!ctx.masterOn) return { disabled: true, message: null, reviewer: null, notice: null }
  const p = providerView(snapshot, id)
  if (savedOff(ctx.settings, id) || (p !== undefined && !p.enabled)) {
    return { disabled: true, message: providerOffMessage(isCodex ? 'Codex' : 'Claude Code'), reviewer: null, notice: null }
  }
  // No snapshot: still waiting for the first answer, or the main process
  // has no account service to give one.
  if (!snapshot) return { disabled: true, message: ctx.loaded ? 'The account list is not available right now.' : 'Checking accounts...', reviewer: null, notice: null }
  // Claude review answers Codex sessions: while Codex is off nothing asks,
  // but the switch keeps its meaning for when it is back on.
  const codexOff = savedOff(ctx.settings, 'codex') || providerView(snapshot, 'codex')?.enabled === false
  const note = !isCodex && codexOff ? 'Only Codex sessions use it; Codex is off.' : null
  const notice = reviewerNotice(snapshot, id, ctx.platform)
  const review = p?.review
  if (!review) return { disabled: false, message: null, reviewer: null, notice, note }
  if (!review.ready) return { disabled: true, message: noReviewMessage(snapshot, id, review), warn: true, reviewer: null, notice, note }
  // On macOS, once a Claude reviewer was cleared, reviews use the normal
  // Claude sign-in: say so rather than naming a profile.
  if (!isCodex && ctx.platform === 'darwin' && snapshot.reviewerNotices.some((n) => n.providerId === 'claude')) {
    return { disabled: false, message: null, reviewer: { text: 'your normal Claude sign-in', suffix: null, changeable: false }, notice, note }
  }
  const line = reviewerLine(snapshot, id)
  if (!line || line.kind !== 'account' || line.label === null) return { disabled: false, message: null, reviewer: null, notice, note }
  const account = snapshot.accounts.find((a) => a.id === line.accountId)
  // Claude accounts are known by their email; Codex ones by their name.
  const text = !isCodex && account?.providerLabel ? account.providerLabel : line.name
  const suffix = line.label === 'reviewer' ? (isCodex ? 'Codex reviewer' : 'Claude reviewer') : 'default'
  return { disabled: false, message: null, reviewer: { text, suffix, changeable: true }, notice, note }
}

const ROWS: { key: ReviewToolKey; title: string; desc: string }[] = [
  { key: 'codexReview', title: 'Codex review', desc: 'Claude sessions can ask Codex to review.' },
  { key: 'claudeReview', title: 'Claude review', desc: 'Codex sessions can ask Claude to review.' },
]

export function CodeReviewTools({ onOpenAccounts }: { onOpenAccounts: () => void }) {
  const settings = useSettingsStore((s) => s.settings)
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const loaded = useProviderAccountsStore((s) => s.loaded)
  const masterOn = settings.conductorToolsEnabled !== false
  const tools = { ...DEFAULT_CONDUCTOR_TOOLS, ...(settings.conductorTools || {}) }
  const platform = typeof window !== 'undefined' ? window.electronPlatform : ''

  const write = (key: ReviewToolKey, on: boolean) => {
    void useSettingsStore.getState().updateSettings({
      conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS, ...(settings.conductorTools || {}), [key]: on },
    })
  }

  return (
    <div className="space-y-3" data-testid="code-review-tools">
      <div className="rounded-[10px] border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-raised)' }}>
        <div className="px-3.5 pt-2.5 pb-1.5 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>Code review</div>
        {ROWS.map((row) => {
          const view = reviewToolView(snapshot, row.key, { masterOn, platform, loaded, settings })
          const on = tools[row.key] !== false
          const ids = {
            desc: `review-tool-${row.key}-desc`,
            message: `review-tool-${row.key}-message`,
            reviewer: `review-tool-${row.key}-reviewer`,
            notice: `review-tool-${row.key}-notice`,
            note: `review-tool-${row.key}-note`,
          }
          const describedBy = [
            ids.desc,
            view.message ? ids.message : null,
            view.reviewer ? ids.reviewer : null,
            view.note ? ids.note : null,
            view.notice ? ids.notice : null,
          ].filter(Boolean).join(' ')
          return (
            <div
              key={row.key}
              className="flex items-start gap-3 px-3.5 py-2.5"
              style={{ borderTop: '1px solid var(--border-subtle)' }}
              data-testid={`review-tool-${row.key}`}
            >
              <span className="mt-0.5"><ProviderMark providerId={REVIEWER_OF[row.key]} size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{row.title}</div>
                <div id={ids.desc} className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{row.desc}</div>
                {view.message && (
                  <div
                    id={ids.message}
                    className="text-[12px] mt-1"
                    style={{ color: view.warn ? 'var(--status-warning)' : 'var(--text-secondary)' }}
                    data-tone={view.warn ? 'warn' : 'plain'}
                    data-testid={ids.message}
                  >
                    {view.message}
                  </div>
                )}
                {view.reviewer && (
                  <div id={ids.reviewer} className="text-[12px] mt-1" style={{ color: 'var(--text-secondary)' }} data-testid={ids.reviewer}>
                    Reviews use:{' '}
                    <b className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {view.reviewer.text}{view.reviewer.suffix ? ` (${view.reviewer.suffix})` : ''}
                    </b>
                    {view.reviewer.changeable && (
                      <>
                        . Change in{' '}
                        <button
                          type="button"
                          onClick={onOpenAccounts}
                          className="underline underline-offset-2 focus-ring"
                          style={{ color: 'var(--brand)' }}
                          data-testid={`review-tool-${row.key}-accounts-link`}
                        >
                          Accounts
                        </button>
                        .
                      </>
                    )}
                  </div>
                )}
                {view.note && (
                  <div id={ids.note} className="text-[11.5px] mt-1 leading-snug" style={{ color: 'var(--text-muted)' }} data-testid={ids.note}>
                    {view.note}
                  </div>
                )}
                {view.notice && (
                  <div id={ids.notice} className="text-[11.5px] mt-1 leading-snug" style={{ color: 'var(--text-muted)' }} data-testid={ids.notice}>
                    {view.notice}
                  </div>
                )}
              </div>
              <ToggleSwitch
                state={on && !view.disabled ? 'on' : 'off'}
                disabled={view.disabled}
                onToggle={() => { if (!view.disabled) write(row.key, !on) }}
                label={row.title}
                describedBy={describedBy}
              />
            </div>
          )
        })}
      </div>
      <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }} data-testid="code-review-note">
        Changes here or in Accounts apply to sessions started after them.
      </div>
      <DialogCallout tone="info" title="How a review runs" testId="code-review-explainer">
        <div>A separate, one-off reviewer process on the reviewer account.</div>
        <div>Read-only, in the asking session's project; nothing is saved as a conversation.</div>
        <div>It never uses one of your open sessions, and it cannot ask for another review.</div>
      </DialogCallout>
    </div>
  )
}
