// WP2 commit 6 (F4, Codex card): a provider whose accounts this app manages
// itself. One row per account (archived ones hidden), the reviewer line,
// setups an interruption left behind, what the app found about the
// provider's own sign-in on this computer, and Add account. While the
// provider is off, the accounts are listed but not managed.
import React, { useEffect, useRef, useState } from 'react'
import type { AccountView, AccountsResult, AccountsSnapshot, KnownAuthState, PendingSetupView, ProviderId, ProviderInstallationView } from '../../../../shared/providers'
import type { IdentityColorKey } from '../../../../shared/identity-colors'
import { resolveIdentityColor } from '../../../../shared/identity-colors'
import {
  useProviderAccountsStore, providerAccountActions, providerView, selectProviderAccounts, accountDisplayName, canOfferMakeReviewer,
  showsReviewerBadge, accountFailureText, accountState, signInMethodLabel, externalHomeLabel, canOfferSignInAgain,
  canOfferMakeInactive, canOfferMakeActive, canOfferArchive, externalAdoption, canOfferCheckSignIn, signInCheckText, externalSignInHint,
} from '../../../stores/providerAccountsStore'
import { useResolvedTheme } from '../../../hooks/useThemeController'
import { ProviderMark } from '../../sidebar/Badges'
import { Section } from '../../SettingsPage'
import { DialogHeader, DialogBody, DialogFooter, DialogButton, useDialogEscape } from '../../ui/Dialog'
import { Pill, StatusText, MutedLine, ErrorLine, RowButton, ReviewerLineBlock, AccountsModal } from './accounts-ui'
import { RowMenu, type MenuItem } from '../../ui/RowMenu'
import { AddProviderAccountDialog, SignInAgainDialog } from './AddProviderAccountDialog'

type ExternalAck = 'logout' | 'archive'

/** Signing out of, or archiving, the provider's own shared home reaches
 *  beyond this app: the user says yes to that first. */
function ExternalAckDialog({ kind, provider, onConfirm, onCancel }: {
  kind: ExternalAck
  provider: ProviderInstallationView
  onConfirm: () => void
  onCancel: () => void
}) {
  useDialogEscape(onCancel)
  const home = externalHomeLabel(provider)
  const title = kind === 'logout' ? `Sign out of ${home}?` : `Archive ${home}?`
  return (
    <AccountsModal labelledBy="external-ack-title" role="alertdialog" testId="external-ack-dialog" overlayTestId="external-ack-overlay">
      <DialogHeader title={title} titleId="external-ack-title" onClose={onCancel} />
      <DialogBody>
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }} data-testid="external-ack-text">
          {kind === 'logout'
            ? `This sign-in is shared with other apps on this computer, including the ${provider.displayName} CLI itself. Signing out here signs them out too.`
            : `Archiving only forgets this sign-in in this app. It is shared with other apps on this computer, and it stays signed in for them.`}
        </p>
      </DialogBody>
      <DialogFooter>
        <DialogButton variant="ghost" onClick={onCancel} testId="external-ack-cancel" data-autofocus="">Cancel</DialogButton>
        <DialogButton variant={kind === 'logout' ? 'danger' : 'primary'} onClick={onConfirm} testId="external-ack-confirm">
          {kind === 'logout' ? 'Sign out' : 'Archive'}
        </DialogButton>
      </DialogFooter>
    </AccountsModal>
  )
}

