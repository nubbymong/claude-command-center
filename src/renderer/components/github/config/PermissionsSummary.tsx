import { useState } from 'react'
import type { Capability, GitHubFeatureKey } from '../../../../shared/github-types'
import { useGitHubStore } from '../../../stores/githubStore'

const FEATURE_CAPABILITIES: Record<GitHubFeatureKey, Capability[]> = {
  activePR: ['pulls'],
  ci: ['actions'],
  reviews: ['pulls'],
  linkedIssues: ['issues'],
  notifications: ['notifications'],
  localGit: [],
  sessionContext: [],
}

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
  return Array.from(set)
}

function capsToFineGrainedPermissions(caps: Set<Capability>): string[] {
  const out: string[] = []
  if (caps.has('pulls')) out.push('Pull requests (R or RW)')
  if (caps.has('issues')) out.push('Issues (R or RW)')
  if (caps.has('contents')) out.push('Contents (R)')
  if (caps.has('statuses')) out.push('Commit statuses (R)')
  if (caps.has('actions')) out.push('Actions (R or RW)')
  if (caps.has('checks')) out.push('[unavailable on fine-grained]')
  if (caps.has('notifications')) out.push('[unavailable on fine-grained]')
  return out
}

export default function PermissionsSummary() {
  const config = useGitHubStore((s) => s.config)
  const [copied, setCopied] = useState<'public' | 'private' | null>(null)
  if (!config) return null

  const required = new Set<Capability>()
  for (const [key, enabled] of Object.entries(config.featureToggles)) {
    if (!enabled) continue
    for (const c of FEATURE_CAPABILITIES[key as GitHubFeatureKey] ?? []) required.add(c)
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
      <h3 className="text-sm uppercase text-subtext0 mb-3">Permissions you&apos;d need</h3>
      <div className="bg-mantle p-3 rounded text-sm space-y-3">
        <div>
          <div className="text-subtext0 text-xs mb-1">
            OAuth / Classic PAT scopes — public repos only
          </div>
          <code className="text-blue">
            {oauthPublic.join(' ') || '(none — local only)'}
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
            OAuth / Classic PAT scopes — includes private repos
          </div>
          <code className="text-blue">
            {oauthPrivate.join(' ') || '(none — local only)'}
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
            <code className="text-overlay1">(none — local only)</code>
          ) : (
            <ul className="text-xs text-subtext0 list-disc ml-4">
              {fine.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
