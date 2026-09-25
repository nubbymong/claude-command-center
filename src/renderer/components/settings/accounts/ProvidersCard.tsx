// WP2 commit 6 (F4, top): one row per provider the main process knows,
// with its machine status and the on/off switch. At least one provider
// always stays on; the main process enforces that and this card says so
// under the switch that tried. A provider whose CLI was not found, could not
// be checked, is too old, or has not been looked for yet gets "Check again"
// (6e, 6g): a new discovery, which is also the executable later launches and
// sign-ins run. The same row shows the provider's own install or update
// commands, to copy, once discovery says they are needed (6g: the retired
// Codex settings tab's install hint lives here now).
import React, { useEffect, useRef, useState } from 'react'
import type { InstallRecipeView, ProviderInstallationView } from '../../../../shared/providers'
import { useProviderAccountsStore, providerAccountActions, providerStatus } from '../../../stores/providerAccountsStore'
import { ProviderMark } from '../../sidebar/Badges'
import ToggleSwitch from '../../github/config/ToggleSwitch'
import { Section } from '../../SettingsPage'
import { Pill, StatusText, ErrorLine, MutedLine, RowButton } from './accounts-ui'
import { showHelloCodexReplay, codexSetUp } from '../../../onboarding/hello-codex'

/** The CLI is missing, could not be checked, cannot be used as found, or
 *  has not been looked for yet (main looks once at start, in the
 *  background, only for a provider switched on): worth checking now. */
export function offersCheckAgain(p: ProviderInstallationView): boolean {
  if (!p.enabled) return false
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

/** Said for a script recipe that arrives without main's own note. */
export const SCRIPT_NOTE = 'Shown for you to review and run yourself; the app does not run it.'

/** One command, verbatim as its publisher documents it, to copy. Settings
 *  shows and copies; running one in a terminal is the Codex setup page's. */
function RecipeLine({ recipe }: { recipe: InstallRecipeView }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
  const copy = () => {
    void navigator.clipboard?.writeText(recipe.displayCommand).then(() => {
      if (!live.current) return
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => { timer.current = null; setCopied(false) }, 1500)
    }).catch(() => { /* clipboard blocked: the command is selectable */ })
  }
  const note = recipe.note ?? (recipe.method === 'script' ? SCRIPT_NOTE : undefined)
  return (
    <div className="mt-1.5" data-testid={`provider-recipe-${recipe.id}`}>
      <div className="flex items-center gap-2">
        <code
          className="flex-1 min-w-0 border rounded-[6px] px-2 py-1 text-[11.5px] font-mono select-all break-all"
          style={{ background: 'var(--surface-sunken)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
          data-testid={`provider-recipe-command-${recipe.id}`}
        >
          {recipe.displayCommand}
        </code>
        <RowButton onClick={copy} testId={`provider-recipe-copy-${recipe.id}`}>{copied ? 'Copied' : 'Copy'}</RowButton>
      </div>
      {note && <MutedLine className="mt-0.5" testId={`provider-recipe-note-${recipe.id}`}>{note}</MutedLine>}
    </div>
  )
}

/** The install or update commands main knows for the provider on this
 *  computer, with where they come from. Asked for once, when the row first
 *  needs them. A provider with none for the purpose (Claude Code has none
 *  here), or whose commands could not be read, shows nothing: its status
 *  line and Check again still say what is wrong. */
function InstallCommands({ p, purpose }: { p: ProviderInstallationView; purpose: 'install' | 'update' }) {
  const [recipes, setRecipes] = useState<InstallRecipeView[] | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void providerAccountActions.installRecipes(p.providerId).then((r) => { if (live) setRecipes(r) })
    return () => { live = false }
  }, [p.providerId])
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
      {mine.map((r) => <RecipeLine key={r.id} recipe={r} />)}
    </div>
  )
}

function ProviderRow({ p, first }: { p: ProviderInstallationView; first: boolean }) {
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = providerStatus(p)
  const purpose = installPurpose(p)
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
              {checking ? 'Checking...' : p.discoveryState === 'unchecked' ? 'Check now' : 'Check again'}
            </RowButton>
          </div>
        )}
        {/* Keyed on the purpose: a CLI that goes from missing to too old
            reads the commands again, for the update ones. */}
        {purpose && <InstallCommands key={purpose} p={p} purpose={purpose} />}
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