function ManagedAccountRow({ account, provider, snapshot }: { account: AccountView; provider: ProviderInstallationView; snapshot: AccountsSnapshot }) {
  const theme = useResolvedTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ack, setAck] = useState<ExternalAck | null>(null)
  const [signingInAgain, setSigningInAgain] = useState(false)
  const [checked, setChecked] = useState<KnownAuthState | null>(null)
  const id = account.id
  const manageable = provider.enabled
  const name = accountDisplayName(snapshot, account)
  const email = account.providerLabel && account.providerLabel !== name ? account.providerLabel : null
  const method = signInMethodLabel(account, provider)
  const state = accountState(account)
  const blocked = account.operationalState === 'blocked'
  // This computer's own sign-in is the provider CLI's to make: the app never
  // signs in to it, so a signed-out or expired one says how to fix it.
  const externalHint = manageable ? externalSignInHint(account, provider) : null
  const cannotReview = account.external || account.unverified
  const identity = snapshot.identities.find((i) => i.id === account.identityId)
  const tint = identity ? resolveIdentityColor(identity.colourKey as IdentityColorKey, theme) : 'var(--text-secondary)'

  const run = async (op: () => Promise<AccountsResult>) => {
    setBusy(true)
    setError(null)
    setChecked(null)
    const r = await op()
    setBusy(false)
    if (!r.ok) setError(accountFailureText(r, account))
  }

  // A check's answer stands only while the record agrees with it: once the
  // recorded sign-in state moves on (a Sign in again that worked, a sign-out)
  // or the account is blocked, it is stale; so is it once the account's
  // lifecycle changes. The answer can land before the snapshot that records
  // it, so it is dropped only on a change, never for merely being ahead.
  useEffect(() => {
    setChecked((c) => (c !== null && (c !== account.lastKnownAuthState || account.operationalState === 'blocked') ? null : c))
  }, [account.lastKnownAuthState, account.operationalState])
  const lifecycleSeen = useRef(account.lifecycle)
  useEffect(() => {
    if (lifecycleSeen.current === account.lifecycle) return
    lifecycleSeen.current = account.lifecycle
    setChecked(null)
  }, [account.lifecycle])

  // "Check sign-in" (6g: what Test connection did in the retired Codex
  // settings tab, per account): the provider's own status check in this
  // account's realm. Its answer is shown here; the row's state follows the
  // snapshot main pushes once it has recorded it.
  const checkSignIn = async () => {
    setBusy(true)
    setError(null)
    setChecked(null)
    const r = await providerAccountActions.checkSignIn(id)
    setBusy(false)
    if (r.ok) setChecked(r.state)
    else setError(accountFailureText(r, account))
  }

  const items: MenuItem[] = []
  if (manageable) {
    // The registry makes only an active, unblocked account the default.
    if (!account.isProviderDefault && account.lifecycle === 'active' && !blocked) {
      items.push({ key: 'make-default', label: 'Make default', onSelect: () => { void run(() => providerAccountActions.setDefault(id)) } })
    }
    if (canOfferMakeReviewer(snapshot, account)) {
      items.push({ key: 'make-reviewer', label: 'Make reviewer', onSelect: () => { void run(() => providerAccountActions.setReviewerDefault({ providerId: account.providerId, accountId: id })) } })
    }
    // Only when it is not signed in now: the provider never logs in over a
    // realm that still is, so the offer would do nothing but check.
    if (canOfferSignInAgain(account)) {
      items.push({ key: 'sign-in-again', label: 'Sign in again', onSelect: () => { setError(null); setChecked(null); setSigningInAgain(true) } })
    }
    if (canOfferCheckSignIn(account, provider)) {
      items.push({ key: 'check-sign-in', label: 'Check sign-in', onSelect: () => { void checkSignIn() } })
    }
    if (account.lastKnownAuthState !== 'signed-out' && provider.logout.enabled) {
      items.push({
        key: 'sign-out',
        label: 'Sign out',
        onSelect: () => { if (account.external) setAck('logout'); else void run(() => providerAccountActions.logout({ accountId: id })) },
      })
    }
    const lifecycle: MenuItem[] = []
    if (canOfferMakeInactive(snapshot, account)) {
      lifecycle.push({ key: 'make-inactive', label: 'Make inactive', onSelect: () => { void run(() => providerAccountActions.setLifecycle({ accountId: id, lifecycle: 'inactive' })) } })
    }
    if (canOfferMakeActive(account)) {
      lifecycle.push({ key: 'make-active', label: 'Make active', onSelect: () => { void run(() => providerAccountActions.setLifecycle({ accountId: id, lifecycle: 'active' })) } })
    }
    if (canOfferArchive(account)) {
      lifecycle.push({
        key: 'archive',
        label: 'Archive',
        onSelect: () => { if (account.external) setAck('archive'); else void run(() => providerAccountActions.setLifecycle({ accountId: id, lifecycle: 'archived' })) },
      })
    }
    if (lifecycle.length && items.length) lifecycle[0] = { ...lifecycle[0], separated: true }
    items.push(...lifecycle)
  }

  const confirmAck = () => {
    const kind = ack
    setAck(null)
    if (kind === 'logout') void run(() => providerAccountActions.logout({ accountId: id, acknowledgeExternal: true }))
    else if (kind === 'archive') void run(() => providerAccountActions.setLifecycle({ accountId: id, lifecycle: 'archived', acknowledgeExternal: true }))
  }

  return (
    <div className="py-3" style={{ borderTop: '1px solid var(--border-subtle)' }} data-testid={`provider-account-row-${id}`}>
      <div className="grid items-center gap-3 text-[13px] grid-cols-[26px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.5fr)_28px]">
        <span
          className="w-[26px] h-[26px] rounded-full inline-grid place-items-center text-[11px] font-bold"
          style={{ background: 'var(--surface-overlay)', color: tint }}
          aria-hidden
        >
          {account.external ? '~' : (name.charAt(0).toUpperCase() || '?')}
        </span>
        <div className="flex flex-col items-start gap-0.5 min-w-0">
          <span className="font-semibold truncate max-w-full" style={{ color: account.lifecycle === 'active' ? 'var(--text-primary)' : 'var(--text-muted)' }} title={name} data-testid={`account-name-${id}`}>{name}</span>
          {email && <span className="font-mono text-[12px] truncate max-w-full" style={{ color: 'var(--text-secondary)' }} title={email}>{email}</span>}
        </div>
        <div className="flex flex-col items-start gap-0.5 min-w-0" data-testid={`account-plan-cell-${id}`}>
          {account.planLabel && <span className="truncate max-w-full" style={{ color: 'var(--text-primary)' }} data-testid={`account-plan-${id}`}>{account.planLabel}</span>}
          {method && <MutedLine testId={`account-method-${id}`}>{method}</MutedLine>}
        </div>
        <div className="flex flex-col items-start gap-1 min-w-0">
          {account.isProviderDefault && <Pill tone="default" testId={`account-badge-default-${id}`}>Default</Pill>}
          {showsReviewerBadge(account) && <Pill tone="reviewer" testId={`account-badge-reviewer-${id}`}>Reviewer</Pill>}
          {cannotReview && <Pill tone="warn" testId={`account-badge-confirm-${id}`}>Confirm each launch</Pill>}
          {cannotReview && <MutedLine testId={`account-no-reviews-${id}`}>Cannot run reviews</MutedLine>}
          {account.lifecycle === 'inactive' && <Pill tone="muted" testId={`account-badge-inactive-${id}`}>Inactive</Pill>}
        </div>
        <div className="flex flex-col items-start gap-1 min-w-0">
          <StatusText tone={state.tone} testId={`account-state-${id}`}>{state.text}</StatusText>
          {/* Never on a blocked row, whichever lands first: the answer or the
              snapshot that blocked the account. */}
          {checked && !blocked && <MutedLine testId={`account-checked-${id}`}>{signInCheckText(checked)}</MutedLine>}
          {externalHint && <MutedLine testId={`account-external-hint-${id}`}>{externalHint}</MutedLine>}
          {blocked && manageable && (
            <RowButton onClick={() => { void run(() => providerAccountActions.reconcileSignIn(id)) }} disabled={busy} testId={`account-reconcile-${id}`}>
              This is still my account
            </RowButton>
          )}
        </div>
        <RowMenu
          items={items}
          label={`Actions for ${name}`}
          disabled={busy}
          testId={`account-menu-btn-${id}`}
          itemTestId={(key) => `account-menu-${key}-${id}`}
        />
      </div>
      {error && <div className="pl-[38px]"><ErrorLine testId={`account-error-${id}`}>{error}</ErrorLine></div>}
      {ack && <ExternalAckDialog kind={ack} provider={provider} onConfirm={confirmAck} onCancel={() => setAck(null)} />}
      {signingInAgain && <SignInAgainDialog provider={provider} account={account} name={name} onClose={() => setSigningInAgain(false)} />}
    </div>
  )
}

