import React, { useEffect, useState, useRef } from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import type { PaneComponentProps } from './PaneRegistry'
import type { DiffFile, DiffLine } from '../../../shared/types'

// Catppuccin Mocha diff colors
const DIFF_COLORS = {
  addition: { bg: 'rgba(166, 227, 161, 0.1)', text: '#a6e3a1' },
  removal: { bg: 'rgba(243, 139, 168, 0.1)', text: '#f38ba8' },
  context: { bg: 'transparent', text: '#a6adc8' },
  hunkHeader: '#585b70',
}

function DiffLineView({ line }: { line: DiffLine }) {
  const colors = DIFF_COLORS[line.type]
  const prefix = line.type === 'addition' ? '+' : line.type === 'removal' ? '-' : ' '

  return (
    <div
      className="flex font-mono text-xs leading-5 hover:brightness-125"
      style={{ backgroundColor: colors.bg }}
    >
      <span className="w-10 text-right pr-2 text-overlay0 select-none shrink-0 opacity-60">
        {line.oldLineNumber ?? ''}
      </span>
      <span className="w-10 text-right pr-2 text-overlay0 select-none shrink-0 opacity-60">
        {line.newLineNumber ?? ''}
      </span>
      <span className="w-4 text-center select-none shrink-0" style={{ color: colors.text }}>
        {prefix}
      </span>
      <span className="flex-1 whitespace-pre" style={{ color: colors.text }}>
        {line.content}
      </span>
    </div>
  )
}

function FileListItem({
  file,
  isActive,
  onClick,
}: {
  file: DiffFile
  isActive: boolean
  onClick: () => void
}) {
  const statusColors: Record<string, string> = {
    added: '#a6e3a1',
    modified: '#f9e2af',
    deleted: '#f38ba8',
    renamed: '#89b4fa',
  }
  const statusIcons: Record<string, string> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
  }

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2 py-1 text-xs flex items-center gap-1.5 rounded transition-colors ${
        isActive ? 'bg-surface1 text-text' : 'text-subtext0 hover:bg-surface0 hover:text-text'
      }`}
    >
      <span
        className="w-4 text-center font-mono text-xs font-bold shrink-0"
        style={{ color: statusColors[file.status] || '#6c7086' }}
      >
        {statusIcons[file.status] || '?'}
      </span>
      <span className="truncate flex-1">{file.path.split('/').pop()}</span>
      {file.linesAdded > 0 && (
        <span className="text-green text-xs shrink-0">+{file.linesAdded}</span>
      )}
      {file.linesRemoved > 0 && (
        <span className="text-red text-xs shrink-0">-{file.linesRemoved}</span>
      )}
    </button>
  )
}

export default function DiffViewerPane({ paneId, paneType, sessionId, isActive, props }: PaneComponentProps) {
  const [diffs, setDiffs] = useState<DiffFile[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const subscribedRef = useRef(false)

  // Subscribe to diff updates
  useEffect(() => {
    if (!session?.workingDirectory) return

    const cwd = session.workingDirectory

    // Subscribe to file watcher
    if (!subscribedRef.current) {
      subscribedRef.current = true
      window.electronAPI.diff.subscribe(sessionId, cwd).then(() => {
        setIsLoading(false)
      }).catch(() => setIsLoading(false))
    }

    // Listen for diff updates
    const unsub = window.electronAPI.diff.onUpdate((updatedSessionId, updatedDiffs) => {
      if (updatedSessionId === sessionId) {
        setDiffs(updatedDiffs)
        setIsLoading(false)
      }
    })

    return () => {
      unsub()
      window.electronAPI.diff.unsubscribe(sessionId)
      subscribedRef.current = false
    }
  }, [sessionId, session?.workingDirectory])

  // Auto-select first file
  useEffect(() => {
    if (diffs.length > 0 && !activeFile) {
      setActiveFile(diffs[0].path)
    }
  }, [diffs, activeFile])

  const activeDiff = diffs.find((d) => d.path === activeFile)
  const totalAdded = diffs.reduce((sum, d) => sum + d.linesAdded, 0)
  const totalRemoved = diffs.reduce((sum, d) => sum + d.linesRemoved, 0)

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-overlay0 text-sm">
        No session found
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-overlay0 text-sm">
        Loading diffs...
      </div>
    )
  }

  if (diffs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-overlay0 text-sm">
        <div className="text-center">
          <div className="text-2xl mb-2 opacity-40">{String.fromCodePoint(0x2713)}</div>
          <div>No uncommitted changes</div>
          <div className="text-xs text-overlay0 mt-1">Changes will appear here when Claude edits files</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* File list sidebar */}
      <div className="w-[180px] shrink-0 border-r border-surface0 bg-mantle overflow-y-auto p-1.5">
        <div className="text-xs text-overlay0 px-2 py-1 mb-1 flex justify-between">
          <span>{diffs.length} file{diffs.length !== 1 ? 's' : ''}</span>
          <span>
            <span className="text-green">+{totalAdded}</span>
            {' '}
            <span className="text-red">-{totalRemoved}</span>
          </span>
        </div>
        {diffs.map((file) => (
          <FileListItem
            key={file.path}
            file={file}
            isActive={file.path === activeFile}
            onClick={() => setActiveFile(file.path)}
          />
        ))}
      </div>

      {/* Diff content */}
      <div className="flex-1 overflow-auto bg-base">
        {activeDiff ? (
          <div>
            {/* File header */}
            <div className="sticky top-0 bg-mantle px-3 py-1.5 border-b border-surface0 text-xs flex items-center justify-between z-10">
              <span className="text-text font-medium">{activeDiff.path}</span>
              <span>
                <span className="text-green">+{activeDiff.linesAdded}</span>
                {' '}
                <span className="text-red">-{activeDiff.linesRemoved}</span>
              </span>
            </div>

            {activeDiff.isBinary ? (
              <div className="flex items-center justify-center h-32 text-overlay0 text-sm">
                Binary file -- cannot display diff
              </div>
            ) : (
              activeDiff.hunks.map((hunk, hunkIdx) => (
                <div key={hunkIdx}>
                  <div
                    className="px-3 py-0.5 font-mono text-xs"
                    style={{ color: DIFF_COLORS.hunkHeader }}
                  >
                    {hunk.header}
                  </div>
                  {hunk.lines.map((line, lineIdx) => (
                    <DiffLineView key={`${hunkIdx}-${lineIdx}`} line={line} />
                  ))}
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-overlay0 text-sm">
            Select a file to view diff
          </div>
        )}
      </div>
    </div>
  )
}
