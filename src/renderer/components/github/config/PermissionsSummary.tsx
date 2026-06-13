import { useState } from 'react'
import type { Capability } from '../../../../shared/github-types'
import {
  AUTH_FEATURE_KEYS,
  FEATURE_CAPABILITIES,
  masterState,
} from '../../../../shared/github-features'
import { DEFAULT_AUTH_FEATURE_TOGGLES } from '../../../../shared/github-constants'
import { useGitHubStore } from '../../../stores/githubStore'

// Classic OAuth / classic-PAT scopes. `mode` matches the Tier-2 device flow
// split from spec §2: the public-default asks for `public_repo`; the opt-in
// private mode asks for `repo`. Both variants render side-by-side so the user
// can pick the scope set that matches their repo visibility.
function capsToOAuthScopes(caps: Set<Capability>, mode: 'public' | 'private'): string[] {
  const set = new Set<string>()
  const repoScope = mode === 'private' ? 'repo' : 'public_repo'
  if (
    caps.has('pulls') ||
    caps.has('issues') ||
    caps.has('contents') ||
    caps.has('statuses') ||
    caps.has('checks') ||
    caps.has('actions')
  ) {
    set.add(repoScope)
  }
  if (caps.has('actions')) set.add('workflow')
  if (caps.has('notifications')) set.add('notifications')
  // `user` is the classic/OAuth scope that grants the plan / AI-credits read,
  // matching CLASSIC_PAT_SCOPE_CAPABILITIES.user = ['plan'].
  if (caps.has('plan')) set.add('user')
  return Array.from(set)
}

function capsToFineGrainedPermissions(caps: Set<Capability>): string[] {
  const out: string[] = []
  if (caps.has('pulls')) out.push('Pull requests (R or RW)')
  if (caps.has('issues')) out.push('Issues (R or RW)')
  if (caps.has('contents')) out.push('Contents (R)')
  if (caps.has('statuses')) out.push('Commit statuses (R)')
  if (caps.has('actions')) out.push('Actions (R or RW)')
  // 'plan' maps to the Account "Plan: read" fine-grained permission, which
  // grants the AI-credits (Copilot billing) coverage the aiCredits feature reads.
  if (caps.has('plan')) out.push('Plan: read (Account)')
  if (caps.has('checks')) out.push('[unavailable on fine-grained]')
  if (caps.has('notifications')) out.push('[unavailable on fine-grained]')
  return out
}

export default function PermissionsSummary() {
  const config = useGitHubStore((s) => s.config)
  const [copied, setCopied] = useState<'public' | 'private' | null>(null)
  const [open, setOpen] = useState(false)
  if (!config) return null

  // Derive required capabilities from PER-ACCOUNT state, not the legacy global
  // featureToggles. A feature enabled on ANY account (or default-on with zero
  // accounts) contributes its capabilities; masterState !== 'off' covers both
  // 'on' and 'mixed'. layeredDefaults guards against a sparse featureDefaults
  // (interrupted migration / hydrate race), mirroring MasterFeaturesSection.
  // localGit/sessionContext are app-wide and excluded from the shared registry,
  // so they correctly contribute nothing.
  const profiles = Object.values(config.authProfiles)
  const layeredDefaults = {
    ...DEFAULT_AUTH_FEATURE_TOGGLES,
    ...(config.featureDefaults ?? {}),
  }
  const required = new Set<Capability>()
  for (const k of AUTH_FEATURE_KEYS) {
    if (masterState(profiles, layeredDefaults, k) === 'off') continue
    for (const c of FEATURE_CAPABILITIES[k]) required.add(c)
  }

  const oauthPublic = capsToOAuthScopes(required, 'public')
  const oauthPrivate = capsToOAuthScopes(required, 'private')
  const fine = capsToFineGrainedPermissions(required)

  const copyScopes = async (scopes: string[], which: 'public' | 'private') => {
    // Clipboard access can reject when the window isn't focused or OS policy
    // blocks it. Swallow so the click doesn't surface as an unhandled promise
    // rejection — the user can still read and manually copy the scopes.
    try {
      await navigator.clipboard.writeText(scopes.join(' '))
      setCopied(which)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="permissions-summary-body"
        className="w-full flex items-center gap-2 text-sm uppercase text-subtext0 hover:text-text transition-colors rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-blue/50"
      >
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          aria-hidden="true"
          className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
        >
          <path d="M5 3l6 5-6 5z" fill="currentColor" />
        </svg>
        What each feature needs
      </button>
      {open && (
        <div id="permissions-summary-body" className="bg-mantle p-3 rounded text-sm space-y-3 mt-3">
          <div>
            <div className="text-subtext0 text-xs mb-1">
              OAuth / Classic PAT scopes (public repos only)
            </div>
            <code className="text-blue">
              {oauthPublic.join(' ') || '(none; local only)'}
            </code>
            {oauthPublic.length > 0 && (
              <button
                onClick={() => copyScopes(oauthPublic, 'public')}
                className="ml-3 text-xs bg-surface0 px-2 py-0.5 rounded"
              >
                {copied === 'public' ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
          <div>
            <div className="text-subtext0 text-xs mb-1">
              OAuth / Classic PAT scopes (includes private repos)
            </div>
            <code className="text-blue">
              {oauthPrivate.join(' ') || '(none; local only)'}
            </code>
            {oauthPrivate.length > 0 && (
              <button
                onClick={() => copyScopes(oauthPrivate, 'private')}
                className="ml-3 text-xs bg-surface0 px-2 py-0.5 rounded"
              >
                {copied === 'private' ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
          <div>
            <div className="text-subtext0 text-xs mb-1">Fine-grained PAT permissions</div>
            {fine.length === 0 ? (
              <code className="text-overlay1">(none; local only)</code>
            ) : (
              <ul className="text-xs text-subtext0 list-disc ml-4">
                {fine.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
