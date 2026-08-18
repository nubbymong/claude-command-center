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

// SSH tmux enhancement (item 9): a distinct badge for a PERSISTENT SSH session
// (running inside a tmux wrapper that survives a dropped connection), so
// persistent vs. plain SSH is legible at a glance in the list. The chain-link
// glyph reads as "stays connected"; the green tint matches the header
// persistence indicator.
export function SshPersistentBadge() {
  return (
    <div
      className="flex items-center justify-center h-4 px-1 gap-0.5 rounded shrink-0 bg-green/15 text-green"
      title="Persistent SSH session — kept alive in tmux; a dropped connection reattaches"
      style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.5px' }}
      data-testid="ssh-persistent-badge"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
      SSH
    </div>
  )
}

export function CodexBadge({ needsAttention }: { needsAttention: boolean }) {
  const isWorking = !needsAttention
  return (
    <div
      className={`flex items-center justify-center w-4 h-4 rounded shrink-0 transition-colors ${
        isWorking ? 'bg-green/20 text-green' : 'bg-blue/20 text-blue'
      }`}
      title={isWorking ? 'Codex is working' : 'Waiting for input'}
    >
      {/*
        OpenAI-style mark: rounded lobed outline with a centred plus
        cross, drawn into the same 10x10 viewBox the ClaudeBadge uses
        so layout stays identical. (Not the literal six-arc OpenAI
        rosette -- a simplified glyph that still reads as "OpenAI" at
        the 10px sidebar size where the rosette's detail would mush.)
      */}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 2C9 2 6.5 4 6 7c-2.5 1-4 3.5-4 6.5C2 17 5 20 8.5 20c1.5 0 3-.5 4-1.5 1 1 2.5 1.5 4 1.5 3.5 0 6.5-3 6.5-6.5 0-3-1.5-5.5-4-6.5C18.5 4 15.5 2 12 2z" />
        <path d="M12 8v8M8 12h8" />
      </svg>
    </div>
  )
}
