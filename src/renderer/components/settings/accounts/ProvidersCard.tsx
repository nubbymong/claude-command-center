// WP2 commit 6 (F4, top): one row per provider the main process knows,
// with its machine status and the on/off switch. At least one provider
// always stays on; the main process enforces that and this card says so
// under the switch that tried. A switch-off refused because the provider is
// in use says how much, following the count each snapshot main publishes
// carries until nothing holds it. A provider whose CLI was not found, could not
// be checked, is too old, or has not been looked for yet gets "Check again"
// (6e, 6g): a new discovery, which is also the executable later launches and
// sign-ins run. The same row shows the provider's own install or update
// commands once discovery says they are needed (6g: the retired Codex
// settings tab's install hint lives here now), each with Run it for me and
// Copy (owner decision D2, 2026-10-10; ADR-024): Run it for me opens a
// visible terminal tab, shows it, and checks again when the tab ends.
import React, { useEffect, useState } from 'react'
import type { InstallRecipeView, ProviderId, ProviderInstallationView } from '../../../../shared/providers'
import { useProviderAccountsStore, providerAccountActions, providerStatus, providerNotSetUp } from '../../../stores/providerAccountsStore'
import { ProviderMark } from '../../sidebar/Badges'
import ToggleSwitch from '../../github/config/ToggleSwitch'
import { Section } from '../../SettingsPage'
import { Pill, StatusText, ErrorLine, MutedLine, RowButton } from './accounts-ui'
import { showHelloCodexReplay, codexSetUp } from '../../../onboarding/hello-codex'
import { tryGetRendererProvider } from '../../../providers/core'
import { InstallRecipeRow, afterInstallMessage, type RunnableRecipe } from '../../../onboarding/InstallRecipeList'
import { openInstallTab, installTabRunning, useInstallTabRunning, type InstallTab } from '../../../utils/installTab'
import { useSessionStore } from '../../../stores/sessionStore'

/** The user has not said whether they use the provider (Codex after an
 *  update, until they answer: owner decision 2026-09-26). The row never says
 *  "On" then: main starts nothing of it, not even a look for its CLI. It
 *  says "Not set up" instead, with the way to set it up: the switch, which
 *  records the answer. */
export function notSetUp(p: ProviderInstallationView): boolean {
  return p.enabled && providerNotSetUp(p)
}

/** The CLI is missing, could not be checked, cannot be used as found, or
 *  has not been looked for yet (main looks once at start, in the
 *  background, only for a provider switched on): worth checking now. Not
 *  for a provider that is not set up: main does not look for its CLI. */
export function offersCheckAgain(p: ProviderInstallationView): boolean {
  if (!p.enabled || notSetUp(p)) return false
  if (p.discoveryState === 'unchecked' || p.discoveryState === 'missing' || p.discoveryState === 'invalid' || p.discoveryState === 'error') return true
  return p.discoveryState === 'found' && (p.compatibility === 'too-old' || p.compatibility === 'unsupported')
}

/** Which commands help: install ones when discovery found no usable CLI
 *  (not found, did not run, could not be checked), update ones when it
 *  found one that cannot be used as it is. None before discovery has said
 *  anything: an unchecked CLI may well be installed. */
export function installPurpose(p: ProviderInstallationView): 'install' | 'update' | null {
  if (!offersCheckAgain(p) || p.discoveryState === 'unchecked') return null
  return p.discoveryState === 'found' ? 'update' : 'install'
}

/** Where the confirmation says the line runs. */
const CONFIRM_WHERE = 'Run this in a new terminal tab? It types the line below, and the app checks again when the command ends.'

// The install tab each provider's row last opened, and the providers whose
// install tab has ended since. Held for the renderer's lifetime: the card is
// gone while its tab is shown (the sessions view), and comes back to them.
const providerTabs = new Map<ProviderId, InstallTab>()
const endedInstalls = new Set<ProviderId>()

