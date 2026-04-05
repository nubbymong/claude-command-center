import React, { useState, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

const THEME = {
  background: '#0f1218',
  foreground: '#f0f4fc',
  cursor: '#f0f4fc',
  cursorAccent: '#0f1218',
  selectionBackground: '#1e2530',
  selectionForeground: '#f0f4fc',
  black: '#1e2530',
  red: '#F38BA8',
  green: '#A6E3A1',
  yellow: '#F9E2AF',
  blue: '#89B4FA',
  magenta: '#CBA6F7',
  cyan: '#94E2D5',
  white: '#b8c5d6',
  brightBlack: '#2a3342',
  brightRed: '#F38BA8',
  brightGreen: '#A6E3A1',
  brightYellow: '#F9E2AF',
  brightBlue: '#89B4FA',
  brightMagenta: '#CBA6F7',
  brightCyan: '#94E2D5',
  brightWhite: '#94a3b8',
}

interface Props {
  onComplete: () => void
  initialStep?: number
}

export default function SetupDialog({ onComplete, initialStep }: Props) {
  const [step, setStep] = useState(initialStep || 1)
  const [dataDir, setDataDir] = useState('')
  const [resourcesDir, setResourcesDir] = useState('')
  const [loading, setLoading] = useState(true)
  const [ptyExited, setPtyExited] = useState(false)
  const [ptySpawned, setPtySpawned] = useState(false)
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

  // Terminal setup for step 2
  useEffect(() => {
    if (step !== 2) return

    const term = new Terminal({
      theme: THEME,
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

      // Spawn CLI setup PTY (listeners already subscribed above)
      const cols = term.cols
      const rows = term.rows
      window.electronAPI.setup.spawnCliSetup(cols, rows).then(() => {
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
  }, [step])

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

  if (loading) {
    return (
      <div className="fixed inset-0 bg-base flex items-center justify-center z-50">
        <div className="text-overlay1">Loading...</div>
      </div>
    )
  }

  // Step 2: Claude CLI Setup
  if (step === 2) {
    return (
      <div className="fixed inset-0 bg-base flex items-center justify-center z-50">
        <div className="bg-surface0 rounded-lg p-8 max-w-2xl w-full mx-4 shadow-2xl">
          <div className="text-center mb-4">
            <div className="text-3xl mb-2 font-mono text-blue">&gt;_</div>
            <h1 className="text-xl font-bold text-text mb-1">Claude CLI Setup</h1>
            <p className="text-sm text-overlay1">
              Claude needs to trust this directory and authenticate.
              Complete the prompts below, then type <code className="text-blue">/exit</code> when done.
            </p>
          </div>

          <div
            ref={termContainerRef}
            className="rounded-lg overflow-hidden border border-surface2"
            style={{ height: '400px', backgroundColor: '#0f1218' }}
          />

          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={handleSkip}
              className="text-xs text-overlay0 hover:text-overlay1 transition-colors underline"
            >
              Skip for now
            </button>
            <button
              onClick={handleFinish}
              disabled={!ptySpawned}
              className={`px-6 py-2 font-medium rounded transition-colors ${
                ptyExited
                  ? 'bg-green hover:bg-green/90 text-base'
                  : 'bg-mauve hover:bg-pink text-base'
              }`}
            >
              {ptyExited ? 'Finish' : 'Finish (skip remaining)'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Step 1: Directory selection
  return (
    <div className="fixed inset-0 bg-base flex items-center justify-center z-50">
      <div className="bg-surface0 rounded-lg p-8 max-w-xl w-full mx-4 shadow-2xl">
        <div className="text-center mb-6">
          <div className="text-4xl mb-3 font-mono text-mauve">&gt;_</div>
          <h1 className="text-2xl font-bold text-text mb-2">Welcome to Claude Command Center</h1>
          <p className="text-overlay1">Configure your storage directories</p>
        </div>

        <div className="space-y-5">
          {/* Data Directory */}
          <div>
            <label className="block text-sm font-medium text-subtext1 mb-1">
              Data Directory
            </label>
            <p className="text-xs text-overlay0 mb-2">
              Internal app data: session configs, logs, debug captures
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={dataDir}
                onChange={(e) => setDataDir(e.target.value)}
                className="flex-1 px-3 py-2 bg-surface1 border border-surface2 rounded text-text text-sm focus:outline-none focus:border-mauve"
              />
              <button
                onClick={handleBrowseData}
                className="px-4 py-2 bg-surface1 hover:bg-surface2 text-text rounded transition-colors"
              >
                Browse
              </button>
            </div>
          </div>

          {/* Resources Directory */}
          <div>
            <label className="block text-sm font-medium text-subtext1 mb-1">
              Resources Directory
            </label>
            <p className="text-xs text-overlay0 mb-2">
              Shared resources: insights, screenshots, skills, scripts
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={resourcesDir}
                onChange={(e) => setResourcesDir(e.target.value)}
                className="flex-1 px-3 py-2 bg-surface1 border border-surface2 rounded text-text text-sm focus:outline-none focus:border-mauve"
              />
              <button
                onClick={handleBrowseResources}
                className="px-4 py-2 bg-surface1 hover:bg-surface2 text-text rounded transition-colors"
              >
                Browse
              </button>
            </div>
            <p className="text-[11px] text-blue/70 mt-1.5">
              Tip: Use a network-mountable path to share resources across SSH sessions
            </p>
          </div>

          <div className="text-xs text-overlay0 bg-mantle p-3 rounded">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="font-medium text-subtext0 mb-1">Data contains:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Session configs</li>
                  <li>Terminal logs</li>
                  <li>Debug data</li>
                </ul>
              </div>
              <div>
                <p className="font-medium text-subtext0 mb-1">Resources contains:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Insights reports</li>
                  <li>Screenshots</li>
                  <li>Skills &amp; Scripts</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={handleContinue}
            className="px-6 py-2 bg-mauve hover:bg-pink text-base font-medium rounded transition-colors"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