function methodWord(m: PendingSetupView['method']): string {
  switch (m) {
    case 'browser': return 'Browser sign-in'
    case 'device': return 'Device code sign-in'
    case 'apiKey': return 'API key sign-in'
    case 'external': return "This computer's own sign-in"
    default: return 'Sign-in'
  }
}

function PendingSetupRow({ setup, manageable, onResume }: { setup: PendingSetupView; manageable: boolean; onResume: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const discard = async () => {
    setBusy(true)
    setError(null)
    const r = await providerAccountActions.abandonSetup(setup.accountId)
    setBusy(false)
    if (!r.ok) setError(accountFailureText(r))
  }
  const resumable = manageable && !setup.external && !setup.signingIn
  return (
    <div className="py-2" style={{ borderTop: '1px solid var(--border-subtle)' }} data-testid={`pending-setup-${setup.accountId}`}>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px]" style={{ color: 'var(--text-primary)' }}>{methodWord(setup.method)}, not finished</div>
          <MutedLine>
            {setup.signingIn ? 'Signing in now' : setup.state === 'credentials-written' ? 'Signed in; it still needs a name' : 'Started ' + new Date(setup.createdAt).toLocaleString()}
          </MutedLine>
        </div>
        {resumable && <RowButton onClick={onResume} disabled={busy} testId={`pending-setup-resume-${setup.accountId}`}>Resume</RowButton>}
        {manageable && <RowButton onClick={() => { void discard() }} disabled={busy || setup.signingIn} testId={`pending-setup-discard-${setup.accountId}`}>Discard</RowButton>}
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
    </div>
  )
}

