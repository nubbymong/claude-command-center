import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { buildLogTheme } from '../lib/terminal-theme'
import {
  DialogOverlay,
  DialogPanel,
  DialogBody,
  DialogFooter,
  DialogButton,
  DialogCallout,
  DIALOG_INPUT_CLASS,
  DIALOG_INPUT_STYLE,
  DIALOG_LABEL_CLASS,
  DIALOG_LABEL_STYLE,
} from './ui/Dialog'
import { noteClaudeMissingAtSetup, type FirstRunOutcome } from '../onboarding/provider-choice'
import { launchRefusalOf } from '../../shared/providers'
import type { InstallRecipeView, PathHintView } from '../../shared/providers'
import { claudeCodeInstallCommand } from '../utils/claudeInstallCommand'
import { providerAccountActions } from '../stores/providerAccountsStore'
import { InstallRecipeList, afterInstallMessage, type RunnableRecipe } from '../onboarding/InstallRecipeList'
import { PathHintNotice } from '../onboarding/PathHintNotice'
import { installTerminalOptions } from '../utils/commandTerminal'
import { generateId } from '../utils/id'

interface Props {
  /** `{ codexOnly: true }` when the user continued without Claude Code
   *  ("Use Codex only"); App saves that once the config is loaded. */
  onComplete: (outcome?: FirstRunOutcome) => void
  initialStep?: number
}

/** The first-run screen replaces the whole app, so its backdrop is the opaque
 *  app base rather than the usual scrim — there is nothing behind it to dim. */
const OPAQUE_BACKDROP: React.CSSProperties = { background: 'var(--surface-base)' }

/** What main's check said. `pathHint` when it found nothing: what helps
 *  (Anthropic's installer put claude in a folder PATH does not name, or a
 *  restart would help). */
type CliProbe = { installed: boolean; path?: string; probe: string; pathHint?: PathHintView }

/** A Claude Code install this screen is running (owner decisions D1 to D4,
 *  2026-10-10; ADR-024): main's line for one recipe, in a terminal on this
 *  screen. `ended` once its shell exited (the line ends it), with the code;
 *  `checking` while setup checks again; `checkedWhileRunning` once the
 *  user's Check again found nothing while the command still ran. */
type SetupInstall = { id: string; recipe: RunnableRecipe; ended: boolean; exitCode?: number; checking: boolean; checkedWhileRunning?: boolean }

/** Where the confirmation says the line runs. */
const SETUP_CONFIRM_WHERE = 'Run this in a terminal on this screen? It types the line below, and setup checks again when the command ends.'

/** What a pty.spawn answer that started nothing says, or null when it started. */
function notStarted(r: unknown): string | null {
  if (!r || typeof r !== 'object' || (r as { started?: unknown }).started !== false) return null
  const said = (r as { refused?: { message?: unknown } }).refused?.message
  return typeof said === 'string' && said !== '' ? said : 'The terminal did not start.'
}

/**
 * One terminal on this screen, attached to the PTY `sessionId` while it is
 * set (none while it is null). Its output is subscribed BEFORE `start` spawns
 * it, so nothing early is missed; keystrokes go to it; it opens and is fitted
 * once `containerRef` has a size, which is when `start` runs. The setup
 * terminal and the install terminal both run through it.
 */
function useEmbeddedTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sessionId: string | null,
  handlers: { start: (term: Terminal) => void; exit: (term: Terminal, exitCode: number) => void },
): void {
  const current = useRef(handlers)
  current.current = handlers
  useEffect(() => {
    if (!sessionId) return
    const term = new Terminal({
      theme: buildLogTheme(),
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Consolas', monospace",
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: true,
      scrollback: 1000,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    const unsubData = window.electronAPI.pty.onData(sessionId, (data) => { term.write(data) })
    const unsubExit = window.electronAPI.pty.onExit(sessionId, (code) => { current.current.exit(term, code) })
    term.onData((data) => { window.electronAPI.pty.write(sessionId, data) })
    const resizeObserver = new ResizeObserver(() => {
      try { fitAddon.fit() } catch { /* ignore */ }
    })
    let disposed = false
    const tryOpen = () => {
      if (disposed) return
      const container = containerRef.current
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
        requestAnimationFrame(tryOpen)
        return
      }
      term.open(container)
      fitAddon.fit()
      resizeObserver.observe(container)
      // The terminal is what the user works in on this screen, so it takes
      // the focus, not the page body.
      term.focus()
      current.current.start(term)
    }
    requestAnimationFrame(tryOpen)
    return () => {
      disposed = true
      resizeObserver.disconnect()
      unsubData()
      unsubExit()
      term.dispose()
    }
  }, [sessionId, containerRef])
}

/**
 * The setup flow's hero, kept deliberately OUT of the shared `DialogHeader`.
 *
 * This is a first-run full-screen takeover, not a settings dialog: at this
 * moment it is the entire app, so it keeps its centred layout, its large `>_`
 * mark and a real `<h1>` (the page would otherwise have no h1 at all). #360
 * migrated its colours to the semantic tokens and nothing else.
 */
function SetupHero({ titleId, mark, title, subtitle, big }: {
  titleId: string
  mark: string
  title: string
  subtitle: React.ReactNode
  /** Step 1 is the welcome and runs a size larger than the CLI step. */
  big?: boolean
}) {
  return (
    <div className={`text-center ${big ? 'mb-6' : 'mb-4'}`}>
      <div
        className={`${big ? 'text-4xl mb-3' : 'text-3xl mb-2'} font-mono`}
        style={{ color: 'var(--brand)' }}
        aria-hidden
      >
        {mark}
      </div>
      <h1
        id={titleId}
        className={`${big ? 'text-2xl mb-2' : 'text-xl mb-1'} font-bold`}
        style={{ color: 'var(--text-primary)' }}
      >
        {title}
      </h1>
      <p className={big ? '' : 'text-sm'} style={{ color: 'var(--text-muted)' }}>{subtitle}</p>
    </div>
  )
}

export default function SetupDialog({ onComplete, initialStep }: Props) {
  const [step, setStep] = useState(initialStep || 1)
  const [dataDir, setDataDir] = useState('')
  const [resourcesDir, setResourcesDir] = useState('')
  const [loading, setLoading] = useState(true)
  const [ptyExited, setPtyExited] = useState(false)
  const [ptySpawned, setPtySpawned] = useState(false)
  // Step 2's gate. `null` = not asked yet / asking; the terminal is not opened
  // and no PTY is spawned until a probe says the CLI is actually there.
  const [cliProbe, setCliProbe] = useState<CliProbe | null>(null)
  const [probing, setProbing] = useState(false)
  const [copied, setCopied] = useState(false)
  // When main cannot give its install commands: the npm one, for this
  // computer's terminal (npm.cmd on Windows), to copy.
  const installCommand = claudeCodeInstallCommand(window.electronPlatform)
  const termContainerRef = useRef<HTMLDivElement>(null)
  // Main's install commands for Claude Code (undefined: not read yet; null:
  // main could not give them), read whenever the not-installed screen may show.
  const [recipes, setRecipes] = useState<InstallRecipeView[] | null | undefined>(undefined)
  const recipesRead = useRef(0)
  // The install running on this screen, kept in a ref too: its terminal's
  // callbacks and the cleanup read the current one.
  const [install, setInstallState] = useState<SetupInstall | null>(null)
  const installRef = useRef<SetupInstall | null>(null)
  const setInstall = (next: SetupInstall | null) => { installRef.current = next; setInstallState(next) }
  const installContainerRef = useRef<HTMLDivElement>(null)
  // The user pressed Retry: a check that still finds nothing says what to do.
  const [tried, setTried] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    // Get default directories
    Promise.all([
      window.electronAPI.setup.getDefaultDataDir(),
      window.electronAPI.setup.getResourcesDir()
    ]).then(([dataDefault, resourcesDefault]) => {
      setDataDir(dataDefault)
      setResourcesDir(resourcesDefault)
      setLoading(false)
    })
  }, [])

  /**
   * The step-2 gate (phase 7 item B). Without the CLI there is nothing for the
   * setup PTY to run: it used to spawn anyway, print "'claude' is not
   * recognized", and let the user click through to an app in which no session
   * can ever start. Probe first; the terminal only opens on a hit.
   *
   * Fail-closed by design -- an errored probe reports `installed: false` from
   * main, and Retry re-asks -- so a user who installs the CLI in another window
   * is one click from unblocked.
   */
  const probeCli = useCallback(async (): Promise<CliProbe> => {
    setProbing(true)
    let result: CliProbe
    try {
      // Main brings its PATH up to date first (owner decision D4), so a
      // Claude Code installed since the app started is found.
      result = await window.electronAPI.setup.probeCli()
    } catch (err) {
      result = { installed: false, probe: err instanceof Error ? err.message : String(err) }
    }
    setProbing(false)
    setCliProbe(result)
    return result
  }, [])

  useEffect(() => {
    if (step !== 2 || cliProbe) return
    void probeCli()
  }, [step, cliProbe, probeCli])

  // Main's install commands: read on entry to step 2 (alongside the probe),
  // and again after every probe that did not find Claude Code, since whether
  // npm can run (Node.js found) may have changed. Only the latest read lands.
  const readRecipes = useCallback(async () => {
    const mine = ++recipesRead.current
    const r = await providerAccountActions.installRecipes('claude')
    if (mountedRef.current && mine === recipesRead.current) setRecipes(r)
  }, [])
  useEffect(() => {
    if (step !== 2 || cliProbe?.installed) return
    void readRecipes()
  }, [step, cliProbe, readRecipes])

  // Terminal setup for step 2: only once the CLI is known to be installed,
  // and not while an install runs on this screen.
  useEmbeddedTerminal(termContainerRef, step === 2 && cliProbe?.installed && !install ? '__cli_setup__' : null, {
    start: (term) => {
      // Spawn CLI setup PTY (listeners already subscribed)
      window.electronAPI.setup.spawnCliSetup(term.cols, term.rows).then((started) => {
        // Main refuses this Claude Code terminal while Claude Code is off:
        // said here, and Skip for now goes on without it.
        const refusal = launchRefusalOf(started)
        if (refusal) { term.writeln(refusal.message); return }
        setPtySpawned(true)
      })
    },
    exit: (term) => {
      setPtyExited(true)
      term.write('\r\n\x1b[32mClaude CLI setup complete. Click Finish to continue.\x1b[0m\r\n')
    },
  })

  // The install on this screen: main's line, started exactly as the install
  // tab starts it (shell only, never elevated, no command secrets; its
  // program found only in the folders PATH names in full on Windows), in a
  // terminal here, since the app's tabs do not exist yet. The line ends the
  // shell when its command ends; setup then checks again.
  const checkAfterInstall = async (id: string) => {
    const cur = installRef.current
    if (!cur || cur.id !== id) return
    setInstall({ ...cur, checking: true })
    const result = await probeCli()
    await readRecipes()
    const now = installRef.current
    if (!mountedRef.current || !now || now.id !== id) return
    // Found: the step-2 terminal opens for Claude Code's own setup.
    if (result.installed) { setInstall(null); return }
    setInstall({ ...now, checking: false })
  }
  const installEnded = (id: string, exitCode: number | undefined) => {
    const cur = installRef.current
    if (!cur || cur.id !== id || cur.ended) return
    setInstall({ ...cur, ended: true, ...(exitCode !== undefined ? { exitCode } : {}) })
    void checkAfterInstall(id)
  }
  useEmbeddedTerminal(installContainerRef, install?.id ?? null, {
    start: (term) => {
      const cur = installRef.current
      if (!cur) return
      const id = cur.id
      Promise.resolve(window.electronAPI.pty.spawn(id, {
        cols: term.cols, rows: term.rows, shellOnly: true, provider: 'claude',
        terminalOptions: installTerminalOptions(cur.recipe.runLine),
      })).then((r) => {
        const why = notStarted(r)
        if (why) { term.writeln(why); installEnded(id, undefined) }
      }, (err: unknown) => {
        term.writeln(`The terminal did not start: ${err instanceof Error ? err.message : String(err)}`)
        installEnded(id, undefined)
      })
    },
    exit: (term, code) => {
      const id = installRef.current?.id
      term.write(`\r\n\x1b[90mThe command ended${code ? ` with exit code ${code}` : ''}. Checking for Claude Code...\x1b[0m\r\n`)
      if (id) installEnded(id, code)
    },
  })
  // Leaving setup while the command runs stops it.
  useEffect(() => () => {
    const cur = installRef.current
    if (cur && !cur.ended) window.electronAPI.pty.kill(cur.id)
  }, [])

  const runInstall = (recipe: RunnableRecipe) => {
    if (installRef.current) return
    setTried(false)
    setInstall({ id: generateId(), recipe, ended: false, checking: false })
  }
  // Back from the install: a command still running is stopped, then setup
  // checks again (the user may have installed it anyway).
  const leaveInstall = () => {
    const cur = installRef.current
    if (cur && !cur.ended) window.electronAPI.pty.kill(cur.id)
    setInstall(null)
    void probeCli()
  }
  const retry = async () => {
    await probeCli()
    if (mountedRef.current) setTried(true)
  }
  // Check again on the install screen. After the command ended: the check
  // it already made, again. While it still runs (its shell may be sitting at
  // a prompt): a check that leaves it running; when Claude Code is found, the
  // command's terminal is stopped and setup goes on.
  const checkInstallNow = async () => {
    const cur = installRef.current
    if (!cur || cur.checking) return
    if (cur.ended) { await checkAfterInstall(cur.id); return }
    setInstall({ ...cur, checking: true })
    const result = await probeCli()
    const now = installRef.current
    if (!mountedRef.current || !now || now.id !== cur.id) return
    if (result.installed) {
      if (!now.ended) window.electronAPI.pty.kill(now.id)
      setInstall(null)
      return
    }
    setInstall({ ...now, checking: false, checkedWhileRunning: true })
  }

  // Exit, on every Setup screen: the window closes as its own close button
  // closes it (the app's title bar is not drawn while setup shows), which
  // quits the app on Windows and Linux. A command still running on this
  // screen, and the Claude Code setup terminal, are stopped first.
  const handleExit = () => {
    const cur = installRef.current
    if (cur && !cur.ended) window.electronAPI.pty.kill(cur.id)
    if (ptySpawned) void window.electronAPI.setup.killCliSetup()
    window.electronAPI.window.close()
  }
  const exitButton = (
    <DialogButton variant="secondary" onClick={handleExit} testId="setup-exit">
      Exit
    </DialogButton>
  )

  // The "not installed" screen's primary button, Retry, has the focus each
  // time a check ends on that screen: when it opens (it only ever opens when
  // a check ends), and after Retry's own check, while which Retry is disabled
  // and the focus it had falls to the page body. A control the user moved to
  // keeps it.
  const missingPanelRef = useRef<HTMLDivElement>(null)
  const wasProbing = useRef(false)
  useEffect(() => {
    if (probing) { wasProbing.current = true; return }
    if (!wasProbing.current) return
    wasProbing.current = false
    const at = document.activeElement
    if (at && at !== document.body) return
    missingPanelRef.current?.querySelector<HTMLButtonElement>('[data-testid="setup-cli-retry"]')?.focus()
  }, [probing])

  const handleBrowseData = async () => {
    const result = await window.electronAPI.setup.selectDataDir()
    if (result) setDataDir(result)
  }

  const handleBrowseResources = async () => {
    const result = await window.electronAPI.setup.selectResourcesDir()
    if (result) setResourcesDir(result)
  }

  const handleContinue = async () => {
    await window.electronAPI.setup.setDataDir(dataDir)
    await window.electronAPI.setup.setResourcesDir(resourcesDir)
    // Re-arm the CLI gate: coming back to step 2 always re-probes, so a user who
    // went Back to install the CLI is not shown a stale verdict.
    setCliProbe(null)
    setTried(false)
    setStep(2)
  }

  const handleFinish = async () => {
    await window.electronAPI.setup.killCliSetup()
    onComplete()
  }

  const handleSkip = async () => {
    await window.electronAPI.setup.killCliSetup()
    onComplete()
  }

  // The way through for someone who only uses Codex. Nothing is written
  // here: App saves Claude off and Codex on once the stores hold the loaded
  // config (setup-handoff.ts), and hands this run to Codex setup. What comes
  // next depends on the screen: on a fresh install (the first-run screen) the
  // onboarding's assistants page offers Codex alone and says why, then the
  // Codex setup page follows; on the version-change screen, an upgrader
  // (who is never shown the assistants page) gets the Codex setup page once,
  // in that run (alone, or after the release notes when they are due). So
  // does the first-run screen of a new computer pointed at an existing
  // resources folder, which is an upgrader too.
  const handleCodexOnly = () => {
    const cur = installRef.current
    if (cur && !cur.ended) window.electronAPI.pty.kill(cur.id)
    noteClaudeMissingAtSetup()
    onComplete({ codexOnly: true })
  }

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center z-50" style={OPAQUE_BACKDROP}>
        <div style={{ color: 'var(--text-muted)' }}>Loading...</div>
      </div>
    )
  }

  // Step 2, blocked: the Claude CLI is not installed on this machine. A FULL
  // STOP for Claude Code -- no Skip, no Continue into a Claude setup that
  // cannot run, because "carry on and hope" only produces a broken app the
  // user has no way to diagnose. The ways out are: install it and Check
  // again, Exit, go Back, or (WP2) "Use Codex only", which turns Claude Code
  // off rather than pretending it is there. Claude Code installed in
  // Anthropic's own folder, which PATH does not name, is said as such, with
  // Add it to PATH for me on Windows (PathHintNotice).
  //
  // Every screen's buttons follow BUTTON_RULE (InstallRecipeList.tsx): Back
  // alone at the left of the footer, then at the right Exit, any
  // alternative, and the screen's one primary last; all small.
  //
  // Each screen's primary button takes focus when the screen opens, rather
  // than leaving it on the page body: Continue by autoFocus, Check again when
  // the check that opens this screen ends (above). The screens are keyed so
  // each is mounted afresh: they share their frame, and without a key React
  // would reuse one screen's footer button for the next (Check again, say,
  // becoming step 1's Continue after Back) and autoFocus would not run again.
  // Step 2, installing: the command runs in the terminal below; setup checks
  // again when it ends. Back stops it (if it still runs) and checks again;
  // Check again works while it runs too.
  if (step === 2 && install) {
    const hint = install.ended && !install.checking ? cliProbe?.pathHint : undefined
    return (
      <DialogOverlay key="setup-cli-install" style={OPAQUE_BACKDROP}>
        <DialogPanel width="w-[672px]" labelledBy="setup-cli-install-title">
          <DialogBody className="space-y-3">
            <div data-testid="setup-cli-install">
              <SetupHero
                titleId="setup-cli-install-title"
                mark=">_"
                title="Installing Claude Code"
                subtitle="The command runs in the terminal below; it may show nothing for a minute while it downloads. Answer any question it asks there. Setup checks again when it ends; if it stops at a prompt, press Check again."
              />
            </div>
            <div
              ref={installContainerRef}
              className="rounded-lg overflow-hidden border relative"
              style={{ height: '340px', backgroundColor: 'var(--surface-stage)', borderColor: 'var(--border-subtle)' }}
              data-testid="setup-cli-install-terminal"
            />
            {install.checking && (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }} data-testid="setup-cli-install-checking">
                Checking for Claude Code…
              </p>
            )}
            {!install.ended && !install.checking && install.checkedWhileRunning && (
              <DialogCallout tone="warning" role="status" testId="setup-cli-install-not-yet">
                Claude Code was not found yet. If the terminal above is back at a prompt, the command has ended: press Back to try another command.
              </DialogCallout>
            )}
            {hint && (
              <PathHintNotice hint={hint} toolName="Claude Code" providerId="claude" testIdPrefix="setup" onAdded={() => { void checkAfterInstall(install.id) }} />
            )}
            {install.ended && !install.checking && !hint && (
              <DialogCallout tone="warning" role="status" testId="setup-cli-install-ended">
                {afterInstallMessage('Claude Code', { ended: true, exitCode: install.exitCode })}{' '}
                Back lists the other install commands.
              </DialogCallout>
            )}
          </DialogBody>
          <DialogFooter
            left={
              <DialogButton variant="secondary" onClick={leaveInstall} testId="setup-cli-install-back">
                Back
              </DialogButton>
            }
          >
            {exitButton}
            <DialogButton
              variant="primary"
              onClick={() => { void checkInstallNow() }}
              disabled={install.checking}
              testId="setup-cli-install-retry"
            >
              {install.checking ? 'Checking…' : 'Check again'}
            </DialogButton>
          </DialogFooter>
        </DialogPanel>
      </DialogOverlay>
    )
  }

  if (step === 2 && cliProbe && !cliProbe.installed) {
    const listed = Array.isArray(recipes) && recipes.some((r) => r.purpose === 'install')
    const hint = cliProbe.pathHint
    return (
      <DialogOverlay key="setup-cli-missing" style={OPAQUE_BACKDROP}>
        <DialogPanel width="w-[672px]" labelledBy="setup-cli-missing-title" panelRef={missingPanelRef}>
          <DialogBody className="space-y-4">
            <SetupHero
              titleId="setup-cli-missing-title"
              mark="!"
              title={hint ? 'Claude Code cannot be found yet' : 'Claude Code is not installed'}
              subtitle="AI Code Conductor runs the Claude Code CLI; it cannot set up, or run a Claude session, without it."
            />

            {hint ? (
              <PathHintNotice hint={hint} toolName="Claude Code" providerId="claude" testIdPrefix="setup" onAdded={() => { void probeCli() }} />
            ) : (
            <DialogCallout
              tone="danger"
              role="alert"
              title="Claude Code setup cannot continue"
              testId="setup-cli-missing"
            >
              <p>
                The <code style={{ color: 'var(--text-primary)' }}>claude</code> command was not found on this
                computer. Every Claude session AI Code Conductor launches is a Claude Code process, so there is nothing
                to configure for it until it is installed.
              </p>
            </DialogCallout>
            )}

            {recipes === undefined ? null : listed ? (
              <div className="install-recipes">
                <InstallRecipeList
                  purpose="install"
                  recipes={recipes}
                  toolName="Claude Code"
                  testIdPrefix="setup"
                  confirmWhere={SETUP_CONFIRM_WHERE}
                  onRun={runInstall}
                />
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid="setup-cli-install-hint">
                  Run it for me runs the command in a terminal on this screen, and setup checks again when it ends. If you
                  install Claude Code another way, press Check again once it is done.
                </p>
              </div>
            ) : (
            <div>
              <p className="text-xs mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Install it with Node.js 22 or later, in a terminal:
              </p>
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 px-3 py-2 rounded-lg border font-mono text-xs select-all"
                  style={{ background: 'var(--surface-stage)', borderColor: 'var(--border-subtle)', color: 'var(--brand)' }}
                  data-testid="setup-cli-install-command"
                >
                  {installCommand}
                </code>
                <DialogButton
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(installCommand).then(() => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }).catch(() => { /* clipboard blocked — the text is select-all anyway */ })
                  }}
                  className="shrink-0"
                  testId="setup-cli-copy"
                >
                  {copied ? 'Copied' : 'Copy'}
                </DialogButton>
              </div>
              <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
                Then come back and press Check again.
              </p>
            </div>
            )}

            {tried && !probing && !hint && (
              <DialogCallout tone="warning" role="status" testId="setup-cli-still-missing">
                {afterInstallMessage('Claude Code', { ended: false })}
              </DialogCallout>
            )}

            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid="setup-cli-probe-detail">
              Checked with <code>{cliProbe.probe}</code>.
            </p>

            <div
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg border"
              style={{ background: 'var(--surface-base)', borderColor: 'var(--border-subtle)' }}
              data-testid="setup-codex-only"
            >
              <p className="flex-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                Only using Codex? Continue without Claude Code; you can add it later in Settings, Accounts.
              </p>
              <DialogButton variant="secondary" onClick={handleCodexOnly} className="shrink-0" testId="setup-codex-only-button">
                Use Codex only
              </DialogButton>
            </div>
          </DialogBody>

          <DialogFooter
            left={
              <DialogButton variant="secondary" onClick={() => setStep(1)} testId="setup-cli-back">
                Back
              </DialogButton>
            }
          >
            {exitButton}
            <DialogButton
              variant="primary"
              onClick={() => { void retry() }}
              disabled={probing}
              testId="setup-cli-retry"
            >
              {probing ? 'Checking…' : 'Check again'}
            </DialogButton>
          </DialogFooter>
        </DialogPanel>
      </DialogOverlay>
    )
  }

  // Step 2: Claude CLI Setup. Its primary button waits for the terminal
  // below, which is what the user works in here, so no button is focused.
  if (step === 2) {
    return (
      <DialogOverlay key="setup-cli" style={OPAQUE_BACKDROP}>
        <DialogPanel width="w-[672px]" labelledBy="setup-cli-title">
          <DialogBody>
            <SetupHero
              titleId="setup-cli-title"
              mark=">_"
              title="Claude CLI Setup"
              subtitle={<>
                Claude needs to trust this directory and authenticate.
                Complete the prompts below, then type <code style={{ color: 'var(--brand)' }}>/exit</code> when done.
              </>}
            />
            <div
              ref={termContainerRef}
              className="rounded-lg overflow-hidden border relative"
              style={{ height: '400px', backgroundColor: 'var(--surface-stage)', borderColor: 'var(--border-subtle)' }}
            >
              {!cliProbe && (
                <div className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }} data-testid="setup-cli-checking">
                  Checking for the Claude Code CLI…
                </div>
              )}
            </div>
          </DialogBody>

          <DialogFooter>
            {exitButton}
            {/* Held back until the CLI is confirmed: while the probe is still
                out, Skip would be a way past a gate that has not decided yet.
                It stays the way on when main refuses this terminal. */}
            {cliProbe?.installed && (
              <DialogButton variant="secondary" onClick={handleSkip} testId="setup-cli-skip">
                Skip for now
              </DialogButton>
            )}
            {/* The old green / purple fills each carried a `text-base` class
                meaning "dark text on the fill" — but that name is a FONT SIZE in
                Tailwind, so the label just inherited its colour and sat
                unreadable on the fill. --text-on-brand (what DialogButton's
                primary variant sets) is the colour that was intended. */}
            <DialogButton
              variant="primary"
              onClick={handleFinish}
              disabled={!ptySpawned || !cliProbe?.installed}
              testId="setup-cli-finish"
            >
              {ptyExited ? 'Done' : 'Skip & Continue'}
            </DialogButton>
          </DialogFooter>
        </DialogPanel>
      </DialogOverlay>
    )
  }

  // Step 1: Directory selection
  return (
    <DialogOverlay key="setup-dirs" style={OPAQUE_BACKDROP}>
      <DialogPanel width="w-[576px]" labelledBy="setup-welcome-title">
        <DialogBody className="space-y-5">
          <SetupHero
            titleId="setup-welcome-title"
            mark=">_"
            title="Welcome to AI Code Conductor"
            subtitle="Configure your storage directories"
            big
          />
          {/* Data Directory */}
          <div>
            <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>
              Data Directory
            </label>
            <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
              Internal app data: session configs, logs, debug captures
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={dataDir}
                onChange={(e) => setDataDir(e.target.value)}
                className={DIALOG_INPUT_CLASS.replace('w-full', 'flex-1')}
                style={DIALOG_INPUT_STYLE}
              />
              <DialogButton variant="secondary" onClick={handleBrowseData} className="shrink-0" style={{ height: 'auto', alignSelf: 'stretch' }}>
                Browse
              </DialogButton>
            </div>
          </div>

          {/* Resources Directory */}
          <div>
            <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>
              Resources Directory
            </label>
            <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
              Shared resources: insights, screenshots, skills, scripts
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={resourcesDir}
                onChange={(e) => setResourcesDir(e.target.value)}
                className={DIALOG_INPUT_CLASS.replace('w-full', 'flex-1')}
                style={DIALOG_INPUT_STYLE}
              />
              <DialogButton variant="secondary" onClick={handleBrowseResources} className="shrink-0" style={{ height: 'auto', alignSelf: 'stretch' }}>
                Browse
              </DialogButton>
            </div>
            <p className="text-[11px] mt-1.5" style={{ color: 'var(--brand)' }}>
              Tip: Use a network-mountable path to share resources across SSH sessions
            </p>
          </div>

          <div
            className="text-xs p-3 rounded-lg border"
            style={{ background: 'var(--surface-base)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Data contains:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Session configs</li>
                  <li>Terminal logs</li>
                  <li>Debug data</li>
                </ul>
              </div>
              <div>
                <p className="font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Resources contains:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Insights reports</li>
                  <li>Screenshots</li>
                  <li>Skills &amp; Scripts</li>
                </ul>
              </div>
            </div>
          </div>
        </DialogBody>

        <DialogFooter>
          {exitButton}
          {/* Was a purple fill with the same font-size-not-a-colour trap as
              step 2's Finish button. */}
          <DialogButton variant="primary" onClick={handleContinue} autoFocus testId="setup-continue">
            Continue
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
