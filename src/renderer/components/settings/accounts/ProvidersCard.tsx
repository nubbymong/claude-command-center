// WP2 commit 6 (F4, top): one row per provider the main process knows,
// with its machine status and the on/off switch. At least one provider
// always stays on; the main process enforces that and this card says so
// under the switch that tried. A provider whose CLI was not found, could not
// be checked, or is too old gets "Check again" (6e): a new discovery, which
// is also the executable later launches and sign-ins run.
import React, { useState } from 'react'
import type { ProviderInstallationView } from '../../../../shared/providers'
import { useProviderAccountsStore, providerAccountActions, providerStatus } from '../../../stores/providerAccountsStore'
import { ProviderMark } from '../../sidebar/Badges'
import ToggleSwitch from '../../github/config/ToggleSwitch'
import { Section } from '../../SettingsPage'
import { Pill, StatusText, ErrorLine, RowButton } from './accounts-ui'
import { showHelloCodexReplay, codexSetUp } from '../../../onboarding/hello-codex'

/** The CLI is missing, could not be checked, or cannot be used as found:
 *  worth checking again once the user has installed or updated it. */
export function offersCheckAgain(p: ProviderInstallationView): boolean {
  if (!p.enabled) return false
  if (p.discoveryState === 'missing' || p.discoveryState === 'invalid' || p.discoveryState === 'error') return true
  return p.discoveryState === 'found' && (p.compatibility === 'too-old' || p.compatibility === 'unsupported')
}

function ProviderRow({ p, first }: { p: ProviderInstallationView; first: boolean }) {
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = providerStatus(p)
  const codexReady = useProviderAccountsStore((s) => codexSetUp(s.snapshot))

  // The result arrives with the snapshot main pushes after the check.
  const checkAgain = async () => {
    setChecking(true)
    setError(null)
    const r = await providerAccountActions.discover(p.providerId)
    setChecking(false)
    if (!r.ok) setError(r.message)
  }

  const toggle = async () => {
    setBusy(true)
    setError(null)
    // Main first (its refusals stand), then the saved setting.
    const r = await providerAccountActions.switchProvider(p.providerId, !p.enabled)
    setBusy(false)
    if (r.ok) return
    if (r.code === 'last-provider') setError('At least one provider stays on.')
    else if (r.code === 'consumers' && typeof r.consumers === 'number' && r.consumers > 0) {
      // Everything holding the provider (sessions, reviews, sign-ins,
      // operations): never called sessions.
      setError(`${p.displayName} is in use (${r.consumers}).`)
    } else setError(r.message)
  }

  return (
    <div className={`flex items-start gap-3 ${first ? 'pb-2.5' : 'py-2.5'}`} style={first ? undefined : { borderTop: '1px solid var(--border-subtle)' }} data-testid={`provider-row-${p.providerId}`}>
      <span className="mt-0.5"><ProviderMark providerId={p.providerId} size={20} /></span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {p.displayName}
          {p.providerId === 'codex' && <Pill tone="beta" testId={`provider-beta-${p.providerId}`}>Beta</Pill>}
        </div>
        <StatusText tone={status.tone} testId={`provider-status-${p.providerId}`}>{status.text}</StatusText>
        {offersCheckAgain(p) && (
          <div className="mt-1">
            <RowButton onClick={() => { void checkAgain() }} disabled={checking} testId={`provider-check-again-${p.providerId}`}>
              {checking ? 'Checking...' : 'Check again'}
            </RowButton>
          </div>
        )}
        {/* The Codex introduction, replayed (WP2 commit 6f): offered only
            once Codex is set up, since its first page says the account is
            ready. A replay marks it seen only if it was still due. */}
        {p.providerId === 'codex' && codexReady && (
          <div className="mt-1" data-ux-id="provider-codex-intro">
            <RowButton onClick={showHelloCodexReplay} testId="provider-codex-intro">Show the Codex introduction</RowButton>
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{p.enabled ? 'On' : 'Off'}</span>
          <ToggleSwitch
            state={p.enabled ? 'on' : 'off'}
            onToggle={() => { void toggle() }}
            label={p.enabled ? `Turn ${p.displayName} off` : `Turn ${p.displayName} on`}
            disabled={busy}
          />
        </div>
        {error && <ErrorLine testId={`provider-error-${p.providerId}`}>{error}</ErrorLine>}
      </div>
    </div>
  )
}

export function ProvidersCard() {
  const providers = useProviderAccountsStore((s) => s.snapshot?.providers)
  if (!providers || providers.length === 0) return null
  return (
    <Section
      title="Providers"
      testId="providers-card"
      icon={<path d="M3 4.5h10M3 8h10M3 11.5h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}
    >
      <div>
        {providers.map((p, i) => <ProviderRow key={p.providerId} p={p} first={i === 0} />)}
      </div>
    </Section>
  )
}
