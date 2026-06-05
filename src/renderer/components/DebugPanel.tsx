import React, { useEffect, useRef, useState } from 'react'

interface DebugEntry {
  id: number
  timestamp: number
  type: string
  summary: string
  detail: string
}

let entryId = 0

export default function DebugPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<DebugEntry[]>([])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)

  // Escape to close
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [visible, onClose])

  useEffect(() => {
    const unsub = window.electronAPI.debug.onDebug((data: any) => {
      const entry: DebugEntry = {
        id: ++entryId,
        timestamp: data.timestamp || Date.now(),
        type: data.stderr ? 'STDERR' : data.event?.type || 'unknown',
        summary: data.stderr
          ? data.stderr.slice(0, 200)
          : `${data.event?.type || '?'}${data.event?.subtype ? '/' + data.event.subtype : ''}`,
        detail: JSON.stringify(data.event || data, null, 2)
      }
      setEntries(prev => {
        const next = [...prev, entry]
        return next.length > 300 ? next.slice(-300) : next
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [entries])

  if (!visible) return null

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
  }

  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: '40vh',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--surface-panel)',
        borderTop: '2px solid var(--border-strong)',
        fontFamily: 'Consolas, monospace',
        fontSize: '12px',
        color: 'var(--text-primary)'
      }}
    >
      {/* Header bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '4px 12px',
        backgroundColor: 'var(--surface-chrome)',
        borderBottom: '1px solid var(--border-subtle)',
        flexShrink: 0
      }}>
        <span style={{ fontWeight: 'bold', color: 'var(--chart-other)' }}>DEBUG</span>
        <span style={{ color: 'var(--text-muted)' }}>{entries.length} events</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setEntries([])}
          style={{
            background: 'none',
            border: '1px solid var(--border-strong)',
            color: 'var(--text-secondary)',
            padding: '2px 8px',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '11px'
          }}
        >
          Clear
        </button>
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
          style={{
            background: 'var(--status-danger)',
            border: 'none',
            color: 'var(--surface-chrome)',
            padding: '2px 12px',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '11px',
            fontWeight: 'bold'
          }}
        >
          X Close
        </button>
      </div>

      {/* Events */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '0' }}>
        {entries.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px' }}>
            No events yet. Send a chat message to see IPC events here.
          </div>
        )}
        {entries.map(entry => (
          <div key={entry.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div
              onClick={() => toggle(entry.id)}
              style={{
                padding: '3px 12px',
                cursor: 'pointer',
                display: 'flex',
                gap: '12px',
                alignItems: 'center'
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--surface-overlay)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              <span style={{ color: 'var(--text-muted)', width: '80px', flexShrink: 0 }}>
                {formatTime(entry.timestamp)}
              </span>
              <span style={{
                width: '80px',
                flexShrink: 0,
                fontWeight: 'bold',
                color: entry.type === 'STDERR' ? 'var(--status-danger)'
                  : entry.type === 'assistant' ? 'var(--status-success)'
                  : entry.type === 'result' ? 'var(--status-info)'
                  : entry.type === 'system' ? 'var(--chart-other)'
                  : 'var(--status-warning)'
              }}>
                {entry.type}
              </span>
              <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.summary}
              </span>
            </div>
            {expanded.has(entry.id) && (
              <pre style={{
                margin: 0,
                padding: '8px 12px 8px 104px',
                backgroundColor: 'var(--surface-sunken)',
                color: 'var(--text-secondary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: '200px',
                overflow: 'auto'
              }}>
                {entry.detail}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
