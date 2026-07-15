import React, { useEffect, useState } from 'react'
import { useMcpProxyStore, type McpUpstreamDraft } from '../../stores/mcpProxyStore'
import { setupMcpProxyListener } from '../../stores/mcpProxyStore'
import SubToolCard from './SubToolCard'
import type { McpUpstreamView, McpUpstreamExposure } from '../../../shared/types'

const icon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <circle cx="5" cy="5" r="2" />
    <circle cx="19" cy="5" r="2" />
    <circle cx="5" cy="19" r="2" />
    <circle cx="19" cy="19" r="2" />
    <line x1="7" y1="6.5" x2="10" y2="10" />
    <line x1="17" y1="6.5" x2="14" y2="10" />
    <line x1="7" y1="17.5" x2="10" y2="14" />
    <line x1="17" y1="17.5" x2="14" y2="14" />
  </svg>
)

const STATUS_COLOR: Record<McpUpstreamView['status'], 'green' | 'yellow' | 'red' | 'overlay1'> = {
  online: 'green',
  connecting: 'yellow',
  error: 'red',
  offline: 'overlay1',
}

function transportSummary(u: McpUpstreamView): string {
  if (u.transport.kind === 'stdio') {
    return [u.transport.command, ...(u.transport.args ?? [])].join(' ')
  }
  return `${u.transport.kind.toUpperCase()} ${u.transport.url}`
}

const EMPTY_DRAFT: McpUpstreamDraft = {
  name: '',
  transport: { kind: 'stdio', command: '', args: [] },
  enabled: true,
  exposure: 'search',
  autostart: true,
}

