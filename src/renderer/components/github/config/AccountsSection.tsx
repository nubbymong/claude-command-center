// src/renderer/components/github/config/AccountsSection.tsx
// "Accounts" section: one AccountPanel per profile, the primary add-account
// button (opens the existing AddProfileModal), and the zero-profiles empty
// card. Replaces AuthProfilesList's section-level role.
import { useState } from 'react'
import { useGitHubStore } from '../../../stores/githubStore'
import AccountPanel from './AccountPanel'
import AddProfileModal from './AddProfileModal'

export default function AccountsSection() {
  const profiles = useGitHubStore((s) => s.profiles)
  const [adding, setAdding] = useState(false)

  return (
    <section>
      <h3 className="text-sm uppercase text-subtext0 mb-3">Accounts</h3>
      <div className="space-y-2">
        {profiles.length === 0 && (
          <div className="text-sm text-overlay1 bg-mantle p-3 rounded">
            No auth profiles yet. Sign in with GitHub, adopt a `gh` CLI account, or paste a PAT.
          </div>
        )}
        {profiles.map((p, i) => (
          <AccountPanel key={p.id} profile={p} index={i} />
        ))}
      </div>
      <button
        onClick={() => setAdding(true)}
        className="mt-3 bg-blue text-base px-3 py-1.5 rounded text-sm"
      >
        Sign in with GitHub / Add account
      </button>
      {adding && <AddProfileModal onClose={() => setAdding(false)} />}
    </section>
  )
}
