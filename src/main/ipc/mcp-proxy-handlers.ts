/**
 * IPC handlers for the Conductor MCP proxy UI (T5, #97).
 *
 * Bridges the renderer's Proxy sub-tool to the registry (T1) + supervisor (T2).
 * Every mutation reconciles the supervisor (`sync`) so runtime state tracks the
 * registry, and returns the merged view so the renderer refreshes in one round
 * trip. A push channel (MCP_PROXY_CHANGED) fires on any supervisor change so the
 * UI reflects async connect/close without polling.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  listUpstreams,
  addUpstream,
  updateUpstream,
  removeUpstream,
  type McpUpstreamInput,
} from '../mcp-proxy/upstream-registry'
import { getProxySupervisor } from '../mcp-proxy/supervisor'
import { discoverAll, importDiscovered, takeOver, type DiscoveredUpstream, type AdoptSource } from '../mcp-proxy/adopt'
import { onInternal } from '../internal-events'
import { logError } from '../debug-logger'
import type { McpUpstreamView } from '../../shared/types'

/** Merge the persisted registry with live supervisor state into the UI view. */
function buildView(): McpUpstreamView[] {
  const supervisor = getProxySupervisor()
  supervisor.sync()
  const runtime = new Map(supervisor.getState().map((s) => [s.id, s]))
  return listUpstreams().map((u) => {
    const rt = runtime.get(u.id)
    return {
      ...u,
      status: rt?.status ?? 'offline',
      toolCount: rt?.toolCount ?? 0,
      lastError: rt?.lastError,
    }
  })
}

export function registerMcpProxyHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.MCP_PROXY_LIST, async () => buildView())

  ipcMain.handle(IPC.MCP_PROXY_ADD, async (_e, input: McpUpstreamInput) => {
    try {
      const created = addUpstream(input)
      if (!created) return { ok: false, error: 'Failed to save upstream' }
      const supervisor = getProxySupervisor()
      supervisor.sync()
      if (created.enabled && created.autostart) {
        void supervisor.startUpstream(created.id)
      }
      return { ok: true, upstreams: buildView() }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to add upstream' }
    }
  })

  ipcMain.handle(IPC.MCP_PROXY_UPDATE, async (_e, id: string, patch: Partial<McpUpstreamInput>) => {
    const updated = updateUpstream(id, patch)
    if (!updated) return { ok: false, error: 'Upstream not found' }
    getProxySupervisor().sync()
    return { ok: true, upstreams: buildView() }
  })

  ipcMain.handle(IPC.MCP_PROXY_REMOVE, async (_e, id: string) => {
    const supervisor = getProxySupervisor()
    await supervisor.stopUpstream(id)
    const removed = removeUpstream(id)
    supervisor.sync()
    return { ok: removed, upstreams: buildView() }
  })

  ipcMain.handle(IPC.MCP_PROXY_START, async (_e, id: string) => {
    try {
      await getProxySupervisor().startUpstream(id)
      return { ok: true, upstreams: buildView() }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to start upstream' }
    }
  })

  ipcMain.handle(IPC.MCP_PROXY_STOP, async (_e, id: string) => {
    await getProxySupervisor().stopUpstream(id)
    return { ok: true, upstreams: buildView() }
  })

  ipcMain.handle(IPC.MCP_PROXY_RESTART, async (_e, id: string) => {
    try {
      await getProxySupervisor().restartUpstream(id)
      return { ok: true, upstreams: buildView() }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to restart upstream' }
    }
  })

  ipcMain.handle(IPC.MCP_PROXY_DISCOVER, async () => discoverAll())

  ipcMain.handle(IPC.MCP_PROXY_IMPORT, async (_e, items: DiscoveredUpstream[]) => {
    const added = importDiscovered(items ?? [])
    getProxySupervisor().sync()
    return { ok: true, added, upstreams: buildView() }
  })

  ipcMain.handle(IPC.MCP_PROXY_TAKEOVER, async (_e, source: AdoptSource, names: string[]) => {
    if (source === 'codex') return { ok: false, removed: 0, error: 'Codex take-over is not supported yet' }
    return takeOver(source, names ?? [])
  })

  // Push supervisor changes (async connect/close/tool-list) to the renderer.
  onInternal('mcp-proxy:changed', () => {
    try {
      getWindow()?.webContents.send(IPC.MCP_PROXY_CHANGED, buildView())
    } catch (err) {
      logError(`[mcp-proxy-handlers] change broadcast failed: ${String(err)}`)
    }
  })
}