export default function ProxySubTool() {
  const upstreams = useMcpProxyStore((s) => s.upstreams)
  const error = useMcpProxyStore((s) => s.error)
  const { load, add, update, remove, start, stop, restart, importFromClients } = useMcpProxyStore.getState()

  const [showAdd, setShowAdd] = useState(false)
  const [draft, setDraft] = useState<McpUpstreamDraft>(EMPTY_DRAFT)
  const [argsText, setArgsText] = useState('')
  const [importMsg, setImportMsg] = useState<string | null>(null)

  async function runImport() {
    setImportMsg('Scanning Claude / Codex configs…')
    const { added, found } = await importFromClients()
    setImportMsg(found === 0 ? 'No servers found in client configs.' : `Imported ${added} of ${found} discovered server(s).`)
  }

  useEffect(() => {
    load()
    return setupMcpProxyListener()
  }, [])

  const onlineCount = upstreams.filter((u) => u.status === 'online').length
  const statusLabel = upstreams.length === 0 ? 'No servers' : `${onlineCount}/${upstreams.length} online`

  const kind = draft.transport.kind

  async function submitDraft() {
    const transport =
      kind === 'stdio'
        ? { kind: 'stdio' as const, command: (draft.transport as any).command?.trim(), args: argsText.split(/\s+/).filter(Boolean) }
        : { kind, url: (draft.transport as any).url?.trim() }
    const ok = await add({ ...draft, transport })
    if (ok) {
      setDraft(EMPTY_DRAFT)
      setArgsText('')
      setShowAdd(false)
    }
  }

  return (
    <SubToolCard
      title="MCP Proxy"
      icon={icon}
      statusLabel={statusLabel}
      statusColor={onlineCount > 0 ? 'green' : 'overlay1'}
      description="Aggregate external MCP servers behind Conductor. One shared instance per server is fanned out to every session; tools are discovered on demand via search_tools (or advertised directly in passthrough mode)."
      actions={
        <div className="flex gap-2">
          <button
            className="text-xs px-2 py-1 rounded-md bg-surface1 hover:bg-surface2 text-text transition-colors"
            onClick={runImport}
            title="Discover and import MCP servers already configured in Claude / Codex"
          >
            Import existing
          </button>
          <button
            className="text-xs px-2 py-1 rounded-md bg-surface1 hover:bg-surface2 text-text transition-colors"
            onClick={() => setShowAdd((v) => !v)}
          >
            {showAdd ? 'Cancel' : '+ Add server'}
          </button>
        </div>
      }
    >
      {error && <div className="text-xs text-red">{error}</div>}
      {importMsg && <div className="text-xs text-subtext0">{importMsg}</div>}

      {showAdd && (
        <div className="rounded-lg p-3 space-y-2" style={{ background: 'var(--surface-sunken, rgba(0,0,0,0.15))', border: '1px solid var(--border-subtle)' }}>
          <input
            className="w-full text-sm px-2 py-1 rounded bg-mantle text-text border border-surface1"
            placeholder="Display name (e.g. Filesystem)"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <div className="flex gap-2">
            <select
              className="text-sm px-2 py-1 rounded bg-mantle text-text border border-surface1"
              value={kind}
              onChange={(e) => {
                const k = e.target.value as 'stdio' | 'http' | 'sse'
                setDraft({ ...draft, transport: k === 'stdio' ? { kind: 'stdio', command: '', args: [] } : { kind: k, url: '' } })
              }}
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
            <select
              className="text-sm px-2 py-1 rounded bg-mantle text-text border border-surface1"
              value={draft.exposure}
              onChange={(e) => setDraft({ ...draft, exposure: e.target.value as McpUpstreamExposure })}
            >
              <option value="search">search (via search_tools)</option>
              <option value="passthrough">passthrough (direct)</option>
            </select>
          </div>
          {kind === 'stdio' ? (
            <>
              <input
                className="w-full text-sm px-2 py-1 rounded bg-mantle text-text border border-surface1 font-mono"
                placeholder="command (e.g. npx)"
                value={(draft.transport as any).command}
                onChange={(e) => setDraft({ ...draft, transport: { kind: 'stdio', command: e.target.value } })}
              />
              <input
                className="w-full text-sm px-2 py-1 rounded bg-mantle text-text border border-surface1 font-mono"
                placeholder="args (space-separated, e.g. -y @modelcontextprotocol/server-filesystem /path)"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
              />
            </>
          ) : (
            <input
              className="w-full text-sm px-2 py-1 rounded bg-mantle text-text border border-surface1 font-mono"
              placeholder="url (e.g. http://localhost:3000/mcp)"
              value={(draft.transport as any).url}
              onChange={(e) => setDraft({ ...draft, transport: { kind, url: e.target.value } })}
            />
          )}
          <label className="flex items-center gap-2 text-xs text-subtext0">
            <input type="checkbox" checked={draft.autostart} onChange={(e) => setDraft({ ...draft, autostart: e.target.checked })} />
            Connect on startup
          </label>
          <button
            className="text-xs px-3 py-1 rounded-md bg-blue/20 hover:bg-blue/30 text-blue transition-colors disabled:opacity-40"
            disabled={!draft.name.trim() || (kind === 'stdio' ? !(draft.transport as any).command?.trim() : !(draft.transport as any).url?.trim())}
            onClick={submitDraft}
          >
            Add server
          </button>
        </div>
      )}

      {upstreams.length === 0 && !showAdd && (
        <div className="text-xs text-overlay1">No upstream MCP servers configured yet. Add one to share it across all your sessions.</div>
      )}

      <div className="space-y-2">
        {upstreams.map((u) => (
          <div key={u.id} className="rounded-lg p-3 flex items-center gap-3" style={{ background: 'var(--surface-sunken, rgba(0,0,0,0.12))', border: '1px solid var(--border-subtle)' }}>
            <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLOR[u.status] === 'green' ? 'bg-green/15 text-green' : STATUS_COLOR[u.status] === 'yellow' ? 'bg-yellow/15 text-yellow' : STATUS_COLOR[u.status] === 'red' ? 'bg-red/15 text-red' : 'bg-overlay1/15 text-overlay1'}`}>
              {u.status}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-text font-medium truncate">
                {u.name}
                {u.status === 'online' && <span className="text-overlay1 font-normal"> · {u.toolCount} tools</span>}
              </div>
              <div className="text-xs text-overlay1 font-mono truncate">{transportSummary(u)}</div>
              {u.lastError && <div className="text-xs text-red truncate">{u.lastError}</div>}
            </div>
            <select
              className="text-xs px-1.5 py-0.5 rounded bg-mantle text-subtext0 border border-surface1"
              value={u.exposure}
              onChange={(e) => update(u.id, { exposure: e.target.value as McpUpstreamExposure })}
              title="How this server's tools are exposed to the model"
            >
              <option value="search">search</option>
              <option value="passthrough">passthrough</option>
            </select>
            {u.status === 'online' || u.status === 'connecting' ? (
              <button className="text-xs px-2 py-1 rounded bg-surface1 hover:bg-surface2 text-text" onClick={() => stop(u.id)}>Stop</button>
            ) : (
              <button className="text-xs px-2 py-1 rounded bg-surface1 hover:bg-surface2 text-text" onClick={() => start(u.id)} disabled={!u.enabled}>Start</button>
            )}
            <button className="text-xs px-2 py-1 rounded bg-surface1 hover:bg-surface2 text-text" onClick={() => restart(u.id)} title="Restart">↻</button>
            <button className="text-xs px-2 py-1 rounded bg-red/15 hover:bg-red/25 text-red" onClick={() => remove(u.id)} title="Remove">✕</button>
          </div>
        ))}
      </div>
    </SubToolCard>
  )
}
