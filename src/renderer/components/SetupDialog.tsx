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

interface Props {
  /** `{ codexOnly: true }` when the user continued without Claude Code
   *  ("Use Codex only"); App saves that once the config is loaded. */
  onComplete: (outcome?: FirstRunOutcome) => void
  initialStep?: number
}

/** The first-run screen replaces the whole app, so its backdrop is the opaque
 *  app base rather than the usual scrim — there is nothing behind it to dim. */
const OPAQUE_BACKDROP: React.CSSProperties = { background: 'var(--surface-base)' }

/** The one thing the user has to run. Kept as a constant so the notice, the
 *  copy button and the test all speak about the same string. */
const INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code'

type CliProbe = { installed: boolean; path?: string; probe: string }

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
  const termContainerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const unsubDataRef = useRef<(() => void) | null>(null)
  const unsubExitRef = useRef<(() => void) | null>(null)

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
  const probeCli = useCallback(async () => {
    setProbing(true)
    try {
      const result = await window.electronAPI.setup.probeCli()
      setCliProbe(result)
    } catch (err) {
      setCliProbe({ installed: false, probe: err instanceof Error ? err.message : String(err) })
    } finally {
      setProbing(false)
    }
  }, [])

  useEffect(() => {
    if (step !== 2 || cliProbe) return
    void probeCli()
  }, [step, cliProbe, probeCli])

  // Terminal setup for step 2 — only once the CLI is known to be installed.
  useEffect(() => {
    if (step !== 2 || !cliProbe?.installed) return

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

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Subscribe to PTY channels BEFORE spawning to avoid missing early data
    const sessionId = '__cli_setup__'
    unsubDataRef.current = window.electronAPI.pty.onData(sessionId, (data) => {
      term.write(data)
    })
    unsubExitRef.current = window.electronAPI.pty.onExit(sessionId, () => {
      setPtyExited(true)
      term.write('\r\n\x1b[32mClaude CLI setup complete. Click Finish to continue.\x1b[0m\r\n')
    })
    // Forward terminal input to PTY
    term.onData((data) => {
      window.electronAPI.pty.write(sessionId, data)
    })

    // Handle resize — created early but observer attached once container is ready
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current) {
        try { fitAddonRef.current.fit() } catch { /* ignore */ }
      }
    })

    // Wait for container to have dimensions, then open terminal and spawn PTY
    const tryOpen = () => {
      const container = termContainerRef.current
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
        requestAnimationFrame(tryOpen)
        return
      }
      term.open(container)
      fitAddon.fit()
      resizeObserver.observe(container)
      // The terminal is what the user works in on this screen (its button
      // waits for it), so it takes the focus, not the page body.
      term.focus()

      // Spawn CLI setup PTY (listeners already subscribed above)
      const cols = term.cols
      const rows = term.rows
      window.electronAPI.setup.spawnCliSetup(cols, rows).then((started) => {
        // Main refuses this Claude Code terminal while Claude Code is off:
        // said here, and Skip for now goes on without it.
        const refusal = launchRefusalOf(started)
        if (refusal) { term.writeln(refusal.message); return }
        setPtySpawned(true)
      })
    }
    requestAnimationFrame(tryOpen)

    return () => {
      resizeObserver.disconnect()
      unsubDataRef.current?.()
      unsubExitRef.current?.()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [step, cliProbe?.installed])

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
  // user has no way to diagnose. The ways out are: install it and Retry, go
  // Back and quit, or (WP2) "Use Codex only", which turns Claude Code off
  // rather than pretending it is there.
  //
  // Each screen's primary button takes focus when the screen opens, rather
  // than leaving it on the page body: Continue by autoFocus, Retry when the
  // check that opens this screen ends (above). The screens are keyed so each
  // is mounted afresh: they share their frame, and without a key React would
  // reuse one screen's footer button for the next (Retry, say, becoming step
  // 1's Continue after Back) and autoFocus would not run again.
  if (step === 2 && cliProbe && !cliProbe.installed) {
    return (
      <DialogOverlay key="setup-cli-missing" style={OPAQUE_BACKDROP}>
        <DialogPanel width="w-[672px]" labelledBy="setup-cli-missing-title" panelRef={missingPanelRef}>
          <DialogBody className="space-y-4">
            <SetupHero
              titleId="setup-cli-missing-title"
              mark="!"
              title="Claude Code is not installed"
              subtitle="AI Code Conductor runs the Claude Code CLI; it cannot set up, or run a Claude session, without it."
            />

            <DialogCallout
              tone="danger"
              role="alert"
              title="Claude Code setup cannot continue"
              testId="setup-cli-missing"
            >
              <p>
                The <code style={{ color: 'var(--text-primary)' }}>claude</code> command was not found on this
                PC. Every Claude session AI Code Conductor launches is a Claude Code process, so there is nothing
                to configure for it until it is installed.
              </p>
            </DialogCallout>

            <div>
              <p className="text-xs mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Install it with Node.js 18 or newer, in a terminal:
              </p>
              <div className="flex gap-2">
                <code
                  className="flex-1 px-3 py-2 rounded-lg border font-mono text-xs select-all"
                  style={{ background: 'var(--surface-stage)', borderColor: 'var(--border-subtle)', color: 'var(--brand)' }}
                  data-testid="setup-cli-install-command"
                >
                  {INSTALL_COMMAND}
                </code>
                <DialogButton
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(INSTALL_COMMAND).then(() => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }).catch(() => { /* clipboard blocked — the text is select-all anyway */ })
                  }}
                  className="shrink-0"
                  style={{ height: 'auto', alignSelf: 'stretch' }}
                  testId="setup-cli-copy"
                >
                  {copied ? 'Copied' : 'Copy'}
                </DialogButton>
              </div>
              <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
                Then come back and press Retry. If you installed it in a terminal that was already open, the new{' '}
                <code>PATH</code> may not have reached this app — restart AI Code Conductor and it will pick it up.
              </p>
            </div>

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
            <DialogButton
              variant="primary"
              size="md"
              onClick={() => { void probeCli() }}
              disabled={probing}
              testId="setup-cli-retry"
            >
              {probing ? 'Checking…' : 'Retry'}
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

          <DialogFooter
            left={
              /* Held back until the CLI is confirmed: while the probe is still
                 out, Skip would be a way past a gate that has not decided yet. */
              cliProbe?.installed ? (
                <button
                  onClick={handleSkip}
                  className="text-xs underline transition-colors hover:text-[var(--text-secondary)]"
                  style={{ color: 'var(--text-muted)' }}
                  data-testid="setup-cli-skip"
                >
                  Skip for now
                </button>
              ) : undefined
            }
          >
            {/* The old green / purple fills each carried a `text-base` class
                meaning "dark text on the fill" — but that name is a FONT SIZE in
                Tailwind, so the label just inherited its colour and sat
                unreadable on the fill. --text-on-brand (what DialogButton's
                primary variant sets) is the colour that was intended. */}
            <DialogButton
              variant="primary"
              size="md"
              onClick={handleFinish}
              disabled={!ptySpawned || !cliProbe?.installed}
              style={ptyExited ? { background: 'var(--status-success)' } : undefined}
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
          {/* Was a purple fill with the same font-size-not-a-colour trap as
              step 2's Finish button. */}
          <DialogButton variant="primary" size="md" onClick={handleContinue} autoFocus testId="setup-continue">
            Continue
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
