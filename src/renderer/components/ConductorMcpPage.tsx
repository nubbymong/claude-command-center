import React, { useEffect } from 'react'
import { useConductorMcpStore } from '../stores/conductorMcpStore'
import PageFrame from './PageFrame'
import CompatBadge from './sentinel/CompatBadge'
import VisionSubTool from './conductor-mcp/VisionSubTool'
import CodexReviewSubTool from './conductor-mcp/CodexReviewSubTool'
import HostTransferSubTool from './conductor-mcp/HostTransferSubTool'
import ProxySubTool from './conductor-mcp/ProxySubTool'

const headerIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </svg>
)

// Larger glyph for the designed empty / degraded state.
const offlineIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
    <line x1="3" y1="3" x2="21" y2="21" />
  </svg>
)

export default function ConductorMcpPage() {
  // Zustand selector form — each field subscribed independently so an
  // unrelated browser-status tick doesn't re-render the whole page.
  const serverRunning = useConductorMcpStore((s) => s.serverRunning)
  const mcpPort = useConductorMcpStore((s) => s.mcpPort)
  const fetchStatus = useConductorMcpStore((s) => s.fetchStatus)
  const loadConfig = useConductorMcpStore((s) => s.loadConfig)

  useEffect(() => {
    loadConfig()
    fetchStatus()
  }, [])

  // P7.7.19: serverRunning is derived from `mcpPort > 0` (see
  // conductorMcpStore P7.7.16 fix), so the `|| 'discovering'` fallback in
  // the running branch is unreachable; dropped. Pre-fetch indeterminate
  // state falls into 'Stopped' because the renderer can't observe a bound
  // server until the first status push arrives.
  const statusLabel = serverRunning
    ? `Running -- port ${mcpPort}`
    : 'Stopped'

  return (
    <PageFrame
      icon={headerIcon}
      iconAccent="sky"
      title="Conductor MCP"
      context={statusLabel}
      actions={<CompatBadge feature="mcp" />}
    >
      <div className="max-w-3xl mx-auto p-5 space-y-4">
        {serverRunning ? (
          <>
            {/* Intro / info row — the full technical note lives here in the
                rebuilt card idiom rather than as a bare paragraph. */}
            <div
              className="rounded-xl p-4 text-sm text-subtext0 leading-relaxed"
              style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
            >
              Local HTTP MCP server hosting all CCC-provided tools. It is registered per session:
              each CCC-spawned session gets its own
              <code className="font-mono mx-1 text-xs">--mcp-config</code>
              pointing at the current port. Your global
              <code className="font-mono mx-1 text-xs">~/.claude.json</code>
              is never touched (entries written there by older versions are cleaned up at startup).
              Sub-tools below own their own state; the server stays running independent of any of them.
            </div>

            <ProxySubTool />
            <VisionSubTool />
            <CodexReviewSubTool />
            <HostTransferSubTool />
          </>
        ) : (
          /* Designed empty / degraded state — the MCP listener never bound
             (e.g. EADDRINUSE on the resolved port) or has been stopped, so
             every sub-tool below it is unavailable. Show what happened and
             what to do instead of a wall of "Stopped" cards. */
          <div className="flex flex-col items-center justify-center py-20 px-8 text-center">
            <div
              className="mb-5 rounded-full flex items-center justify-center transition-colors duration-200"
              style={{
                width: 48,
                height: 48,
                background: 'var(--surface-raised)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {offlineIcon}
            </div>
            <div className="text-sm font-medium text-text mb-1">Conductor MCP server is not running</div>
            <div className="text-xs text-overlay1 mb-1 max-w-sm">
              The local MCP listener never bound to a port, so Vision, Codex review, and host
              transfer are unavailable to your sessions.
            </div>
            <div className="text-xs text-overlay0 max-w-sm">
              It normally starts automatically at launch. Restart Claude Command Center to bring it
              back; if it keeps failing, another process may be holding its port.
            </div>
          </div>
        )}
      </div>
    </PageFrame>
  )
}
