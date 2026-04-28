import React, { useEffect, useState } from 'react'
import { useVisionStore } from '../stores/visionStore'
import type { GlobalVisionConfig } from '../../shared/types'
import PageFrame from './PageFrame'

export default function VisionPage() {
  const { config, running, connected, mcpPort, error, loadConfig, saveConfig, start, stop, launchBrowser, fetchStatus } = useVisionStore()

  const [localConfig, setLocalConfig] = useState<GlobalVisionConfig>(config)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    loadConfig()
    fetchStatus()
  }, [])

  useEffect(() => {
    setLocalConfig(config)
    setDirty(false)
  }, [config])

  const updateField = <K extends keyof GlobalVisionConfig>(key: K, value: GlobalVisionConfig[K]) => {
    setLocalConfig(prev => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  const handleSave = async () => {
    await saveConfig(localConfig)
    setDirty(false)
  }

  const handleToggle = async () => {
    if (running) {
      await stop()
    } else {
      // Save config first if dirty, then start
      if (dirty) {
        await saveConfig({ ...localConfig, enabled: true })
      } else {
        await saveConfig({ ...config, enabled: true })
      }
      setDirty(false)
      await start()
    }
  }

  const visionIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )

  const statusLabel =
    running && connected ? 'Connected' :
    running ? 'Running · browser not connected' :
    'Stopped'

  const visionActions = (
    <button
      onClick={handleToggle}
      className={`px-2.5 py-0.5 text-xs rounded border transition-colors ${
        running
          ? 'border-red/40 bg-red/10 text-red hover:bg-red/20'
          : 'border-green/40 bg-green/10 text-green hover:bg-green/20'
      }`}
    >
      {running ? 'Stop' : 'Start'}
    </button>
  )

  return (
    <PageFrame
      icon={visionIcon}
      iconAccent="sky"
      title="Vision"
      context={statusLabel}
      actions={visionActions}
    >
      <div className="max-w-3xl mx-auto p-6 space-y-4">
        {/* Status Card */}
        <div className="bg-surface0 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${
              running && connected ? 'bg-green' : running ? 'bg-yellow' : 'bg-overlay0'
            }`} style={running && connected ? { boxShadow: '0 0 8px 2px #A6E3A140' } : undefined} />
            <div>
              <div className="text-sm font-medium text-text">
                {running && connected ? 'Connected' : running ? 'Running (browser not connected)' : 'Stopped'}
              </div>
              {running && (
                <div className="text-xs text-overlay0 mt-0.5">
                  MCP endpoint: http://localhost:{mcpPort || localConfig.mcpPort}/sse
                </div>
              )}
            </div>
          </div>
          {error && (
            <div className="mt-3 text-xs text-red bg-red/10 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          {running && !connected && (
            <button
              onClick={launchBrowser}
              className="mt-3 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue/20 text-blue hover:bg-blue/30 transition-colors"
            >
              Launch {localConfig.browser === 'edge' ? 'Edge' : 'Chrome'}
            </button>
          )}
        </div>

        {/* Configuration */}
        <div className="bg-surface0 rounded-xl p-4 space-y-4">
          <h2 className="text-sm font-medium text-text uppercase tracking-wide">Configuration</h2>

          <div className="grid grid-cols-2 gap-4">
            {/* Browser */}
            <div>
              <label className="text-xs text-overlay0 block mb-1">Browser</label>
              <select
                value={localConfig.browser}
                onChange={(e) => updateField('browser', e.target.value as 'chrome' | 'edge')}
                className="w-full bg-base text-text text-sm rounded-lg px-3 py-2 border border-surface1 focus:border-blue focus:outline-none"
              >
                <option value="chrome">Chrome</option>
                <option value="edge">Edge</option>
              </select>
            </div>

            {/* CDP Port */}
            <div>
              <label className="text-xs text-overlay0 block mb-1">CDP Port</label>
              <input
                type="number"
                value={localConfig.debugPort}
                onChange={(e) => updateField('debugPort', parseInt(e.target.value, 10) || 9222)}
                className="w-full bg-base text-text text-sm rounded-lg px-3 py-2 border border-surface1 focus:border-blue focus:outline-none font-mono"
              />
            </div>

            {/* MCP Port */}
            <div>
              <label className="text-xs text-overlay0 block mb-1">MCP Port</label>
              <input
                type="number"
                value={localConfig.mcpPort}
                onChange={(e) => updateField('mcpPort', parseInt(e.target.value, 10) || 19333)}
                className="w-full bg-base text-text text-sm rounded-lg px-3 py-2 border border-surface1 focus:border-blue focus:outline-none font-mono"
              />
            </div>

            {/* URL */}
            <div>
              <label className="text-xs text-overlay0 block mb-1">URL to open</label>
              <input
                type="text"
                value={localConfig.url || ''}
                onChange={(e) => updateField('url', e.target.value || undefined)}
                placeholder="about:blank"
                className="w-full bg-base text-text text-sm rounded-lg px-3 py-2 border border-surface1 focus:border-blue focus:outline-none"
              />
            </div>
          </div>

          {/* Headless */}
          <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
            <input
              type="checkbox"
              checked={localConfig.headless ?? true}
              onChange={(e) => updateField('headless', e.target.checked)}
              className="w-4 h-4 rounded border-surface1 bg-base text-blue focus:ring-blue"
            />
            Headless mode (no visible browser window)
          </label>

          {dirty && (
            <button
              onClick={handleSave}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue/20 text-blue hover:bg-blue/30 transition-colors"
            >
              Save Configuration
            </button>
          )}
        </div>

        {/* Info */}
        <div className="bg-surface0 rounded-xl p-4 space-y-2">
          <h2 className="text-sm font-medium text-text uppercase tracking-wide">How it works</h2>
          <div className="text-xs text-overlay0 space-y-1.5">
            <p>When started, the Conductor runs an MCP server that exposes browser vision tools (screenshot, navigate, click, type, eval, etc.) to all Claude Code sessions.</p>
            <p>Claude Code discovers the tools automatically via <span className="font-mono text-text">~/.claude/settings.json</span>.</p>
            <p>For SSH sessions, a reverse tunnel (<span className="font-mono text-text">-R {localConfig.mcpPort}:localhost:{localConfig.mcpPort}</span>) is added automatically so remote sessions can reach the MCP server.</p>
          </div>
        </div>
      </div>
    </PageFrame>
  )
}
