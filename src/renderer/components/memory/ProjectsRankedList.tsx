import React, { useMemo, useState } from 'react'
import type { MemoryProject } from '../../../shared/types'
import { fmt, fmtRel, staleClass, staleShadow } from './memory-ui'

interface Props {
  projects: MemoryProject[]                 // already scope-filtered by the page
  liveCounts: Record<string, number>        // projectDir -> live session count
  onSelect: (projectDir: string) => void
}

export function ProjectsRankedList({ projects, liveCounts, onSelect }: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const sorted = useMemo(
    () => [...projects].sort((a, b) => b.fileCount - a.fileCount),
    [projects],
  )

  const maxCount = useMemo(
    () => Math.max(...sorted.map((p) => p.fileCount), 1),
    [sorted],
  )

  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-3">
        Projects — by memory count
      </div>

      {sorted.length === 0 ? (
        <div className="text-xs text-overlay0 py-8 text-center">
          No projects match this filter
        </div>
      ) : (
        <div className="space-y-2.5">
          {sorted.map((p) => {
            const pct = maxCount > 0 ? (p.fileCount / maxCount) * 100 : 0
            const liveCount = liveCounts[p.projectDir] ?? 0
            const isHovered = hoveredId === p.projectDir

            return (
              <div
                key={p.projectDir}
                className="cursor-pointer group"
                onClick={() => onSelect(p.projectDir)}
                onMouseEnter={() => setHoveredId(p.projectDir)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.8fr)_auto_auto_auto] items-center gap-3">
                  {/* 1. Name */}
                  <span
                    className="text-xs font-medium truncate"
                    style={{
                      color: isHovered ? 'var(--accent)' : 'var(--text-primary)',
                    }}
                    title={p.name}
                  >
                    {p.name}
                  </span>

                  {/* 2. Bar + count */}
                  <div className="flex items-center gap-2">
                    <div
                      className="flex-1 h-1.5 rounded-sm overflow-hidden"
                      style={{ background: 'var(--surface-stage)' }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          background: 'var(--accent)',
                          height: '100%',
                        }}
                      />
                    </div>
                    <span
                      className="text-[11px] font-mono"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {p.fileCount}
                    </span>
                  </div>

                  {/* 3. Size */}
                  <span className="text-[10px] font-mono text-overlay0">
                    {fmt(p.totalSize)}
                  </span>

                  {/* 4. Staleness */}
                  <div className="flex items-center gap-1 text-[10px] text-overlay0">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${staleClass(p.lastModified)}`}
                      style={{ boxShadow: staleShadow(p.lastModified) }}
                    />
                    {fmtRel(p.lastModified)}
                    {p.memoryMdLines != null && p.memoryMdLines > 200 && (
                      <span
                        title="MEMORY.md over the 200-line load limit"
                        style={{ color: 'var(--status-warning)' }}
                      >
                        {String.fromCodePoint(0x26a0)} index {p.memoryMdLines} !
                      </span>
                    )}
                  </div>

                  {/* 5. Live chip */}
                  {liveCount > 0 ? (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
                      style={{
                        background: 'color-mix(in srgb, var(--status-success) 18%, transparent)',
                        color: 'var(--status-success)',
                      }}
                      title={`${liveCount} session${liveCount === 1 ? '' : 's'} running in this project`}
                    >
                      {String.fromCodePoint(0x25cf)} {liveCount}
                    </span>
                  ) : (
                    <span />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
