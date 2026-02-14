import React, { useState, useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'

declare const __BUILD_TIME__: string
declare const __APP_VERSION__: string

export default function StatusBar() {
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessions = sessions.filter((s) => s.status === 'working' || s.status === 'idle')
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null)
  const [showCliHelp, setShowCliHelp] = useState(false)

  useEffect(() => {
    window.electronAPI.cli.check().then(setCliAvailable)
    const interval = setInterval(() => {
      window.electronAPI.cli.check().then(setCliAvailable)
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  const handleCliClick = () => {
    if (cliAvailable === false) {
      setShowCliHelp(true)
    }
  }

  return (
    <>
      <div className="h-6 bg-crust border-t border-surface0 flex items-center px-3 text-xs text-overlay1 shrink-0 gap-4">
        <span>Sessions: {activeSessions.length}/{sessions.length}</span>
        <div
          className={`flex items-center gap-1.5 ${cliAvailable === false ? 'cursor-pointer hover:text-text' : ''}`}
          title={cliAvailable ? 'Claude CLI available' : cliAvailable === false ? 'Claude CLI not found — click for help' : 'Checking CLI...'}
          onClick={handleCliClick}
        >
          <div className={`w-1.5 h-1.5 rounded-full ${
            cliAvailable === null ? 'bg-overlay0' : cliAvailable ? 'bg-green' : 'bg-red'
          }`} />
          <span className={cliAvailable === false ? 'text-red' : ''}>CLI</span>
        </div>
        <div className="flex-1" />
        <span title={`Built: ${__BUILD_TIME__}`}>v{__APP_VERSION__}</span>
      </div>

      {showCliHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowCliHelp(false)}>
          <div
            className="bg-mantle border border-surface0 rounded-lg shadow-xl p-5 w-[480px] max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-text mb-3">Claude CLI Not Found</h2>
            <p className="text-sm text-subtext0 mb-4">
              Claude Conductor requires Claude Code CLI to be installed and on your PATH.
            </p>

            <div className="space-y-3 text-sm">
              <div className="bg-surface0 rounded p-3">
                <div className="text-text font-medium mb-1">Option 1: Native Installer (Recommended)</div>
                <p className="text-subtext0 mb-2">Run this in any terminal:</p>
                <code className="block bg-base rounded px-2 py-1 text-blue font-mono text-xs select-all">
                  claude install
                </code>
                <p className="text-overlay0 text-xs mt-1">
                  Installs to ~/.local/bin/claude.exe
                </p>
              </div>

              <div className="bg-surface0 rounded p-3">
                <div className="text-text font-medium mb-1">Option 2: npm</div>
                <code className="block bg-base rounded px-2 py-1 text-blue font-mono text-xs select-all">
                  npm install -g @anthropic-ai/claude-code
                </code>
              </div>

              <div className="bg-surface0 rounded p-3">
                <div className="text-text font-medium mb-1">Already installed?</div>
                <p className="text-subtext0">
                  Make sure the claude binary is on your system PATH. For the native installer,
                  add <code className="text-blue">%USERPROFILE%\.local\bin</code> to your PATH environment variable.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => {
                  setShowCliHelp(false)
                  window.electronAPI.cli.check().then(setCliAvailable)
                }}
                className="px-3 py-1.5 text-sm bg-blue text-crust rounded hover:bg-blue/80"
              >
                Re-check
              </button>
              <button
                onClick={() => setShowCliHelp(false)}
                className="px-3 py-1.5 text-sm text-overlay1 hover:text-text rounded hover:bg-surface0"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
