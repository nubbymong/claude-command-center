import React, { useEffect, useState, useCallback } from 'react'
import type { ConversationSummary } from '../../shared/types'

interface Props {
  workingDirectory: string
  sessionLabel: string
  onResume: (sessionId: string) => void
  onNewConversation: () => void
}

function ConversationRow({
  conversation,
  index,
  onSelect,
}: {
  conversation: ConversationSummary
  index: number
  onSelect: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  // Show first 3 recent messages by default, all 5 when expanded
  const previewMessages = expanded
    ? conversation.lastMessages
    : conversation.lastMessages.slice(-3)
  const hasMore = conversation.lastMessages.length > 3

  const truncate = (str: string, maxLen: number) => {
    if (str.length <= maxLen) return str
    return str.slice(0, maxLen - 1) + '\u2026'
  }

  return (
    <button
      onClick={onSelect}
      className="w-full text-left rounded-lg transition-all duration-150 outline-none"
      style={{
        padding: '14px 16px',
        background: 'var(--color-bg-input)',
        border: '1px solid var(--color-border)',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border-hover)'
        e.currentTarget.style.background = 'var(--color-bg-active)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border)'
        e.currentTarget.style.background = 'var(--color-bg-input)'
      }}
    >
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ color: 'var(--color-green)', fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
          {index + 1}
        </span>
        <span style={{ color: 'var(--color-text)', fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {truncate(conversation.firstMessage, 80)}
        </span>
      </div>

      {/* KPI row */}
      <div style={{ display: 'flex', gap: 16, paddingLeft: 22, marginBottom: previewMessages.length > 0 ? 8 : 0 }}>
        <span style={{ color: 'var(--color-overlay1)', fontSize: 11 }}>{conversation.timeAgo}</span>
        <span style={{ color: 'var(--color-overlay1)', fontSize: 11 }}>{conversation.size}</span>
        {conversation.model && (
          <span style={{ color: 'var(--color-blue)', fontSize: 11 }}>{conversation.model.replace('claude-', '')}</span>
        )}
        <span style={{ color: 'var(--color-overlay0)', fontSize: 10, fontFamily: 'monospace' }}>{conversation.sessionId.slice(0, 8)}</span>
      </div>

      {/* Recent message previews */}
      {previewMessages.length > 0 && (
        <div style={{ paddingLeft: 22, borderTop: '1px solid var(--color-border)', paddingTop: 6, marginTop: 2 }}>
          {previewMessages.map((msg, i) => (
            <div key={i} style={{ color: 'var(--color-subtext0)', fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '18px' }}>
              {'> '}{truncate(msg, 90)}
            </div>
          ))}
          {hasMore && !expanded && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); setExpanded(true) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setExpanded(true) } }}
              style={{ color: 'var(--color-overlay0)', fontSize: 11, cursor: 'pointer', marginTop: 2, display: 'inline-block' }}
            >
              +{conversation.lastMessages.length - 3} more
            </span>
          )}
        </div>
      )}
    </button>
  )
}

export default function ResumePicker({
  workingDirectory,
  sessionLabel,
  onResume,
  onNewConversation,
}: Props) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        setError(null)
        const api = (window as any).electronAPI
        const result: ConversationSummary[] = await api.resumePicker.list(workingDirectory)
        if (!cancelled) {
          setConversations(result)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load conversations')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [workingDirectory])

  // Keyboard: number keys to select, 'n' for new
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'n' || e.key === 'N') {
        onNewConversation()
        return
      }
      const num = parseInt(e.key, 10)
      if (num >= 1 && num <= Math.min(9, conversations.length)) {
        onResume(conversations[num - 1].sessionId)
      }
    },
    [conversations, onResume, onNewConversation]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // Truncate the path for display
  const displayPath =
    workingDirectory.length > 60
      ? '\u2026' + workingDirectory.slice(-59)
      : workingDirectory

  return (
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-base)',
        color: 'var(--color-text)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ padding: '32px 32px 20px', flexShrink: 0 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 600,
            color: 'var(--color-text)',
          }}
        >
          Resume Conversation
        </h2>
        <div
          style={{
            marginTop: 6,
            fontSize: 13,
            color: 'var(--color-overlay1)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
          title={workingDirectory}
        >
          <span>{sessionLabel}</span>
          <span style={{ color: 'var(--color-overlay0)' }}>{'\u00B7'}</span>
          <span style={{ color: 'var(--color-overlay0)', fontSize: 12 }}>{displayPath}</span>
          <span style={{ color: 'var(--color-overlay0)' }}>{'\u00B7'}</span>
          <span style={{ color: 'var(--color-overlay0)', fontSize: 12 }}>{conversations.length} conversation{conversations.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0 32px 32px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {loading && (
          <div
            style={{
              padding: 32,
              textAlign: 'center',
              color: 'var(--color-subtext0)',
              fontSize: 13,
            }}
          >
            Scanning conversations...
          </div>
        )}

        {error && (
          <div
            style={{
              padding: 32,
              textAlign: 'center',
              color: 'var(--color-red)',
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {!loading && !error && conversations.length === 0 && (
          <div
            style={{
              padding: 32,
              textAlign: 'center',
              color: 'var(--color-subtext0)',
              fontSize: 13,
            }}
          >
            <div style={{ marginBottom: 8 }}>No previous conversations found.</div>
            <div style={{ fontSize: 12, color: 'var(--color-overlay0)' }}>
              Start a new conversation to get going.
            </div>
          </div>
        )}

        {!loading &&
          !error &&
          conversations.map((conv, i) => (
            <ConversationRow
              key={conv.sessionId}
              conversation={conv}
              index={i}
              onSelect={() => onResume(conv.sessionId)}
            />
          ))}
      </div>

      {/* Footer: New conversation button */}
      <div
        style={{
          padding: '12px 24px 20px',
          flexShrink: 0,
          borderTop: '1px solid var(--color-border)',
        }}
      >
        <button
          onClick={onNewConversation}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            width: '100%',
            padding: '10px 16px',
            borderRadius: 8,
            border: '1px solid var(--color-border)',
            background: 'var(--color-surface0)',
            color: 'var(--color-text)',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 150ms ease',
            outline: 'none',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--color-surface1)'
            e.currentTarget.style.borderColor = 'var(--color-border-hover)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--color-surface0)'
            e.currentTarget.style.borderColor = 'var(--color-border)'
          }}
          onFocus={(e) => {
            e.currentTarget.style.background = 'var(--color-surface1)'
            e.currentTarget.style.borderColor = 'var(--color-border-hover)'
          }}
          onBlur={(e) => {
            e.currentTarget.style.background = 'var(--color-surface0)'
            e.currentTarget.style.borderColor = 'var(--color-border)'
          }}
        >
          <span style={{ color: 'var(--color-green)', fontWeight: 600 }}>+</span>
          New conversation
          <span style={{ color: 'var(--color-overlay0)', fontSize: 11, marginLeft: 4 }}>
            (n)
          </span>
        </button>
      </div>
    </div>
  )
}