function ExternalAdoptionBlock({ providerId, provider }: { providerId: ProviderId; provider: ProviderInstallationView }) {
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = externalAdoption(snapshot, providerId)
  if (view.kind === 'none') return null
  const adopt = async () => {
    setBusy(true)
    setError(null)
    const r = await providerAccountActions.adoptExternal(providerId)
    setBusy(false)
    if (!r.ok) setError(r.message)
  }
  // The user's yes: the provider is on by their choice, so the one-time
  // check runs again now. What it found arrives with the next snapshot.
  const confirmUse = async () => {
    setBusy(true)
    setError(null)
    const on = await providerAccountActions.switchProvider(providerId, true)
    if (!on.ok) { setBusy(false); setError(on.message); return }
    const r = await providerAccountActions.runMigration(providerId)
    setBusy(false)
    if (!r.ok) setError(r.message)
  }
  return (
    <div className="rounded-[10px] border px-3.5 py-2.5 flex items-center gap-3" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-panel)' }} data-testid={`external-adoption-${providerId}`}>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{externalHomeLabel(provider)}</div>
        {view.kind === 'note' || view.kind === 'confirm' ? (
          <MutedLine testId={`external-adoption-text-${providerId}`}>{view.text}</MutedLine>
        ) : (
          <>
            {view.text && <MutedLine testId={`external-adoption-text-${providerId}`}>{view.text}</MutedLine>}
            <MutedLine>If you use it, you confirm it at each launch, and it cannot run code reviews.</MutedLine>
          </>
        )}
        {error && <ErrorLine>{error}</ErrorLine>}
      </div>
      {view.kind === 'confirm' && (
        <RowButton onClick={() => { void confirmUse() }} disabled={busy} testId={`confirm-uses-${providerId}`}>
          Yes, I use {provider.displayName}
        </RowButton>
      )}
      {view.kind === 'offer' && (
        <RowButton onClick={() => { void adopt() }} disabled={busy} testId={`adopt-external-${providerId}`}>
          {view.action === 'check-again' ? 'Check again' : `Use this computer's ${provider.displayName} sign-in`}
        </RowButton>
      )}
    </div>
  )
}

export function ManagedAccountsSection({ providerId }: { providerId: ProviderId }) {
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const [dialog, setDialog] = useState<null | { resume?: PendingSetupView }>(null)
  const provider = providerView(snapshot, providerId)
  if (!snapshot || !provider || !provider.managedAccounts) return null

  const accounts = selectProviderAccounts(snapshot, providerId)
  const pending = snapshot.pendingSetups.filter((p) => p.providerId === providerId)
  const manageable = provider.enabled

  return (
    <Section title={provider.displayName} mark={<ProviderMark providerId={providerId} size={16} />} testId={`provider-accounts-${providerId}`}>
      <ReviewerLineBlock providerId={providerId} />
      {!manageable && (
        <MutedLine testId={`provider-off-note-${providerId}`}>Turn {provider.displayName} on to manage its accounts.</MutedLine>
      )}
      <div>
        {accounts.map((a) => <ManagedAccountRow key={a.id} account={a} provider={provider} snapshot={snapshot} />)}
      </div>
      {pending.length > 0 && (
        <div data-testid={`pending-setups-${providerId}`}>
          <div className="text-[11.5px] font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>Unfinished setups</div>
          {pending.map((p) => <PendingSetupRow key={p.accountId} setup={p} manageable={manageable} onResume={() => setDialog({ resume: p })} />)}
        </div>
      )}
      {manageable && <ExternalAdoptionBlock providerId={providerId} provider={provider} />}
      {manageable && (
        <div className="pt-1">
          <DialogButton variant="secondary" onClick={() => setDialog({})} testId={`add-provider-account-${providerId}`}>
            Add {provider.displayName} account
          </DialogButton>
        </div>
      )}
      {dialog && <AddProviderAccountDialog provider={provider} resume={dialog.resume} onClose={() => setDialog(null)} />}
    </Section>
  )
}
