import React, { useState, useMemo } from 'react'

interface StoryboardFrame {
  path: string
  included: boolean
  annotation: string
}

interface Props {
  frames: string[]
  sessionId: string
  sessionType: 'local' | 'ssh'
  onSend: (lines: string[]) => void
  onCancel: () => void
}

export default function StoryboardModal({ frames, sessionId, sessionType, onSend, onCancel }: Props) {
  const [context, setContext] = useState('')
  const [frameData, setFrameData] = useState<StoryboardFrame[]>(() =>
    frames.map((path) => ({ path, included: true, annotation: '' }))
  )

  const includedCount = useMemo(() => frameData.filter((f) => f.included).length, [frameData])

  const toggleFrame = (idx: number) => {
    setFrameData((prev) => {
      const next = [...prev]
      next[idx] = { ...next[idx], included: !next[idx].included }
      return next
    })
  }

  const setAnnotation = (idx: number, text: string) => {
    setFrameData((prev) => {
      const next = [...prev]
      next[idx] = { ...next[idx], annotation: text }
      return next
    })
  }

  const toggleAll = () => {
    const allIncluded = frameData.every((f) => f.included)
    setFrameData((prev) => prev.map((f) => ({ ...f, included: !allIncluded })))
  }

  const handleSend = () => {
    const included = frameData.filter((f) => f.included)
    if (included.length === 0) return

    // Use the conductor-vision MCP fetch_host_screenshot tool for both local
    // and SSH sessions — Claude calls the tool once per filename to view each
    // frame inline. SSH sessions reach the MCP via the existing reverse tunnel.
    const basename = (p: string): string => {
      const normalized = p.replace(/\\/g, '/')
      return normalized.split('/').pop() || p
    }

    const lines: string[] = []
    if (context.trim()) {
      lines.push(context.trim())
      lines.push('')
    }
    lines.push(`Please review the following ${included.length} storyboard frame(s) in order. For each frame, call mcp__conductor-vision__fetch_host_screenshot with the filename to load it.`)
    lines.push('')

    included.forEach((frame, i) => {
      const filename = basename(frame.path)
      const label = `Frame ${i + 1} of ${included.length}`
      if (frame.annotation.trim()) {
        lines.push(`${label}: ${frame.annotation.trim()}`)
      } else {
        lines.push(label)
      }
      lines.push(`filename: ${filename}`)
      lines.push('')
    })

    onSend(lines)
  }

  // Generate file:// URL for thumbnail display
  const toFileUrl = (path: string): string => {
    const normalized = path.replace(/\\/g, '/')
    return `file:///${normalized}`
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        className="bg-mantle border border-surface0 rounded-xl shadow-2xl flex flex-col"
        style={{ width: '90vw', maxWidth: '1100px', maxHeight: '85vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-surface0">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" className="text-mauve">
              <rect x="1" y="3" width="4" height="10" rx="0.5" />
              <rect x="6" y="3" width="4" height="10" rx="0.5" />
              <rect x="11" y="3" width="4" height="10" rx="0.5" />
            </svg>
            <span className="text-sm font-medium text-text">Storyboard</span>
            <span className="text-xs text-overlay0">
              {includedCount} of {frameData.length} frames selected
            </span>
          </div>
          <button
            onClick={onCancel}
            className="text-overlay0 hover:text-text transition-colors p-1"
            title="Cancel"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2" y1="2" x2="12" y2="12" />
              <line x1="12" y1="2" x2="2" y2="12" />
            </svg>
          </button>
        </div>

        {/* Context textarea */}
        <div className="px-5 pt-3 pb-2">
          <label className="text-xs text-subtext0 mb-1 block">Context / Question</label>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="Describe what you want Claude to analyze in these frames..."
            className="w-full h-16 px-3 py-2 bg-crust text-text text-xs rounded-lg border border-surface1 outline-none focus:border-blue resize-none"
          />
        </div>

        {/* Frame grid */}
        <div className="flex-1 overflow-y-auto px-5 py-2 min-h-0">
          <div className="flex items-center gap-2 mb-2">
            <button
              onClick={toggleAll}
              className="text-[10px] text-overlay0 hover:text-text transition-colors"
            >
              {frameData.every((f) => f.included) ? 'Deselect All' : 'Select All'}
            </button>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
            {frameData.map((frame, idx) => (
              <div
                key={idx}
                className={`rounded-lg border overflow-hidden transition-colors ${
                  frame.included
                    ? 'border-blue/40 bg-surface0/50'
                    : 'border-surface1/50 bg-surface0/20 opacity-50'
                }`}
              >
                {/* Thumbnail */}
                <div
                  className="relative w-full cursor-pointer group"
                  style={{ aspectRatio: '16/10' }}
                  onClick={() => toggleFrame(idx)}
                >
                  <img
                    src={toFileUrl(frame.path)}
                    alt={`Frame ${idx + 1}`}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                  {/* Overlay checkbox */}
                  <div className="absolute top-1.5 left-1.5">
                    <div
                      className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                        frame.included
                          ? 'bg-blue border-blue'
                          : 'bg-black/40 border-white/40 group-hover:border-white/60'
                      }`}
                    >
                      {frame.included && (
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="2,6 5,9 10,3" />
                        </svg>
                      )}
                    </div>
                  </div>
                  {/* Frame number */}
                  <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 bg-black/60 rounded text-[10px] text-white font-mono">
                    {idx + 1}
                  </div>
                </div>
                {/* Annotation */}
                <input
                  type="text"
                  value={frame.annotation}
                  onChange={(e) => setAnnotation(idx, e.target.value)}
                  placeholder="Annotation..."
                  className="w-full px-2 py-1 bg-crust text-text text-[11px] border-t border-surface1 outline-none focus:bg-base placeholder:text-overlay0/50"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Bottom bar */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-surface0">
          <span className="text-xs text-overlay0">
            {includedCount} frame{includedCount !== 1 ? 's' : ''} will be sent
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-1.5 text-xs text-subtext0 hover:text-text bg-surface0 hover:bg-surface1 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSend}
              disabled={includedCount === 0}
              className="px-4 py-1.5 text-xs text-crust bg-blue hover:bg-blue/80 rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Send to Claude
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
