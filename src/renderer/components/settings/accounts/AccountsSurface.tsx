// WP2 commit 6: Settings, Accounts (F4/F5). The Providers card, then each
// provider's accounts: Claude's own profile list (AccountsPanel, with its
// registry state added per row), then every provider whose accounts this
// app manages. When the account registry is not ready, one callout says so
// and everything that does not need it stays usable.
import React, { useState } from 'react'
import type { AccountsSnapshot, IdentityConflictView } from '../../../../shared/providers'
import type { IdentityColorKey } from '../../../../shared/identity-colors'
import { resolveIdentityColor } from '../../../../shared/identity-colors'
import { useProviderAccountsStore, providerAccountActions, providerView } from '../../../stores/providerAccountsStore'
import { useResolvedTheme } from '../../../hooks/useThemeController'
import { DialogCallout } from '../../ui/Dialog'
import AccountsPanel from '../../AccountsPanel'
import { ProvidersCard } from './ProvidersCard'
import { ManagedAccountsSection } from './ManagedAccountsSection'
import { RowButton, ErrorLine } from './accounts-ui'

function ConflictBanner({ conflict, snapshot }: { conflict: IdentityConflictView; snapshot: AccountsSnapshot }) {
  const theme = useResolvedTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const provider = providerView(snapshot, conflict.providerId)?.displayName ?? conflict.providerId
  const resolve = async (keep: 'registry' | 'legacy') => {
    setBusy(true)
    setError(null)
    const r = await providerAccountActions.resolveConflict({
      identityId: conflict.identityId, field: conflict.field, providerId: conflict.providerId, legacyId: conflict.legacyId, keep,
    })
    setBusy(false)
    if (!r.ok) setError(r.message)
  }
  const dot = (key: string) => (
    <span className="inline-block w-2.5 h-2.5 rounded-full align-middle mx-0.5" style={{ background: resolveIdentityColor(key as IdentityColorKey, theme) }} aria-label={key} />
  )
  const testId = `identity-conflict-${conflict.identityId}-${conflict.field}`
  return (
    <DialogCallout tone="warning" testId={testId}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0" style={{ color: 'var(--text-primary)' }}>
          {conflict.field === 'friendlyName' ? (
            <>An account's name was changed both here and in {provider}. This app has "{conflict.registryValue}"; {provider} has "{conflict.legacyValue}".</>
          ) : (
            <>An account's colour was changed both here and in {provider}. This app has {dot(conflict.registryValue)}; {provider} has {dot(conflict.legacyValue)}.</>
          )}
          {error && <ErrorLine>{error}</ErrorLine>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <RowButton onClick={() => { void resolve('registry') }} disabled={busy} testId={`${testId}-keep-registry`}>Keep this app's</RowButton>
          <RowButton onClick={() => { void resolve('legacy') }} disabled={busy} testId={`${testId}-keep-legacy`}>Use {provider}'s</RowButton>
        </div>
      </div>
    </DialogCallout>
  )
}

export function AccountsSurface({ onAddClaudeAccount, children }: { onAddClaudeAccount: () => void | Promise<void>; children?: React.ReactNode }) {
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const loaded = useProviderAccountsStore((s) => s.loaded)
  const ready = snapshot?.registry.mode === 'ready'
  const managed = ready ? snapshot.providers.filter((p) => p.managedAccounts && p.providerId !== 'claude') : []
  return (
    <>
      <ProvidersCard />
      {loaded && !ready && (
        <DialogCallout tone="warning" testId="accounts-registry-callout" role="status">
          The account list is not available right now. Your Claude accounts below still work.
        </DialogCallout>
      )}
      {ready && snapshot.conflicts.map((c) => (
        <ConflictBanner key={`${c.identityId}-${c.field}-${c.legacyId}`} conflict={c} snapshot={snapshot} />
      ))}
      <AccountsPanel onAdd={onAddClaudeAccount} />
      {managed.map((p) => <ManagedAccountsSection key={p.providerId} providerId={p.providerId} />)}
      {children}
    </>
  )
}
