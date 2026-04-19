import { useRef, useState } from 'react'
import type { AuthProfile } from '../../../../shared/github-types'
import { useGitHubStore } from '../../../stores/githubStore'
import AddProfileModal from './AddProfileModal'
import ExpiryBanner from '../ExpiryBanner'

export default function AuthProfilesList() {
  const profiles = useGitHubStore((s) => s.profiles)
  const removeProfile = useGitHubStore((s) => s.removeProfile)
  const renameProfile = useGitHubStore((s) => s.renameProfile)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({})
  // In-flight guard for commitRename: pressing Enter fires onKeyDown AND
  // onBlur (the input loses focus when the form processes the key), so
  // without this the IPC would fire twice per commit.
  const renamingRef = useRef(false)

  const doTest = async (id: string) => {
    setTesting(id)
    const r = await window.electronAPI.github.testProfile(id)
    setTesting(null)
    setTestResult((prev) => ({
      ...prev,
      [id]: r.ok
        ? { ok: true, msg: String.fromCodePoint(0x2713) + ' ' + (r.username ?? '') }
        : { ok: false, msg: String.fromCodePoint(0x2717) + ' ' + (r.error ?? 'error') },
    }))
  }

  const startRename = (p: AuthProfile) => {
    setEditingId(p.id)
    setNewLabel(p.label)
  }
  const commitRename = async () => {
    if (!editingId || renamingRef.current) return
    renamingRef.current = true
    try {
      await renameProfile(editingId, newLabel)
      setEditingId(null)
    } finally {
      renamingRef.current = false
    }
  }

  return (
    <section>
      <h3 className="text-sm uppercase text-subtext0 mb-3">Auth profiles</h3>
      <div className="space-y-2">
        {profiles.length === 0 && (
          <div className="text-sm text-overlay1 bg-mantle p-3 rounded">
            No auth profiles yet. Sign in with GitHub, adopt a `gh` CLI account, or paste a PAT.
          </div>
        )}
        {profiles.map((p) => (
          <div key={p.id} className="bg-mantle rounded">
          <ExpiryBanner
            profile={p}
            onRenew={() => {
              startRename(p)
            }}
          />
          <div className="p-3 flex items-start gap-3">
            {/* Initials avatar: CSP blocks remote https <img>; avatarUrl persisted for a future main-process data:-URL proxy. */}
            <div
              className="w-8 h-8 rounded-full bg-surface0 text-text text-xs font-semibold flex items-center justify-center shrink-0"
              aria-label={`${p.username} avatar`}
              title={p.username}
            >
              {(p.label || p.username).trim().slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              {editingId === p.id ? (
                <input
                  className="w-full bg-surface0 p-1 rounded text-sm"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => e.key === 'Enter' && commitRename()}
                  autoFocus
                />
              ) : (
                <div className="text-text font-medium">{p.label}</div>
              )}
              <div className="text-xs text-subtext0">
                {p.username} · {p.kind}
                {p.expiryObservable && p.expiresAt && (
                  <span className="ml-2">expires {new Date(p.expiresAt).toLocaleDateString()}</span>
                )}
              </div>
              <div className="text-xs text-overlay1 mt-1">
                Scopes: {p.scopes.join(', ') || '(none reported)'}
              </div>
              {p.rateLimits?.core && (
                <div className="text-xs text-overlay0 mt-1">
                  Core rate: {p.rateLimits.core.remaining}/{p.rateLimits.core.limit}
                </div>
              )}
              {testResult[p.id] && (
                <div className={`text-xs mt-1 ${testResult[p.id].ok ? 'text-green' : 'text-red'}`}>
                  {testResult[p.id].msg}
                </div>
              )}
            </div>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => doTest(p.id)}
                disabled={testing === p.id}
                className="text-xs bg-surface0 hover:bg-surface1 px-2 py-1 rounded"
              >
                {testing === p.id ? 'Testing' : 'Test'}
              </button>
              <button
                onClick={() => startRename(p)}
                className="text-xs bg-surface0 hover:bg-surface1 px-2 py-1 rounded"
              >
                Rename
              </button>
              <button
                onClick={() => {
                  if (confirm(`Remove profile "${p.label}"? The token is wiped from keychain.`)) {
                    removeProfile(p.id)
                  }
                }}
                className="text-xs bg-red/20 hover:bg-red/40 text-red px-2 py-1 rounded"
              >
                Remove
              </button>
            </div>
          </div>
          </div>
        ))}
      </div>
      <button
        onClick={() => setAdding(true)}
        className="mt-3 bg-blue text-base px-3 py-1.5 rounded text-sm"
      >
        Sign in with GitHub / Add auth
      </button>
      {adding && <AddProfileModal onClose={() => setAdding(false)} />}
    </section>
  )
}
