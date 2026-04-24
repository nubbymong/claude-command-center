import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../../stores/settingsStore'
import type { HooksGatewayStatus } from '../../../../shared/hook-types'

export default function HooksGatewaySection() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [status, setStatus] = useState<HooksGatewayStatus | null>(null)
  const [editingPort, setEditingPort] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    window.electronAPI.hooks
      .getStatus()
      .then((s) => {
        if (active) setStatus(s)
      })
      .catch(() => {
        // IPC can reject during renderer/app teardown. Subsequent
        // onStatus pushes will populate state when the channel recovers.
      })
    const off = window.electronAPI.hooks.onStatus(setStatus)
    return () => {
      active = false
      off()
    }
  }, [])

  // Persist `hooksEnabled` only AFTER the gateway start/stop has resolved.
  // A bind failure (e.g. port in use and retries exhausted) now surfaces an
  // inline error instead of becoming an unhandled-promise toast and leaving
  // persisted state diverged from listener reality.
  const toggleEnabled = async (next: boolean): Promise<void> => {
    setActionError(null)
    try {
      const result = await window.electronAPI.hooks.toggle(next)
      // Main-side status is authoritative. If start() returned enabled=false
      // (e.g. bind-failed), don't persist hooksEnabled=true against reality.
      const effectiveEnabled = next ? !!result.listening : false
      await updateSettings({ hooksEnabled: effectiveEnabled })
      if (next && !result.listening) {
        setActionError(result.error ? `Could not start gateway: ${result.error}` : 'Could not start gateway')
      }
    } catch (err) {
      setActionError(`Toggle failed: ${(err as Error)?.message ?? String(err)}`)
    }
  }

  const savePort = async (port: number): Promise<void> => {
    // Only cycle the gateway if the user has enabled hooks. A port change
    // with hooks disabled would silently enable them — surprising side-
    // effect for a setting that reads as purely numeric. Gating on
    // persisted intent (not `status.listening`) avoids the edge case
    // where a stale `listening=true` would trigger a restart and then
    // leave persisted `hooksEnabled=false` diverged from reality.
    setActionError(null)
    const shouldRestart = settings.hooksEnabled === true
    try {
      await updateSettings({ hooksPort: port })
      if (shouldRestart) {
        await window.electronAPI.hooks.toggle(false)
        const restart = await window.electronAPI.hooks.toggle(true)
        // Reconcile persisted intent with actual listener state.
        await updateSettings({ hooksEnabled: !!restart.listening })
        if (!restart.listening) {
          setActionError(restart.error ? `Restart failed on port ${port}: ${restart.error}` : `Restart failed on port ${port}`)
          return
        }
      }
      setEditingPort(false)
    } catch (err) {
      setActionError(`Port change failed: ${(err as Error)?.message ?? String(err)}`)
    }
  }

  return (
    <section className="space-y-3 pt-6 border-t border-surface0">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-text">HTTP Hooks Gateway</h3>
          <p className="text-xs text-subtext0 mt-1 max-w-md">
            Opt-in loopback listener that receives tool-call, permission, and lifecycle events
            from your Claude Code sessions. Foundation for upcoming desktop notifications and
            external automations. No telemetry - listener is 127.0.0.1 only; reverse-tunnelled
            into SSH sessions you start.
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

      {actionError && (
        <div className="text-[11px] text-red" role="alert">
          {actionError}
        </div>
      )}

      {editingPort && (
        <PortEditor
          initial={settings.hooksPort}
          onCancel={() => setEditingPort(false)}
          onSave={savePort}
        />
      )}

      <div className="pl-4 space-y-1 text-xs">
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
