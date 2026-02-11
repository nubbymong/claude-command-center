import React, { useState, useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'

declare const __BUILD_TIME__: string
declare const __APP_VERSION__: string

export default function StatusBar() {
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessions = sessions.filter((s) => s.status === 'working' || s.status === 'idle')
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    window.electronAPI.cli.check().then(setCliAvailable)
    // Re-check every 30 seconds
    const interval = setInterval(() => {
      window.electronAPI.cli.check().then(setCliAvailable)
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="h-6 bg-crust border-t border-surface0 flex items-center px-3 text-xs text-overlay1 shrink-0 gap-4">
      <span>Sessions: {activeSessions.length}/{sessions.length}</span>
      <div className="flex items-center gap-1.5" title={cliAvailable ? 'Claude CLI available' : cliAvailable === false ? 'Claude CLI not found' : 'Checking CLI...'}>
        <div className={`w-1.5 h-1.5 rounded-full ${
          cliAvailable === null ? 'bg-overlay0' : cliAvailable ? 'bg-green' : 'bg-red'
        }`} />
        <span className={cliAvailable === false ? 'text-red' : ''}>CLI</span>
      </div>
      <div className="flex-1" />
      <span title={`Built: ${__BUILD_TIME__}`}>v{__APP_VERSION__}</span>
    </div>
  )
}
