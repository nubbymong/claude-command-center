import React from 'react'

export function ClaudeBadge({ needsAttention }: { needsAttention: boolean }) {
  const isWorking = !needsAttention
  return (
    <div
      className={`flex items-center justify-center w-4 h-4 rounded shrink-0 transition-colors ${
        isWorking ? 'bg-peach/20 text-peach' : 'bg-blue/20 text-blue'
      }`}
      title={isWorking ? 'Claude is working' : 'Waiting for input'}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2v8.5M12 13.5V22M2 12h8.5M13.5 12H22M4.93 4.93l6.01 6.01M13.06 13.06l6.01 6.01M19.07 4.93l-6.01 6.01M10.94 13.06l-6.01 6.01" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none"/>
      </svg>
    </div>
  )
}

export function ShellBadge() {
  return (
    <div
      className="flex items-center justify-center w-4 h-4 rounded shrink-0 bg-surface1 text-overlay1"
      title="Shell terminal"
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="7 8 3 12 7 16" />
        <polyline points="17 8 21 12 17 16" />
        <line x1="14" y1="4" x2="10" y2="20" />
      </svg>
    </div>
  )
}

export function SshBadge() {
  return (
    <div
      className="flex items-center justify-center h-4 px-1 rounded shrink-0 bg-blue/15 text-blue"
      title="SSH session"
      style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.5px' }}
    >
      SSH
    </div>
  )
}
