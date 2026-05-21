import React, { useEffect } from 'react'
import { useConductorMcpStore } from '../stores/conductorMcpStore'
import PageFrame from './PageFrame'
import VisionSubTool from './conductor-mcp/VisionSubTool'
import CodexReviewSubTool from './conductor-mcp/CodexReviewSubTool'
import HostTransferSubTool from './conductor-mcp/HostTransferSubTool'

export default function ConductorMcpPage() {
  const { serverRunning, mcpPort, fetchStatus, loadConfig } = useConductorMcpStore()

  useEffect(() => {
    loadConfig()
    fetchStatus()
  }, [])

  const headerIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  )

  const statusLabel = serverRunning
    ? `Running -- port ${mcpPort || 'discovering'}`
    : 'Stopped'

  return (
    <PageFrame
      icon={headerIcon}
      iconAccent="sky"
      title="Conductor MCP"
      context={statusLabel}
    >
      <div className="max-w-3xl mx-auto p-6 space-y-4">
        <p className="text-sm text-subtext0">
          Local HTTP MCP server hosting all CCC-provided tools. Claude CLI auto-discovers it via
          <code className="font-mono mx-1 text-xs">~/.claude.json</code>
          (the canonical <code className="font-mono mx-1 text-xs">mcpServers</code> registry); CCC-spawned sessions also get per-session
          <code className="font-mono mx-1 text-xs">--mcp-config</code>
          overrides with the current port. Sub-tools below own their own state -- the server stays
          running independent of any of them.
        </p>
        <VisionSubTool />
        <CodexReviewSubTool />
        <HostTransferSubTool />
      </div>
    </PageFrame>
  )
}