/** Test seam: forget every tab a row opened. */
export function _resetProviderInstallTabsForTest(): void {
  providerTabs.clear()
  endedInstalls.clear()
}

/** The install or update commands main knows for the provider on this
 *  computer, with where they come from, verbatim as its publisher documents
 *  them (the publisher's own installer first). Asked for when the row first
 *  needs them, and again after each check: the update commands are the ones
 *  for the install that check found, and whether npm can run (Node.js found)
 *  may have changed. A provider with none for the purpose, or whose commands
 *  could not be read, shows nothing: its status line and Check again still
 *  say what is wrong. */
function InstallCommands({ p, purpose, onRun, busyReason }: {
  p: ProviderInstallationView
  purpose: 'install' | 'update'
  onRun: (r: RunnableRecipe) => void
  busyReason?: string
}) {
  const [recipes, setRecipes] = useState<InstallRecipeView[] | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void providerAccountActions.installRecipes(p.providerId).then((r) => { if (live) setRecipes(r) })
    return () => { live = false }
  }, [p.providerId, p.lastCheckedAt])
  const mine = (recipes ?? []).filter((r) => r.purpose === purpose)
  if (mine.length === 0) return null
  return (
    <div className="mt-1.5" data-testid={`provider-${purpose}-commands-${p.providerId}`}>
      <MutedLine testId={`provider-recipes-source-${p.providerId}`}>
        {purpose === 'install' ? `Install ${p.displayName}` : `Update ${p.displayName}`}
        {' '}
        <span title={mine[0].sourceUrl}>({/readme/i.test(mine[0].sourceUrl) ? `from ${mine[0].publisher}'s README` : `from ${mine[0].publisher}`})</span>
        {', then Check again.'}
      </MutedLine>
      <div className="install-recipes grid gap-1.5 mt-1.5">
        {mine.map((r) => <InstallRecipeRow key={r.id} recipe={r} testIdPrefix="provider" confirmWhere={CONFIRM_WHERE} onRun={onRun} busyReason={busyReason} />)}
      </div>
    </div>
  )
}

