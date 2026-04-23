import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../../stores/settingsStore'
import type { HooksGatewayStatus } from '../../../../shared/hook-types'

export default function HooksGatewaySection() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [status, setStatus] = useState<HooksGatewayStatus | null>(null)
  const [editingPort, setEditingPort] = useState(false)

  useEffect(() => {
    let active = true
    window.electronAPI.hooks.getStatus().then((s) => {
      if (active) setStatus(s)
    })
    const off = window.electronAPI.hooks.onStatus(setStatus)
    return () => {
      active = false
      off()
    }
  }, [])

  const toggleEnabled = async (next: boolean) => {
    await window.electronAPI.hooks.toggle(next)
    await updateSettings({ hooksEnabled: next })
  }

  const savePort = async (port: number) => {
    // Only cycle the gateway if it was already running. Otherwise a port
    // change with hooks disabled would silently enable them — surprising
    // side-effect for a setting that reads as purely numeric.
    const wasRunning = settings.hooksEnabled || status?.listening === true
    await updateSettings({ hooksPort: port })
    if (wasRunning) {
      await window.electronAPI.hooks.toggle(false)
      await window.electronAPI.hooks.toggle(true)
    }
    setEditingPort(false)
  }

  return (
    <section className="space-y-3 pt-6 border-t border-surface0">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-text">HTTP Hooks Gateway</h3>
          <p className="text-xs text-subtext0 mt-1 max-w-md">
            Receives tool-call, permission, and lifecycle events from Claude Code sessions.
            Powers the Live Activity feed. No telemetry - listener is 127.0.0.1 only;
            reverse-tunnelled into SSH sessions you start.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={settings.hooksEnabled}
            onChange={(e) => void toggleEnabled(e.target.checked)}
          />
          <span>{settings.hooksEnabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>

      <div className="text-[11px] text-overlay1">
        {status?.listening
          ? `Listening on 127.0.0.1:${status.port}`
          : status?.error
            ? `Stopped (${status.error})`
            : 'Stopped'}
        <button
          className="ml-2 text-blue underline disabled:opacity-40 disabled:no-underline"
          onClick={() => setEditingPort(true)}
          type="button"
          disabled={editingPort}
        >
          change port
        </button>
      </div>

      {editingPort && (
        <PortEditor
          initial={settings.hooksPort}
          onCancel={() => setEditingPort(false)}
          onSave={savePort}
        />
      )}

      <div className="pl-4 space-y-1 text-xs">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked readOnly disabled />
          <span>
            Live Activity feed <span className="text-overlay1">- show recent events in sidebar</span>
          </span>
        </label>
        <label className="flex items-center gap-2 opacity-60">
          <input type="checkbox" checked={false} disabled />
          <span>
            Desktop notifications <span className="text-overlay1">- on permission requests and stop failures (coming soon)</span>
          </span>
        </label>
      </div>
    </section>
  )
}

interface PortEditorProps {
  initial: number
  onCancel: () => void
  onSave: (port: number) => void
}

function PortEditor({ initial, onCancel, onSave }: PortEditorProps) {
  const [value, setValue] = useState(String(initial))
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      setError('Port must be an integer between 1024 and 65535')
      return
    }
    onSave(n)
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <input
        type="number"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          if (error) setError(null)
        }}
        className="bg-surface0 border border-surface1 rounded px-2 py-0.5 w-24 text-text"
        min={1024}
        max={65535}
        autoFocus
      />
      <button
        onClick={submit}
        className="px-2 py-0.5 rounded bg-blue text-crust hover:bg-sapphire transition-colors duration-150"
        type="button"
      >
        Save
      </button>
      <button
        onClick={onCancel}
        className="px-2 py-0.5 rounded bg-surface0 text-text hover:bg-surface1 transition-colors duration-150"
        type="button"
      >
        Cancel
      </button>
      {error && <span className="text-red">{error}</span>}
    </div>
  )
}