function ProviderRow({ p, first }: { p: ProviderInstallationView; first: boolean }) {
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A switch-off refused because something holds the provider: how many, as
  // main counted at the refusal and then with every snapshot after it. The
  // line goes once nothing holds the provider.
  const [inUse, setInUse] = useState<number | null>(null)
  const status = providerStatus(p)
  const purpose = installPurpose(p)
  const codexReady = useProviderAccountsStore((s) => codexSetUp(s.snapshot))

  // Each new snapshot carries main's count afresh (p.inUse, always set), and
  // after a refusal main publishes one each time the count moves: the line
  // follows them and reads no snapshot of its own.
  useEffect(() => {
    const live = p.inUse
    setInUse((n) => (n === null ? null : live > 0 ? live : null))
  }, [p])

  // The result arrives with the snapshot main pushes after the check, which
  // main makes after bringing its PATH up to date (owner decision D4).
  const [checked, setChecked] = useState(false)
  const checkAgain = async () => {
    setChecking(true)
    setError(null)
    setInUse(null)
    const r = await providerAccountActions.discover(p.providerId)
    setChecking(false)
    setChecked(true)
    if (!r.ok) setError(r.message)
  }

  // One install or update at a time for this provider: while the tab its row
  // opened still runs, Run it for me is off and says where it runs. When that
  // tab ends (its line ends the shell), the app checks again, whether or not
  // this card is showing then.
  const [tab, setTab] = useState(() => providerTabs.get(p.providerId) ?? null)
  const running = useInstallTabRunning(tab)
  const busyReason = tab && running ? `Already running in the ${tab.label} tab` : undefined
  const run = (recipe: RunnableRecipe) => {
    const providerId = p.providerId
    if (installTabRunning(providerTabs.get(providerId), useSessionStore.getState().sessions)) return
    endedInstalls.delete(providerId)
    setChecked(false)
    const label = `${recipe.purpose === 'update' ? 'Update' : 'Install'} ${p.displayName}`
    const opened = openInstallTab({
      label, runLine: recipe.runLine, show: true,
      onEnded: () => { endedInstalls.add(providerId); void providerAccountActions.discover(providerId) },
    })
    providerTabs.set(providerId, opened)
    setTab(opened)
  }
  // Found since: what an ended install said no longer applies.
  useEffect(() => {
    if (!purpose) endedInstalls.delete(p.providerId)
  }, [purpose, p.providerId])
  // Still not found after its install ended, or after the user's own Check
  // again. (A CLI found but too old says so in its status line.)
  const after = purpose !== 'install' || checking ? null
    : endedInstalls.has(p.providerId) && !running ? afterInstallMessage(p.displayName, { ended: true })
    : checked ? afterInstallMessage(p.displayName, { ended: false }) : null

  // Not set up: the switch shows off, and turning it on is the answer.
  const unset = notSetUp(p)
  const on = p.enabled && !unset

  const toggle = async () => {
    setBusy(true)
    setError(null)
    setInUse(null)
    // Main first (its refusals stand), then the saved setting (and, for a
    // provider not set up, the answer with it: saveProviderSwitch).
    const r = await providerAccountActions.switchProvider(p.providerId, !on)
    setBusy(false)
    if (r.ok) return
    if (r.code === 'last-provider') setError('At least one provider stays on.')
    else if (r.code === 'consumers' && typeof r.consumers === 'number' && r.consumers > 0) {
      // Everything holding the provider (sessions, reviews, sign-ins,
      // operations): never called sessions.
      setInUse(r.consumers)
    } else setError(r.message)
  }
  const shown = error ?? (inUse !== null ? `${p.displayName} is in use (${inUse}).` : null)

  return (
    <div className={`flex items-start gap-3 ${first ? 'pb-2.5' : 'py-2.5'}`} style={first ? undefined : { borderTop: '1px solid var(--border-subtle)' }} data-testid={`provider-row-${p.providerId}`}>
      <span className="mt-0.5"><ProviderMark providerId={p.providerId} size={20} /></span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {p.displayName}
          {/* Labelled with the provider's maturity (WP1.21), read from its descriptor. */}
          {tryGetRendererProvider(p.providerId)?.maturity === 'beta' && <Pill tone="beta" testId={`provider-beta-${p.providerId}`}>Beta</Pill>}
        </div>
        <StatusText tone={status.tone} testId={`provider-status-${p.providerId}`}>{status.text}</StatusText>
        {unset && (
          <MutedLine testId={`provider-not-set-up-${p.providerId}`}>
            Turn {p.displayName} on to set it up, then add a {p.displayName} account below.
          </MutedLine>
        )}
        {offersCheckAgain(p) && (
          <div className="mt-1">
            <RowButton onClick={() => { void checkAgain() }} disabled={checking} testId={`provider-check-again-${p.providerId}`}>
              {checking ? 'Checking...' : p.discoveryState === 'unchecked' ? 'Check now' : 'Check again'}
            </RowButton>
          </div>
        )}
        {/* Keyed on the purpose: a CLI that goes from missing to too old
            reads the commands again, for the update ones. */}
        {purpose && <InstallCommands key={purpose} p={p} purpose={purpose} onRun={run} busyReason={busyReason} />}
        {after && <MutedLine className="mt-1" testId={`provider-after-install-${p.providerId}`}>{after}</MutedLine>}
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
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }} data-testid={`provider-switch-text-${p.providerId}`}>{unset ? 'Not set up' : on ? 'On' : 'Off'}</span>
          <ToggleSwitch
            state={on ? 'on' : 'off'}
            onToggle={() => { void toggle() }}
            label={on ? `Turn ${p.displayName} off` : `Turn ${p.displayName} on`}
            disabled={busy}
          />
        </div>
        {shown && <ErrorLine testId={`provider-error-${p.providerId}`}>{shown}</ErrorLine>}
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
