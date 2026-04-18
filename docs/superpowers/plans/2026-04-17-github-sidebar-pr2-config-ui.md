# GitHub Sidebar — PR 2: Config UI + Panel Shell

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.

**Depends on:** PR 1 merged into `beta`.

**Goal:** Ship the user-visible Config page (GitHub tab) with auth profile management, feature toggles, permissions summary, privacy settings, sync settings; the per-session GitHub config drawer; and the panel shell with collapsible `SectionFrame` and `PanelHeader`. **No populated panel sections yet** — those land in PR 3 alongside the sync orchestrator.

**Tech Stack:** React 18 + TypeScript + Zustand 5; `marked@15` (already installed) + `isomorphic-dompurify` (installed in this PR); existing Tailwind theme.

**Spec:** `docs/superpowers/specs/2026-04-17-github-sidebar-design.md` (rev 6).

**Branch:** `feature/github-sidebar-pr2` off `beta`. **PR target:** `beta`.

---

## Cross-Platform Notes (Windows + macOS)

- **Keyboard shortcut labels:** `Ctrl+/` on Windows, `⌘+/` on macOS. The `GitHubPanel` keyboard handler branches on `window.electronPlatform === 'darwin'` (exposed by preload — the app-wide convention). UI copy that mentions the shortcut (tips, tooltips, onboarding) must use the same check so labels stay consistent with handler behavior.
- **Training walkthrough screenshots:** existing `getScreenshot()` helper in `TrainingWalkthrough.tsx` prefers `<name>-mac.jpg` on macOS, falls back to `<name>.jpg`. The GitHub onboarding modal uses the same convention — plan handles capture in PR 3.
- **Modal / button chrome:** the app uses custom Catppuccin-themed controls (not native). Platform differences are minimal, but test the OAuth modal's clipboard copy button on both (macOS `navigator.clipboard.writeText` sometimes prompts for permission; Windows typically doesn't).
- **Window controls on frameless window:** macOS traffic lights vs Windows title-bar buttons — already handled by existing chrome code, just don't mount the panel in a way that overlaps either set.
- **Settings page rendering:** test the new GitHub tab at 1280×800 (typical macOS startup) and 1920×1080 (typical Windows). Ensure PermissionsSummary doesn't overflow, profile cards wrap.

## Conventions

- No default exports except React components.
- No renderer Node imports. Every GitHub call goes through `window.electronAPI.github.*` (wired in PR 1).
- Markdown sanitizer is the only `dangerouslySetInnerHTML` site; it MUST go through `renderCommentMarkdown`.
- TDD: failing test → run → implement → run → commit. Components with polling/state transitions require tests.
- Commit prefixes same as PR 1.

---

## File Map — PR 2 only

### Dependencies
- MODIFY `package.json` (+ `isomorphic-dompurify@^2`)

### Renderer — store + utils
- CREATE `src/renderer/stores/githubStore.ts`
- CREATE `src/renderer/utils/markdownSanitizer.ts`
- CREATE `src/renderer/utils/relativeTime.ts` (unless already present)

### Renderer — Config page
- CREATE `src/renderer/components/github/config/GitHubConfigTab.tsx`
- CREATE `src/renderer/components/github/config/AuthProfilesList.tsx`
- CREATE `src/renderer/components/github/config/AddProfileModal.tsx`
- CREATE `src/renderer/components/github/config/OAuthDeviceFlow.tsx`
- CREATE `src/renderer/components/github/config/FeatureTogglesList.tsx`
- CREATE `src/renderer/components/github/config/PermissionsSummary.tsx`
- CREATE `src/renderer/components/github/config/PrivacySettings.tsx`
- CREATE `src/renderer/components/github/config/SyncSettings.tsx`

### Renderer — per-session
- CREATE `src/renderer/components/session/SessionGitHubConfig.tsx`
- CREATE `src/renderer/components/session/parseRepoUrlClient.ts`

### Renderer — panel shell
- CREATE `src/renderer/components/github/SectionFrame.tsx`
- CREATE `src/renderer/components/github/PanelHeader.tsx`
- CREATE `src/renderer/components/github/GitHubPanel.tsx`
- CREATE 8 section stubs under `src/renderer/components/github/sections/` (each renders a SectionFrame with "TODO" body — filled in PR 3)

### Renderer — App integration
- MODIFY `src/renderer/components/SettingsPage.tsx` (add 'github' tab)
- MODIFY `src/renderer/App.tsx` (mount panel + setup listener)

### Tests
- CREATE tests under `tests/unit/github/`:
  - `markdown-sanitizer.test.ts`
  - `githubStore.test.ts`
  - `parseRepoUrlClient.test.ts`
  - `oauth-device-flow-ui.test.ts` (integration test for the polling UI)

---

## Task 0: Branch + deps

- [ ] **Step 1: Check out fresh branch**

```bash
cd F:/CLAUDE_MULTI_APP
git fetch origin
git checkout -b feature/github-sidebar-pr2 origin/beta
```

- [ ] **Step 2: Install DOMPurify**

```bash
npm install isomorphic-dompurify@^2
```
Expected: `isomorphic-dompurify` added. `marked` remains at `^15`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(github): add isomorphic-dompurify for comment sanitization"
```

---

## Phase I — Renderer Store + Utilities

### Task I1: Zustand store

**Files:** CREATE `src/renderer/stores/githubStore.ts`, `tests/unit/github/githubStore.test.ts`.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/githubStore.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useGitHubStore } from '../../../src/renderer/stores/githubStore'

function setupMockElectron() {
  ;(global as any).window = {
    electron: {
      github: {
        getConfig: vi.fn().mockResolvedValue({
          schemaVersion: 1,
          authProfiles: { p1: {
            id: 'p1', kind: 'oauth', label: 'nub', username: 'nub',
            scopes: ['public_repo'], capabilities: ['pulls'],
            createdAt: 0, lastVerifiedAt: 0, expiryObservable: false,
          } },
          featureToggles: { activePR: true, ci: true, reviews: true, linkedIssues: true, notifications: false, localGit: true, sessionContext: true },
          syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
          enabledByDefault: false,
          transcriptScanningOptIn: false,
        }),
        updateConfig: vi.fn().mockImplementation(async (patch: any) => ({
          schemaVersion: 1, authProfiles: {}, featureToggles: {} as any,
          syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
          enabledByDefault: false, transcriptScanningOptIn: false,
          ...patch,
        })),
        removeProfile: vi.fn().mockResolvedValue({ ok: true }),
        renameProfile: vi.fn().mockResolvedValue({ ok: true }),
        onDataUpdate: vi.fn().mockImplementation((cb: any) => () => {}),
        onSyncStateUpdate: vi.fn().mockImplementation((cb: any) => () => {}),
      },
    },
  }
}

describe('githubStore', () => {
  beforeEach(() => {
    setupMockElectron()
    useGitHubStore.setState({
      config: null, profiles: [], repoData: {},
      panelVisible: true, sessionStates: {},
      syncStatus: {},
    })
  })

  it('loadConfig populates config + profiles', async () => {
    await useGitHubStore.getState().loadConfig()
    expect(useGitHubStore.getState().profiles).toHaveLength(1)
    expect(useGitHubStore.getState().profiles[0].username).toBe('nub')
  })

  it('togglePanel flips visibility', () => {
    useGitHubStore.getState().togglePanel()
    expect(useGitHubStore.getState().panelVisible).toBe(false)
  })

  it('setSectionCollapsed persists per session', () => {
    useGitHubStore.getState().setSectionCollapsed('s1', 'localGit', true)
    expect(useGitHubStore.getState().sessionStates.s1.collapsedSections.localGit).toBe(true)
  })

  it('setPanelWidth persists per session', () => {
    useGitHubStore.getState().setPanelWidth('s1', 420)
    expect(useGitHubStore.getState().sessionStates.s1.panelWidth).toBe(420)
  })

  it('handleDataUpdate stores per slug', () => {
    useGitHubStore.getState().handleDataUpdate({ slug: 'a/b', data: { etags: {}, lastSynced: 1, accessedAt: 1 } as any })
    expect(useGitHubStore.getState().repoData['a/b']).toBeDefined()
  })

  it('handleSyncStateUpdate stores per slug', () => {
    useGitHubStore.getState().handleSyncStateUpdate({ slug: 'a/b', state: 'synced', at: 123 })
    expect(useGitHubStore.getState().syncStatus['a/b'].state).toBe('synced')
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/githubStore.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/renderer/stores/githubStore.ts
import { create } from 'zustand'
import type {
  GitHubConfig,
  AuthProfile,
  RepoCache,
} from '../../shared/github-types'

export interface SessionPanelState {
  panelWidth: number
  collapsedSections: Record<string, boolean>
}

export interface SyncStatus {
  state: 'syncing' | 'synced' | 'rate-limited' | 'error' | 'idle'
  at: number
  nextResetAt?: number
}

interface GitHubStoreState {
  config: GitHubConfig | null
  profiles: AuthProfile[]
  repoData: Record<string, RepoCache>
  panelVisible: boolean
  sessionStates: Record<string, SessionPanelState>
  syncStatus: Record<string, SyncStatus>

  loadConfig: () => Promise<void>
  updateConfig: (patch: Partial<GitHubConfig>) => Promise<void>
  removeProfile: (id: string) => Promise<void>
  renameProfile: (id: string, label: string) => Promise<void>
  togglePanel: () => void
  setSectionCollapsed: (sessionId: string, section: string, collapsed: boolean) => void
  setPanelWidth: (sessionId: string, w: number) => void
  handleDataUpdate: (p: { slug: string; data: RepoCache }) => void
  handleSyncStateUpdate: (p: { slug: string; state: SyncStatus['state']; at: number; nextResetAt?: number }) => void
}

export const useGitHubStore = create<GitHubStoreState>((set, get) => ({
  config: null,
  profiles: [],
  repoData: {},
  panelVisible: true,
  sessionStates: {},
  syncStatus: {},

  loadConfig: async () => {
    const config = await window.electronAPI.github.getConfig()
    set({
      config,
      profiles: config ? Object.values(config.authProfiles) : [],
    })
  },

  updateConfig: async (patch) => {
    const updated = await window.electronAPI.github.updateConfig(patch)
    set({ config: updated, profiles: Object.values(updated.authProfiles) })
  },

  removeProfile: async (id) => {
    await window.electronAPI.github.removeProfile(id)
    await get().loadConfig()
  },

  renameProfile: async (id, label) => {
    await window.electronAPI.github.renameProfile(id, label)
    await get().loadConfig()
  },

  togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),

  setSectionCollapsed: (sessionId, section, collapsed) =>
    set((s) => {
      const cur = s.sessionStates[sessionId] ?? { panelWidth: 340, collapsedSections: {} }
      return {
        sessionStates: {
          ...s.sessionStates,
          [sessionId]: { ...cur, collapsedSections: { ...cur.collapsedSections, [section]: collapsed } },
        },
      }
    }),

  setPanelWidth: (sessionId, w) =>
    set((s) => {
      const cur = s.sessionStates[sessionId] ?? { panelWidth: 340, collapsedSections: {} }
      return { sessionStates: { ...s.sessionStates, [sessionId]: { ...cur, panelWidth: w } } }
    }),

  handleDataUpdate: ({ slug, data }) =>
    set((s) => ({ repoData: { ...s.repoData, [slug]: data } })),

  handleSyncStateUpdate: ({ slug, state, at, nextResetAt }) =>
    set((s) => ({ syncStatus: { ...s.syncStatus, [slug]: { state, at, nextResetAt } } })),
}))

let unsubData: (() => void) | null = null
let unsubSync: (() => void) | null = null
export function setupGitHubListener() {
  if (unsubData) return
  unsubData = window.electronAPI.github.onDataUpdate((p) =>
    useGitHubStore.getState().handleDataUpdate(p as any),
  )
  unsubSync = window.electronAPI.github.onSyncStateUpdate((p) =>
    useGitHubStore.getState().handleSyncStateUpdate(p as any),
  )
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run tests/unit/github/githubStore.test.ts
npm run typecheck
git add src/renderer/stores/githubStore.ts tests/unit/github/githubStore.test.ts
git commit -m "feat(github): Zustand store for config, repo data, sync status, panel state"
```

---

### Task I2: Markdown sanitizer (XSS vectors covered)

**Files:** CREATE `src/renderer/utils/markdownSanitizer.ts`, test.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/markdown-sanitizer.test.ts
import { describe, it, expect } from 'vitest'
import { renderCommentMarkdown } from '../../../src/renderer/utils/markdownSanitizer'

describe('renderCommentMarkdown', () => {
  it('renders basic markdown', () => {
    const h = renderCommentMarkdown('**b** and `c`')
    expect(h).toContain('<strong>b</strong>')
    expect(h).toContain('<code>c</code>')
  })
  it('strips <script>', () => {
    expect(renderCommentMarkdown('<script>alert(1)</script>x')).not.toContain('<script')
  })
  it('strips javascript: hrefs', () => {
    expect(renderCommentMarkdown('[x](javascript:alert(1))')).not.toMatch(/javascript:/i)
  })
  it('strips <img onerror>', () => {
    const h = renderCommentMarkdown('<img src=x onerror="alert(1)">')
    expect(h).not.toMatch(/onerror/i)
  })
  it('strips inline onclick', () => {
    expect(renderCommentMarkdown('<a onclick="bad()">x</a>')).not.toContain('onclick')
  })
  it('keeps https: links', () => {
    expect(renderCommentMarkdown('[x](https://example.com)')).toContain('href="https://example.com"')
  })
  it('strips <img> entirely (CSP img-src does not allow https:)', () => {
    const h = renderCommentMarkdown('![alt](https://a/b.png)')
    expect(h).not.toMatch(/<img/i)
  })
  it('strips http: links (https only)', () => {
    expect(renderCommentMarkdown('[x](http://example.com)')).not.toMatch(/href="http:/i)
  })
  it('strips mailto: links (navigation would be inert under app CSP)', () => {
    expect(renderCommentMarkdown('[x](mailto:a@b)')).not.toMatch(/href="mailto:/i)
  })
  it('strips bare fragment # links', () => {
    expect(renderCommentMarkdown('[x](#anchor)')).not.toMatch(/href="#/i)
  })
  it('strips data: URIs', () => {
    const h = renderCommentMarkdown('[x](data:text/html,<script>bad</script>)')
    expect(h).not.toMatch(/data:/i)
  })
})
```

- [ ] **Step 2: Run — expect fail**

```bash
npx vitest run tests/unit/github/markdown-sanitizer.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/renderer/utils/markdownSanitizer.ts
import { marked } from 'marked'
import DOMPurify from 'isomorphic-dompurify'

marked.setOptions({ breaks: true, gfm: true })

// No <img>: app CSP is `img-src 'self' data: file:` so remote https images
// would not render; loosening CSP would expose a remote-image attack surface.
// No <table> either (reviews/PRs rarely need tables and the simpler allowlist
// leaves less attack surface).
const ALLOWED_TAGS = [
  'a', 'p', 'br', 'em', 'strong', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'del', 's',
]
const ALLOWED_ATTR = ['href', 'title']

export function renderCommentMarkdown(md: string): string {
  if (typeof md !== 'string') return ''
  const raw = marked.parse(md) as string
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // https only. `will-navigate` is blocked and `window.open` is denied, so
    // any navigation has to go through `shell.openExternal(https://...)` in
    // main. mailto: / http: / # / javascript: are stripped by this regex.
    ALLOWED_URI_REGEXP: /^https:/i,
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
  })
}
```

- [ ] **Step 4: Add `SanitizedMarkdown` React wrapper**

Spec §9 carves out exactly one audited `dangerouslySetInnerHTML` site per markdown render. This component is that site. No other component in the feature may use `dangerouslySetInnerHTML`.

```tsx
// src/renderer/components/github/SanitizedMarkdown.tsx
import { renderCommentMarkdown } from '../../utils/markdownSanitizer'

/**
 * Single audited render site for sanitized GitHub markdown.
 *
 * Sanitizer output only: never pass user-provided HTML directly.
 * Anchor click routing: renderer blocks `will-navigate` and `window.open`, so
 * raw `<a href>` links would be inert. Delegated onClick intercepts `<a>`
 * clicks, preventDefaults the navigation, validates https-only, and routes
 * through `window.electronAPI.shell.openExternal`.
 */
export function SanitizedMarkdown({ source }: { source: string }) {
  const html = renderCommentMarkdown(source)
  return (
    <div
      className="prose prose-invert text-sm max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const target = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null
        if (!target) return
        e.preventDefault()
        const href = target.getAttribute('href') ?? ''
        if (/^https:/i.test(href)) {
          window.electronAPI.shell.openExternal(href)
        }
        // non-https anchors are inert by design; sanitizer strips them anyway.
      }}
    />
  )
}
```

- [ ] **Step 5: Run + commit**

```bash
npx vitest run tests/unit/github/markdown-sanitizer.test.ts
git add src/renderer/utils/markdownSanitizer.ts \
        src/renderer/components/github/SanitizedMarkdown.tsx \
        tests/unit/github/markdown-sanitizer.test.ts
git commit -m "feat(github): markdown sanitizer + SanitizedMarkdown render site (https-only, CSP-safe)"
```

---

### Task I3: Relative-time helper (skip if already exists)

**Files:** CREATE `src/renderer/utils/relativeTime.ts` (if not present).

- [ ] **Step 1: Check for existing**

```bash
grep -rn "relativeTime\|formatRelative" src/renderer/utils 2>/dev/null
```
If an existing helper covers ms-precision "Xs ago", skip this task.

- [ ] **Step 2: Implement**

```ts
// src/renderer/utils/relativeTime.ts
export function relativeTime(at: number, now = Date.now()): string {
  const diffSec = Math.round((now - at) / 1000)
  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const min = Math.round(diffSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.round(hr / 24)
  return `${d}d ago`
}
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/utils/relativeTime.ts
git commit -m "feat(github): relative-time helper"
```

---

## Phase J — Config Page (GitHub tab)

### Task J1: GitHubConfigTab skeleton + register in SettingsPage

**Files:** CREATE `src/renderer/components/github/config/GitHubConfigTab.tsx` + stub sub-components (so the page mounts cleanly); MODIFY `src/renderer/components/SettingsPage.tsx`.

- [ ] **Step 1: Create stub sub-components**

One file each at `src/renderer/components/github/config/`:
- `AuthProfilesList.tsx` → `export default function AuthProfilesList() { return <div>profiles</div> }`
- `FeatureTogglesList.tsx` → stub
- `PermissionsSummary.tsx` → stub
- `PrivacySettings.tsx` → stub
- `SyncSettings.tsx` → stub

- [ ] **Step 2: Create GitHubConfigTab**

```tsx
// src/renderer/components/github/config/GitHubConfigTab.tsx
import React, { useEffect } from 'react'
import { useGitHubStore } from '../../../stores/githubStore'
import AuthProfilesList from './AuthProfilesList'
import FeatureTogglesList from './FeatureTogglesList'
import PermissionsSummary from './PermissionsSummary'
import PrivacySettings from './PrivacySettings'
import SyncSettings from './SyncSettings'

export default function GitHubConfigTab() {
  const config = useGitHubStore((s) => s.config)
  const loadConfig = useGitHubStore((s) => s.loadConfig)
  const updateConfig = useGitHubStore((s) => s.updateConfig)

  useEffect(() => { loadConfig() }, [loadConfig])

  if (!config) return <div className="p-6 text-overlay1">Loading GitHub config…</div>

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-lg text-text">GitHub integration</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabledByDefault}
            onChange={(e) => updateConfig({ enabledByDefault: e.target.checked })}
          />
          <span>Enable by default for new sessions</span>
        </label>
      </div>
      <AuthProfilesList />
      <FeatureTogglesList />
      <PermissionsSummary />
      <PrivacySettings />
      <SyncSettings />
      <div className="text-xs text-overlay0 pt-4 border-t border-surface0">
        <strong>No telemetry.</strong> This feature sends no usage data to Anthropic or third parties.
        All requests go to github.com using your configured auth.
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Register in SettingsPage**

Open `src/renderer/components/SettingsPage.tsx`. Find the `SettingsTab` union and `TABS` array (around line 10). Add:

```ts
type SettingsTab = 'general' | 'statusline' | 'shortcuts' | 'about' | 'github'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'statusline', label: 'Status Line' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'github', label: 'GitHub' },
  { id: 'about', label: 'About' },
]
```

And in the tab-switch render block (wherever `activeTab === 'general'` renders the general content), add:

```tsx
import GitHubConfigTab from './github/config/GitHubConfigTab'

// ...render:
{activeTab === 'github' && <GitHubConfigTab />}
```

- [ ] **Step 4: Typecheck + build + commit**

```bash
npm run typecheck
npm run build
git add src/renderer/components/github/config/ src/renderer/components/SettingsPage.tsx
git commit -m "feat(github): config page tab skeleton registered in SettingsPage"
```

---

### Task J2: AuthProfilesList (with profile cards + actions)

**Files:** REPLACE stub `src/renderer/components/github/config/AuthProfilesList.tsx`; CREATE `AddProfileModal.tsx`.

- [ ] **Step 1: AuthProfilesList full implementation**

```tsx
// src/renderer/components/github/config/AuthProfilesList.tsx
import React, { useEffect, useState } from 'react'
import type { AuthProfile } from '../../../../shared/github-types'
import { useGitHubStore } from '../../../stores/githubStore'
import AddProfileModal from './AddProfileModal'

export default function AuthProfilesList() {
  const profiles = useGitHubStore((s) => s.profiles)
  const removeProfile = useGitHubStore((s) => s.removeProfile)
  const renameProfile = useGitHubStore((s) => s.renameProfile)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, string>>({})

  const doTest = async (id: string) => {
    setTesting(id)
    const r = await window.electronAPI.github.testProfile(id)
    setTesting(null)
    setTestResult((prev) => ({
      ...prev,
      [id]: r.ok ? `✓ ${r.username}` : `✗ ${r.error ?? 'error'}`,
    }))
  }

  const startRename = (p: AuthProfile) => {
    setEditingId(p.id)
    setNewLabel(p.label)
  }
  const commitRename = async () => {
    if (editingId) {
      await renameProfile(editingId, newLabel)
      setEditingId(null)
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
          <div key={p.id} className="bg-mantle p-3 rounded flex items-start gap-3">
            {/* Per spec §9 avatar strategy: no remote https <img> under app CSP.
                v1 ships initials-only; avatarUrl is persisted for future main-process
                proxy that converts to data: URLs. */}
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
                <div className="text-xs mt-1" style={{
                  color: testResult[p.id].startsWith('✓') ? 'var(--color-green)' : 'var(--color-red)',
                }}>{testResult[p.id]}</div>
              )}
            </div>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => doTest(p.id)}
                disabled={testing === p.id}
                className="text-xs bg-surface0 hover:bg-surface1 px-2 py-1 rounded"
              >
                {testing === p.id ? '…' : 'Test'}
              </button>
              <button
                onClick={() => startRename(p)}
                className="text-xs bg-surface0 hover:bg-surface1 px-2 py-1 rounded"
              >Rename</button>
              <button
                onClick={() => {
                  if (confirm(`Remove profile "${p.label}"? The token is wiped from keychain.`)) {
                    removeProfile(p.id)
                  }
                }}
                className="text-xs bg-red/20 hover:bg-red/40 text-red px-2 py-1 rounded"
              >Remove</button>
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={() => setAdding(true)}
        className="mt-3 bg-blue text-base px-3 py-1.5 rounded text-sm"
      >Sign in with GitHub / Add auth…</button>
      {adding && <AddProfileModal onClose={() => setAdding(false)} />}
    </section>
  )
}
```

- [ ] **Step 2: AddProfileModal with three paths**

```tsx
// src/renderer/components/github/config/AddProfileModal.tsx
import React, { useEffect, useState } from 'react'
import { useGitHubStore } from '../../../stores/githubStore'
import OAuthDeviceFlow from './OAuthDeviceFlow'

interface Props { onClose: () => void }

export default function AddProfileModal({ onClose }: Props) {
  const loadConfig = useGitHubStore((s) => s.loadConfig)
  const [advanced, setAdvanced] = useState(false)
  const [ghUsers, setGhUsers] = useState<string[]>([])
  const [starting, setStarting] = useState(false)
  const [oauthMode, setOauthMode] = useState<'public' | 'private'>('public')
  const [oauthState, setOauthState] = useState<any>(null)

  const [patKind, setPatKind] = useState<'pat-fine-grained' | 'pat-classic'>('pat-fine-grained')
  const [patToken, setPatToken] = useState('')
  const [patLabel, setPatLabel] = useState('')
  const [patRepos, setPatRepos] = useState('')
  const [patError, setPatError] = useState<string | null>(null)
  const [patSaving, setPatSaving] = useState(false)

  useEffect(() => {
    window.electronAPI.github.ghcliDetect().then((r) => setGhUsers(r.users))
  }, [])

  const startOAuth = async () => {
    setStarting(true)
    const r = await window.electronAPI.github.oauthStart(oauthMode)
    setStarting(false)
    setOauthState(r)
  }

  const adoptGh = async (username: string) => {
    const r = await window.electronAPI.github.adoptGhCli(username)
    if (r.ok) {
      await loadConfig()
      onClose()
    }
  }

  const submitPat = async () => {
    setPatSaving(true)
    setPatError(null)
    const repos = patRepos.split(/[\s,]+/).filter(Boolean)
    const r = await window.electronAPI.github.addPat({
      kind: patKind,
      label: patLabel || 'PAT',
      rawToken: patToken,
      allowedRepos: patKind === 'pat-fine-grained' && repos.length > 0 ? repos : undefined,
    })
    setPatSaving(false)
    if (r.ok) {
      await loadConfig()
      onClose()
    } else {
      setPatError(r.error ?? 'error')
    }
  }

  if (oauthState) {
    return (
      <OAuthDeviceFlow
        flow={oauthState}
        onDone={async () => { await loadConfig(); onClose() }}
        onCancel={() => setOauthState(null)}
      />
    )
  }

  return (
    <div className="fixed inset-0 bg-base/80 z-50 flex items-center justify-center" role="dialog" aria-modal="true">
      <div className="bg-mantle p-6 rounded max-w-md w-full">
        <h3 className="text-lg mb-3 text-text">Add GitHub auth</h3>

        <div className="mb-3">
          <label className="text-xs text-subtext0 block mb-1">Scope mode</label>
          <div className="flex gap-2">
            <button
              onClick={() => setOauthMode('public')}
              className={`text-xs px-3 py-1 rounded ${oauthMode === 'public' ? 'bg-blue text-base' : 'bg-surface0'}`}
            >Public repos only (safer)</button>
            <button
              onClick={() => setOauthMode('private')}
              className={`text-xs px-3 py-1 rounded ${oauthMode === 'private' ? 'bg-blue text-base' : 'bg-surface0'}`}
            >Include private repos</button>
          </div>
        </div>

        <button
          onClick={startOAuth}
          disabled={starting}
          className="w-full bg-blue text-base px-3 py-2 rounded mb-4"
        >
          {starting ? 'Starting…' : 'Sign in with GitHub'}
        </button>

        <button
          onClick={() => setAdvanced(!advanced)}
          className="text-xs text-subtext0 mb-2"
        >
          {advanced ? '▼' : '▶'} Advanced auth options
        </button>

        {advanced && (
          <div className="space-y-4">
            {ghUsers.length > 0 && (
              <div>
                <div className="text-xs text-subtext0 mb-1">`gh` CLI accounts detected</div>
                {ghUsers.map((u) => (
                  <button
                    key={u}
                    onClick={() => adoptGh(u)}
                    className="block w-full text-left text-sm bg-surface0 hover:bg-surface1 p-2 rounded mb-1"
                  >Use <strong>{u}</strong></button>
                ))}
              </div>
            )}

            <div>
              <div className="text-xs text-subtext0 mb-1">Paste a PAT</div>
              <select
                value={patKind}
                onChange={(e) => setPatKind(e.target.value as any)}
                className="bg-surface0 p-1 rounded text-sm mb-2"
              >
                <option value="pat-fine-grained">Fine-grained PAT</option>
                <option value="pat-classic">Classic PAT</option>
              </select>
              <input
                placeholder="Label (e.g., work)"
                value={patLabel}
                onChange={(e) => setPatLabel(e.target.value)}
                className="w-full bg-surface0 p-2 rounded text-sm mb-2"
              />
              <input
                type="password"
                placeholder="Token"
                value={patToken}
                onChange={(e) => setPatToken(e.target.value)}
                className="w-full bg-surface0 p-2 rounded text-sm mb-2 font-mono"
              />
              {patKind === 'pat-fine-grained' && (
                <input
                  placeholder="Allowed repos (owner/repo, comma or space separated)"
                  value={patRepos}
                  onChange={(e) => setPatRepos(e.target.value)}
                  className="w-full bg-surface0 p-2 rounded text-sm mb-2"
                />
              )}
              {patError && <div className="text-xs text-red mb-2">{patError}</div>}
              <button
                onClick={submitPat}
                disabled={patSaving || !patToken}
                className="bg-blue text-base px-3 py-1 rounded text-sm"
              >{patSaving ? 'Verifying…' : 'Save PAT'}</button>
            </div>
          </div>
        )}

        <button onClick={onClose} className="mt-4 text-xs text-subtext0">Close</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: OAuthDeviceFlow component with polling lifecycle**

```tsx
// src/renderer/components/github/config/OAuthDeviceFlow.tsx
import React, { useEffect, useRef, useState } from 'react'

interface Props {
  flow: { flowId: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }
  onDone: () => void
  onCancel: () => void
}

export default function OAuthDeviceFlow({ flow, onDone, onCancel }: Props) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollingRef = useRef(true)

  useEffect(() => {
    let cancelled = false
    async function pollLoop() {
      while (!cancelled && pollingRef.current) {
        await new Promise((r) => setTimeout(r, (flow.interval + 1) * 1000))
        if (cancelled || !pollingRef.current) break
        try {
          const r = await window.electronAPI.github.oauthPoll(flow.flowId)
          if (r.ok && r.profileId) {
            onDone()
            return
          }
          if (!r.ok && r.error && r.error !== 'pending') {
            setError(r.error)
            return
          }
        } catch (e) {
          setError(String(e))
          return
        }
      }
    }
    pollLoop()
    return () => {
      cancelled = true
      pollingRef.current = false
    }
  }, [flow.flowId, flow.interval, onDone])

  const copy = async () => {
    await navigator.clipboard.writeText(flow.userCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const openGitHub = () => {
    // App denies window.open via setWindowOpenHandler; use shell.openExternal instead
    void window.electronAPI.shell.openExternal(flow.verificationUri)
  }

  const cancel = async () => {
    pollingRef.current = false
    await window.electronAPI.github.oauthCancel(flow.flowId)
    onCancel()
  }

  return (
    <div className="fixed inset-0 bg-base/80 z-50 flex items-center justify-center" role="dialog" aria-modal="true">
      <div className="bg-mantle p-6 rounded max-w-md w-full">
        <h3 className="text-lg mb-3 text-text">Sign in with GitHub</h3>
        <p className="text-sm text-subtext0 mb-4">
          Open <code className="bg-surface0 px-1 rounded">{flow.verificationUri}</code> and enter this code:
        </p>
        <div className="flex items-center gap-3 bg-surface0 p-4 rounded mb-4">
          <code className="text-xl text-text font-mono tracking-wider flex-1 text-center">{flow.userCode}</code>
          <button onClick={copy} className="bg-surface1 px-2 py-1 rounded text-xs">
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="flex gap-2">
          <button onClick={openGitHub} className="bg-blue text-base px-3 py-1.5 rounded text-sm flex-1">
            Open GitHub
          </button>
          <button onClick={cancel} className="bg-surface0 px-3 py-1.5 rounded text-sm">Cancel</button>
        </div>
        <div className="text-xs text-overlay1 mt-3">
          Waiting for you to complete auth in the browser…
        </div>
        {error && <div className="text-xs text-red mt-2">Error: {error}</div>}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Typecheck + build + commit**

```bash
npm run typecheck
npm run build
git add src/renderer/components/github/config/AuthProfilesList.tsx src/renderer/components/github/config/AddProfileModal.tsx src/renderer/components/github/config/OAuthDeviceFlow.tsx
git commit -m "feat(github): auth profiles list + add-profile modal + OAuth device flow UI"
```

---

### Task J3: FeatureTogglesList (availability-aware)

**Files:** REPLACE stub `FeatureTogglesList.tsx`.

- [ ] **Step 1: Implement**

```tsx
// src/renderer/components/github/config/FeatureTogglesList.tsx
import React from 'react'
import type { Capability, GitHubFeatureKey } from '../../../../shared/github-types'
import { useGitHubStore } from '../../../stores/githubStore'

interface FeatureDef {
  key: GitHubFeatureKey
  label: string
  description: string
  requiredCapabilities: Capability[]
}

const FEATURES: FeatureDef[] = [
  { key: 'activePR', label: 'Active PR card',
    description: 'PR for your branch with CI, reviews, merge state.',
    requiredCapabilities: ['pulls'] },
  { key: 'ci', label: 'CI / Actions',
    description: 'Workflow runs, logs, re-run failed jobs.',
    requiredCapabilities: ['actions'] },
  { key: 'reviews', label: 'Reviews & comments',
    description: 'Threaded review comments with reply.',
    requiredCapabilities: ['pulls'] },
  { key: 'linkedIssues', label: 'Linked issues',
    description: 'Issues linked by PR body, branch, or transcript.',
    requiredCapabilities: ['issues'] },
  { key: 'notifications', label: 'Notifications inbox',
    description: 'Review requests, mentions, assignments.',
    requiredCapabilities: ['notifications'] },
  { key: 'localGit', label: 'Local git state',
    description: 'Dirty files, ahead/behind, recent commits (no auth needed).',
    requiredCapabilities: [] },
  { key: 'sessionContext', label: 'Session context',
    description: "What this session is working on right now.",
    requiredCapabilities: [] },
]

export default function FeatureTogglesList() {
  const config = useGitHubStore((s) => s.config)
  const profiles = useGitHubStore((s) => s.profiles)
  const updateConfig = useGitHubStore((s) => s.updateConfig)

  if (!config) return null

  const availableCaps = new Set<Capability>()
  for (const p of profiles) for (const c of p.capabilities) availableCaps.add(c)

  // Reconcile persisted toggle state with current capability availability.
  // If a feature's capabilities became unreachable (profile removed, scopes
  // narrowed, etc.), force the stored toggle to false so config, UI, and
  // PermissionsSummary stay consistent. Fires as an effect so it persists,
  // not just a render-time mask.
  useEffect(() => {
    if (!config) return
    const fixed: Record<string, boolean> = { ...config.featureToggles }
    let changed = false
    for (const f of FEATURES) {
      const unavailable = f.requiredCapabilities.some((c) => !availableCaps.has(c))
      if (unavailable && fixed[f.key]) {
        fixed[f.key] = false
        changed = true
      }
    }
    if (changed) updateConfig({ featureToggles: fixed })
  }, [config?.featureToggles, profiles])

  return (
    <section>
      <h3 className="text-sm uppercase text-subtext0 mb-3">Features</h3>
      <div className="space-y-2">
        {FEATURES.map((f) => {
          const unavailable = f.requiredCapabilities.some((c) => !availableCaps.has(c))
          // enabled is gated on availability — a disabled+unavailable toggle
          // never persists as true thanks to the reconcile effect above.
          const enabled = !unavailable && !!config.featureToggles[f.key]
          return (
            <div key={f.key} className="bg-mantle p-3 rounded flex items-start gap-3" style={{ opacity: unavailable ? 0.6 : 1 }}>
              <input
                type="checkbox"
                disabled={unavailable}
                checked={enabled}
                onChange={(e) => {
                  if (unavailable) return // defensive — input is disabled but belt-and-braces
                  updateConfig({
                    featureToggles: { ...config.featureToggles, [f.key]: e.target.checked },
                  })
                }}
                className="mt-1"
                aria-label={f.label}
              />
              <div className="flex-1">
                <div className="text-text text-sm">{f.label}</div>
                <div className="text-xs text-subtext0">{f.description}</div>
                <div className="text-xs text-overlay1 mt-1">
                  {f.requiredCapabilities.length === 0
                    ? 'No auth needed'
                    : `Needs: ${f.requiredCapabilities.join(', ')}`}
                </div>
                {unavailable && (
                  <div className="text-xs text-yellow mt-1" role="note">
                    Add an auth profile with {f.requiredCapabilities.join(' + ')} capability to enable.
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Commit**

```bash
npm run typecheck
git add src/renderer/components/github/config/FeatureTogglesList.tsx
git commit -m "feat(github): feature toggles list (disabled when capability missing)"
```

---

### Task J4: PermissionsSummary (live derivation)

**Files:** REPLACE stub `PermissionsSummary.tsx`.

- [ ] **Step 1: Implement**

```tsx
// src/renderer/components/github/config/PermissionsSummary.tsx
import React, { useState } from 'react'
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

// Minimum scopes per auth kind to achieve the capability set.
// `mode` matches the Tier 2 device flow split from spec §2: public-repo
// default asks for `public_repo`; private-repo mode asks for `repo`.
// PermissionsSummary renders BOTH variants so the user can see which
// scope list matches their repo visibility.
function capsToOAuthScopes(
  caps: Set<Capability>,
  mode: 'public' | 'private',
): string[] {
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
    await navigator.clipboard.writeText(scopes.join(' '))
    setCopied(which)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <section>
      <h3 className="text-sm uppercase text-subtext0 mb-3">Permissions you'd need</h3>
      <div className="bg-mantle p-3 rounded text-sm space-y-3">
        <div>
          <div className="text-subtext0 text-xs mb-1">OAuth / Classic PAT scopes — public repos only</div>
          <code className="text-blue">{oauthPublic.join(' ') || '(none — local only)'}</code>
          {oauthPublic.length > 0 && (
            <button onClick={() => copyScopes(oauthPublic, 'public')} className="ml-3 text-xs bg-surface0 px-2 py-0.5 rounded">
              {copied === 'public' ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>
        <div>
          <div className="text-subtext0 text-xs mb-1">OAuth / Classic PAT scopes — includes private repos</div>
          <code className="text-blue">{oauthPrivate.join(' ') || '(none — local only)'}</code>
          {oauthPrivate.length > 0 && (
            <button onClick={() => copyScopes(oauthPrivate, 'private')} className="ml-3 text-xs bg-surface0 px-2 py-0.5 rounded">
              {copied === 'private' ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>
        <div>
          <div className="text-subtext0 text-xs mb-1">Fine-grained PAT permissions</div>
          {fine.length === 0
            ? <code className="text-overlay1">(none — local only)</code>
            : <ul className="text-xs text-subtext0 list-disc ml-4">{fine.map((f, i) => <li key={i}>{f}</li>)}</ul>}
        </div>
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Commit**

```bash
npm run typecheck
git add src/renderer/components/github/config/PermissionsSummary.tsx
git commit -m "feat(github): live permissions summary derived from enabled features"
```

---

### Task J5: PrivacySettings

**Files:** REPLACE stub `PrivacySettings.tsx`.

```tsx
// src/renderer/components/github/config/PrivacySettings.tsx
import React from 'react'
import { useGitHubStore } from '../../../stores/githubStore'

export default function PrivacySettings() {
  const config = useGitHubStore((s) => s.config)
  const updateConfig = useGitHubStore((s) => s.updateConfig)
  if (!config) return null

  return (
    <section>
      <h3 className="text-sm uppercase text-subtext0 mb-3">Privacy</h3>
      <div className="bg-mantle p-3 rounded">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.transcriptScanningOptIn}
            onChange={(e) => updateConfig({ transcriptScanningOptIn: e.target.checked })}
            className="mt-1"
          />
          <div>
            <div className="text-text">Scan this session's Claude conversation for issue/PR references</div>
            <div className="text-xs text-subtext0 mt-1">
              When on, we read the last 50 user/assistant messages for patterns like <code>#247</code>,
              <code>GH-247</code>, and github.com URLs. <strong>Matches are rendered as plain reference text only</strong> —
              message bodies are never shown in the panel. Scanning is local; nothing is sent to GitHub.
              Default: off.
            </div>
          </div>
        </label>
      </div>
    </section>
  )
}
```

Commit:
```bash
npm run typecheck
git add src/renderer/components/github/config/PrivacySettings.tsx
git commit -m "feat(github): privacy settings (transcript scanning opt-in)"
```

---

### Task J6: SyncSettings

**Files:** REPLACE stub `SyncSettings.tsx`.

```tsx
// src/renderer/components/github/config/SyncSettings.tsx
import React, { useState } from 'react'
import { useGitHubStore } from '../../../stores/githubStore'

const OPTS_FAST = [30, 60, 120, 300]
const OPTS_SLOW = [120, 300, 600, 900]
const OPTS_NOTIF = [60, 180, 300, 600]

function fmt(s: number): string {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

export default function SyncSettings() {
  const config = useGitHubStore((s) => s.config)
  const updateConfig = useGitHubStore((s) => s.updateConfig)
  const [lastClick, setLastClick] = useState(0)
  if (!config) return null

  const setInt = (k: keyof typeof config.syncIntervals, v: number) =>
    updateConfig({ syncIntervals: { ...config.syncIntervals, [k]: v } })

  const syncActiveNow = async () => {
    if (Date.now() - lastClick < 5000) return
    setLastClick(Date.now())
    // Active session id is not known to this component; use the dedicated
    // "sync focused session" IPC so main resolves it explicitly. Avoids
    // an ambiguous empty-string sentinel on the per-session syncNow channel.
    await window.electronAPI.github.syncFocusedNow()
  }

  return (
    <section>
      <h3 className="text-sm uppercase text-subtext0 mb-3">Sync</h3>
      <div className="bg-mantle p-3 rounded space-y-3 text-sm">
        <label className="flex items-center justify-between">
          <span>Active session</span>
          <select
            className="bg-surface0 p-1 rounded"
            value={config.syncIntervals.activeSessionSec}
            onChange={(e) => setInt('activeSessionSec', Number(e.target.value))}
          >
            {OPTS_FAST.map((s) => <option key={s} value={s}>{fmt(s)}</option>)}
          </select>
        </label>
        <label className="flex items-center justify-between">
          <span>Background sessions</span>
          <select
            className="bg-surface0 p-1 rounded"
            value={config.syncIntervals.backgroundSec}
            onChange={(e) => setInt('backgroundSec', Number(e.target.value))}
          >
            {OPTS_SLOW.map((s) => <option key={s} value={s}>{fmt(s)}</option>)}
          </select>
        </label>
        <label className="flex items-center justify-between">
          <span>Notifications</span>
          <select
            className="bg-surface0 p-1 rounded"
            value={config.syncIntervals.notificationsSec}
            onChange={(e) => setInt('notificationsSec', Number(e.target.value))}
          >
            {OPTS_NOTIF.map((s) => <option key={s} value={s}>{fmt(s)}</option>)}
          </select>
        </label>
        <div className="flex gap-2 pt-2 border-t border-surface0">
          <button
            onClick={() => window.electronAPI.github.syncPause()}
            className="bg-surface0 px-3 py-1 rounded text-xs"
          >Pause syncs</button>
          <button
            onClick={() => window.electronAPI.github.syncResume()}
            className="bg-surface0 px-3 py-1 rounded text-xs"
          >Resume</button>
          <button
            onClick={syncActiveNow}
            className="bg-blue text-base px-3 py-1 rounded text-xs"
          >Sync active now</button>
        </div>
      </div>
    </section>
  )
}
```

Commit:
```bash
npm run typecheck
git add src/renderer/components/github/config/SyncSettings.tsx
git commit -m "feat(github): sync settings (interval dropdowns + pause/resume/sync-now)"
```

---

## Phase K — Per-session GitHub config

### Task K1: parseRepoUrlClient (validates client-side)

**Files:** CREATE `src/renderer/components/session/parseRepoUrlClient.ts`, test.

- [ ] **Step 1: Test**

```ts
// tests/unit/github/parseRepoUrlClient.test.ts
import { describe, it, expect } from 'vitest'
import { parseRepoUrlClient } from '../../../src/renderer/components/session/parseRepoUrlClient'

describe('parseRepoUrlClient', () => {
  it('parses HTTPS', () => {
    expect(parseRepoUrlClient('https://github.com/a/b')).toBe('a/b')
  })
  it('parses SSH', () => {
    expect(parseRepoUrlClient('git@github.com:a/b.git')).toBe('a/b')
  })
  it('rejects invalid owner', () => {
    expect(parseRepoUrlClient('https://github.com/-bad/b')).toBeUndefined()
  })
  it('rejects . and .. as repo names', () => {
    expect(parseRepoUrlClient('https://github.com/a/.')).toBeUndefined()
    expect(parseRepoUrlClient('https://github.com/a/..')).toBeUndefined()
  })
  it('returns undefined on non-github', () => {
    expect(parseRepoUrlClient('https://gitlab.com/a/b')).toBeUndefined()
  })
  it('returns undefined on empty', () => {
    expect(parseRepoUrlClient('')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Implement**

```ts
// src/renderer/components/session/parseRepoUrlClient.ts
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const REPO_RE = /^[A-Za-z0-9._-]+$/
const HTTPS_RE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i
const SSH_RE = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i

export function parseRepoUrlClient(raw: string): string | undefined {
  const s = (raw ?? '').trim()
  if (!s) return undefined
  const m = s.match(HTTPS_RE) ?? s.match(SSH_RE)
  if (!m) return undefined
  const [, owner, repo] = m
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') {
    return undefined
  }
  return `${owner}/${repo}`
}
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/unit/github/parseRepoUrlClient.test.ts
git add src/renderer/components/session/parseRepoUrlClient.ts tests/unit/github/parseRepoUrlClient.test.ts
git commit -m "feat(github): client-side repo URL parser (validates to GitHub rules)"
```

---

### Task K2: SessionGitHubConfig drawer tab

**Files:** CREATE `src/renderer/components/session/SessionGitHubConfig.tsx`. Integrate with the existing session config UI.

- [ ] **Step 1: Read existing session config structure**

```bash
grep -rn "session.*config\|SessionConfigDrawer\|SessionSettings" src/renderer/components --include="*.tsx" -l | head -5
```
Open the identified file(s). Note the tab/section pattern the project uses for per-session settings.

- [ ] **Step 2: Create the component**

```tsx
// src/renderer/components/session/SessionGitHubConfig.tsx
import React, { useEffect, useState } from 'react'
import { useGitHubStore } from '../../stores/githubStore'
import { parseRepoUrlClient } from './parseRepoUrlClient'
import type { SessionGitHubIntegration } from '../../../shared/github-types'

interface Props {
  sessionId: string
  cwd: string
  initial?: SessionGitHubIntegration
}

export default function SessionGitHubConfig({ sessionId, cwd, initial }: Props) {
  const config = useGitHubStore((s) => s.config)
  const profiles = useGitHubStore((s) => s.profiles)
  const [enabled, setEnabled] = useState(initial?.enabled ?? config?.enabledByDefault ?? false)
  const [repoUrl, setRepoUrl] = useState(initial?.repoUrl ?? '')
  const [profileId, setProfileId] = useState(initial?.authProfileId ?? '')
  const [detected, setDetected] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!initial?.repoUrl && cwd) {
      window.electronAPI.github.repoDetect(cwd).then((r) => {
        if (r.ok && r.slug) setDetected(r.slug)
      })
    }
  }, [cwd, initial?.repoUrl])

  const slug = parseRepoUrlClient(repoUrl)

  const save = async () => {
    setSaving(true)
    const patch: Partial<SessionGitHubIntegration> = {
      enabled,
      repoUrl: repoUrl || undefined,
      repoSlug: slug,
      authProfileId: profileId || undefined,
      autoDetected: false,
    }
    const r = await window.electronAPI.github.updateSessionConfig(sessionId, patch)
    setSaving(false)
    setTestResult(r.ok ? 'Saved ✓' : `Error: ${r.error ?? 'unknown'}`)
    setTimeout(() => setTestResult(null), 2000)
  }

  const useDetected = () => {
    if (detected) setRepoUrl(`https://github.com/${detected}`)
  }

  // Auto-match profile by owner
  useEffect(() => {
    if (profileId || !slug) return
    const [owner] = slug.split('/')
    const match = profiles.find((p) =>
      p.allowedRepos?.includes(slug) ||
      p.username.toLowerCase() === owner.toLowerCase(),
    )
    if (match) setProfileId(match.id)
  }, [slug, profileId, profiles])

  return (
    <div className="space-y-3 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Enable GitHub integration for this session</span>
      </label>

      {detected && !repoUrl && (
        <div className="bg-mantle p-2 rounded text-xs">
          Detected <strong>{detected}</strong>.{' '}
          <button onClick={useDetected} className="text-blue underline">Use this</button>
        </div>
      )}

      <label className="block">
        <div className="text-xs text-subtext0 mb-1">Repo URL</div>
        <input
          type="text"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          className="w-full bg-surface0 p-2 rounded text-sm font-mono"
          placeholder="https://github.com/owner/repo"
        />
        {repoUrl && !slug && (
          <div className="text-xs text-red mt-1">Invalid GitHub URL</div>
        )}
      </label>

      <label className="block">
        <div className="text-xs text-subtext0 mb-1">Auth profile</div>
        <select
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
          className="w-full bg-surface0 p-2 rounded text-sm"
        >
          <option value="">(auto — capability routing)</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.label} ({p.username})</option>
          ))}
        </select>
      </label>

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving || (!!repoUrl && !slug)}
          className="bg-blue text-base px-3 py-1 rounded text-sm"
        >{saving ? 'Saving…' : 'Save'}</button>
        {testResult && <span className="text-xs text-overlay1 self-center">{testResult}</span>}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Integrate**

Open the identified session-config drawer file. Add a new section/tab (following the existing pattern) that renders:

```tsx
import SessionGitHubConfig from './session/SessionGitHubConfig'

// Inside the tab render block:
<SessionGitHubConfig
  sessionId={session.id}
  cwd={session.cwd ?? session.workingDir ?? ''}
  initial={session.githubIntegration}
/>
```

Adjust prop names (`cwd`/`workingDir`) to match the actual `SavedSession` shape.

- [ ] **Step 4: Typecheck + build + commit**

```bash
npm run typecheck
npm run build
git add src/renderer/components/session/SessionGitHubConfig.tsx [drawer-file-you-edited]
git commit -m "feat(github): per-session GitHub config panel with repo auto-detect"
```

---

## Phase L — Panel Shell (no populated sections yet)

### Task L1: SectionFrame

**Files:** CREATE `src/renderer/components/github/SectionFrame.tsx`.

```tsx
// src/renderer/components/github/SectionFrame.tsx
import React from 'react'
import { useGitHubStore } from '../../stores/githubStore'

interface Props {
  sessionId: string
  id: string
  title: string
  summary?: React.ReactNode
  rightAction?: React.ReactNode
  emptyIndicator?: boolean
  defaultCollapsed?: boolean
  children: React.ReactNode
}

export default function SectionFrame({
  sessionId, id, title, summary, rightAction, emptyIndicator, defaultCollapsed, children,
}: Props) {
  const saved = useGitHubStore((s) => s.sessionStates[sessionId]?.collapsedSections[id])
  const collapsed = saved ?? defaultCollapsed ?? false
  const setCollapsed = useGitHubStore((s) => s.setSectionCollapsed)

  return (
    <section className="border-b border-surface0" data-section-id={id}>
      <button
        aria-expanded={!collapsed}
        aria-controls={`sec-body-${id}`}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface0/50 focus:outline focus:outline-2 focus:outline-blue"
        onClick={() => setCollapsed(sessionId, id, !collapsed)}
      >
        <span className="text-xs text-mauve w-3" aria-hidden="true">{collapsed ? '▶' : '▼'}</span>
        <span className="text-xs font-medium uppercase text-subtext0 tracking-wide">{title}</span>
        {summary && <span className="text-xs text-overlay1 ml-2 truncate">{summary}</span>}
        {/* Group right-side items into a single container so `ml-auto` applies
            once and emptyIndicator + rightAction can coexist without reflow. */}
        {(emptyIndicator || rightAction) && (
          <span className="ml-auto flex items-center gap-2 shrink-0">
            {emptyIndicator && <span className="text-xs text-overlay0" aria-label="empty">—</span>}
            {rightAction && <span>{rightAction}</span>}
          </span>
        )}
      </button>
      {!collapsed && <div id={`sec-body-${id}`} className="px-3 pb-3">{children}</div>}
    </section>
  )
}
```

Commit:
```bash
npm run typecheck
git add src/renderer/components/github/SectionFrame.tsx
git commit -m "feat(github): SectionFrame (reusable collapsible section with a11y)"
```

---

### Task L2: PanelHeader

**Files:** CREATE `src/renderer/components/github/PanelHeader.tsx`.

```tsx
// src/renderer/components/github/PanelHeader.tsx
import React from 'react'
import { relativeTime } from '../../utils/relativeTime'

interface Props {
  branch?: string
  ahead?: number
  behind?: number
  dirty?: number
  syncState: 'idle' | 'syncing' | 'synced' | 'rate-limited' | 'error'
  syncedAt?: number
  nextResetAt?: number
  onRefresh: () => void
}

export default function PanelHeader({
  branch, ahead, behind, dirty, syncState, syncedAt, nextResetAt, onRefresh,
}: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-surface0 bg-mantle">
      {branch && (
        <span className="text-sm bg-surface0 px-2 py-0.5 rounded truncate max-w-[60%]" title={branch}>
          {branch}
        </span>
      )}
      {typeof ahead === 'number' && ahead > 0 && <span className="text-green text-xs">↑{ahead}</span>}
      {typeof behind === 'number' && behind > 0 && <span className="text-teal text-xs">↓{behind}</span>}
      {typeof dirty === 'number' && dirty > 0 && <span className="text-peach text-xs">●{dirty}</span>}

      <span className="ml-auto text-xs" aria-live="polite">
        {syncState === 'idle' && <span className="text-overlay0">idle</span>}
        {syncState === 'syncing' && <span className="text-yellow">● syncing</span>}
        {syncState === 'synced' && syncedAt && <span className="text-green">🟢 {relativeTime(syncedAt)}</span>}
        {syncState === 'rate-limited' && (
          <span className="text-yellow" title={nextResetAt ? `resets at ${new Date(nextResetAt).toLocaleTimeString()}` : undefined}>
            🟡 rate limited
          </span>
        )}
        {syncState === 'error' && <span className="text-red">🔴 error</span>}
      </span>
      <button onClick={onRefresh} title="Refresh" aria-label="Refresh" className="text-overlay1 hover:text-text">⟳</button>
    </div>
  )
}
```

Commit:
```bash
npm run typecheck
git add src/renderer/components/github/PanelHeader.tsx
git commit -m "feat(github): PanelHeader with branch chip + ahead/behind + sync indicator"
```

---

### Task L3: Section stubs (8 of them)

**Files:** CREATE 8 files under `src/renderer/components/github/sections/`. Each is a stub that renders SectionFrame with "TODO" body — PR 3 will fill them in.

- [ ] **Step 1: Create stubs**

Each file follows this pattern. File name + title only vary.

```tsx
// src/renderer/components/github/sections/LocalGitSection.tsx
import React from 'react'
import SectionFrame from '../SectionFrame'

interface Props { sessionId: string }

export default function LocalGitSection({ sessionId }: Props) {
  return (
    <SectionFrame sessionId={sessionId} id="localGit" title="Local Git" emptyIndicator>
      <div className="text-xs text-overlay0">Populated in PR 3</div>
    </SectionFrame>
  )
}
```

Repeat for each:
- `SessionContextSection.tsx` → title `"Session Context"`, id `"sessionContext"`
- `ActivePRSection.tsx` → `"Active PR"`, `"activePR"`
- `CISection.tsx` → `"CI / Actions"`, `"ci"`
- `ReviewsSection.tsx` → `"Reviews & Comments"`, `"reviews"`
- `IssuesSection.tsx` → `"Issues"`, `"issues"`
- `NotificationsSection.tsx` → `"Notifications"`, `"notifications"`
- `AgentIntentSection.tsx` → `"Agent Intent"`, `"agentIntent"` with body `<div className="text-xs text-overlay0 italic">Deferred — activates with HTTP Hooks Gateway</div>`

- [ ] **Step 2: Commit**

```bash
npm run typecheck
git add src/renderer/components/github/sections/
git commit -m "feat(github): section stubs (bodies populated in PR 3)"
```

---

### Task L4: GitHubPanel shell

**Files:** CREATE `src/renderer/components/github/GitHubPanel.tsx`.

```tsx
// src/renderer/components/github/GitHubPanel.tsx
import React, { useEffect, useState } from 'react'
import { useGitHubStore } from '../../stores/githubStore'
import PanelHeader from './PanelHeader'
import SessionContextSection from './sections/SessionContextSection'
import ActivePRSection from './sections/ActivePRSection'
import CISection from './sections/CISection'
import ReviewsSection from './sections/ReviewsSection'
import IssuesSection from './sections/IssuesSection'
import LocalGitSection from './sections/LocalGitSection'
import NotificationsSection from './sections/NotificationsSection'
import AgentIntentSection from './sections/AgentIntentSection'

interface Props {
  sessionId: string
  slug?: string
  branch?: string
  ahead?: number
  behind?: number
  dirty?: number
}

export default function GitHubPanel({ sessionId, slug, branch, ahead, behind, dirty }: Props) {
  const visible = useGitHubStore((s) => s.panelVisible)
  const togglePanel = useGitHubStore((s) => s.togglePanel)
  const sessionState = useGitHubStore((s) => s.sessionStates[sessionId])
  const setPanelWidth = useGitHubStore((s) => s.setPanelWidth)
  const sync = useGitHubStore((s) => (slug ? s.syncStatus[slug] : undefined))
  const width = sessionState?.panelWidth ?? 340

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = (window as any).electronPlatform === 'darwin'
      if (e.key === '/' && (isMac ? e.metaKey : e.ctrlKey)) {
        e.preventDefault()
        togglePanel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePanel])

  // Drag to resize
  const startResize = (e: React.PointerEvent) => {
    const startX = e.clientX
    const startW = width
    const onMove = (ev: PointerEvent) => {
      const newW = Math.max(280, Math.min(520, startW - (ev.clientX - startX)))
      setPanelWidth(sessionId, newW)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  if (!visible) {
    return (
      <aside className="w-7 bg-mantle border-l border-surface0 flex flex-col items-center py-3" aria-label="GitHub panel (collapsed)">
        <button
          onClick={togglePanel}
          title={`Show GitHub panel (${window.electronPlatform === 'darwin' ? '⌘+/' : 'Ctrl+/'})`}
          className="text-subtext0 text-xs"
        >GH</button>
      </aside>
    )
  }

  return (
    <aside
      className="bg-base border-l border-surface0 flex flex-col relative"
      style={{ width, minWidth: 280 }}
      aria-label="GitHub panel"
    >
      <div
        onPointerDown={startResize}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-surface1"
        aria-hidden="true"
      />
      <PanelHeader
        branch={branch}
        ahead={ahead}
        behind={behind}
        dirty={dirty}
        syncState={sync?.state ?? 'idle'}
        syncedAt={sync?.at}
        nextResetAt={sync?.nextResetAt}
        onRefresh={() => slug && window.electronAPI.github.syncNow(sessionId)}
      />
      <div className="flex-1 overflow-y-auto" aria-live="polite">
        <SessionContextSection sessionId={sessionId} />
        <ActivePRSection sessionId={sessionId} />
        <CISection sessionId={sessionId} />
        <ReviewsSection sessionId={sessionId} />
        <IssuesSection sessionId={sessionId} />
        <LocalGitSection sessionId={sessionId} />
        <NotificationsSection sessionId={sessionId} />
        <AgentIntentSection sessionId={sessionId} />
      </div>
    </aside>
  )
}
```

Commit:
```bash
npm run typecheck
npm run build
git add src/renderer/components/github/GitHubPanel.tsx
git commit -m "feat(github): GitHubPanel shell with Ctrl+/ toggle and resizable width"
```

---

### Task L5: Mount panel in App.tsx + init listener

**Files:** MODIFY `src/renderer/App.tsx`.

- [ ] **Step 1: Read App.tsx layout**

```bash
grep -n "SessionHeader\|TerminalPane\|return.*flex" src/renderer/App.tsx | head -20
```
Identify the main flex layout and where the terminal content lives.

- [ ] **Step 2: Import + mount + listener init**

Add imports:
```tsx
import GitHubPanel from './components/github/GitHubPanel'
import { setupGitHubListener } from './stores/githubStore'
```

In the app initialization effect (wherever other listeners like tokenomics are set up), add:
```tsx
setupGitHubListener()
```

In the main layout JSX, next to the existing primary terminal pane, add the panel on the right. Only render when a session is active and integration is enabled:

```tsx
{activeSession && activeSession.githubIntegration?.enabled && (
  <GitHubPanel
    sessionId={activeSession.id}
    slug={activeSession.githubIntegration.repoSlug}
    branch={activeSession.currentBranch /* adapt to actual field */}
  />
)}
```

Adjust field names to match the actual `SavedSession` shape.

- [ ] **Step 3: Typecheck + build + smoke test**

```bash
npm run typecheck
npm run build
npm run dev
```
Open dev, confirm: no panel by default; after enabling per-session in the session drawer, panel appears with empty sections. `Ctrl+/` toggles.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(github): mount GitHubPanel + init data/sync listeners"
```

---

## Phase Final

### Task Final.1: Full verification

```bash
npm run typecheck
npx vitest run
npm run build
```
All green.

Smoke in dev:
- Settings → GitHub tab renders
- Add PAT works end-to-end with APP_DEV
- OAuth device flow shows code + waits (do a real sign-in)
- gh CLI detection shows authed accounts
- Enabling integration on a session mounts the panel (empty sections)
- `Ctrl+/` toggles panel

### Task Final.2: Push + open PR

```bash
git fetch origin
git rebase origin/beta
git push -u origin feature/github-sidebar-pr2
gh pr create --base beta --title "feat(github): config UI + panel shell (PR 2/3)" --body "$(cat <<'EOF'
## Summary

- Zustand store (config, profiles, repo data, panel state, sync status)
- Markdown sanitizer (marked + DOMPurify, XSS-covered tests)
- Config page (GitHub tab): profiles list, add-profile modal (OAuth + gh CLI adopt + PAT), feature toggles (disabled when capability missing), permissions summary, privacy + sync settings
- Per-session GitHub config drawer with auto-detected repo + client-side URL validator + auth auto-match
- Panel shell: `SectionFrame`, `PanelHeader`, `GitHubPanel` with `Ctrl+/` toggle + resizable width
- 8 section stubs (populated in PR 3)

## Depends on

PR 1 merged (IPC + types + backend)

## Out of scope (PR 3)

Panel section bodies, sync orchestrator, onboarding modal, SSH repo detection

## Test plan

- [x] Unit tests pass
- [x] Typecheck + build clean
- [ ] Sign in with GitHub via dev build against APP_DEV config → profile appears
- [ ] Adopt `gh` CLI account → profile appears without password
- [ ] Add fine-grained PAT → allowedRepos probed correctly
- [ ] Enable per-session → panel shows empty sections
- [ ] `Ctrl+/` toggles panel
- [ ] Review comment sanitization: `<script>`, `javascript:`, `<img onerror>` all stripped

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Checklist

1. **Depends on PR 1 merged** — all `window.electronAPI.github.*` calls reference IPC channels registered there.
2. **Isomorphic-dompurify installed** in this PR, `marked@15` untouched.
3. **Markdown sanitizer tests cover:** `<script>`, `javascript:`, `<img onerror>`, `onclick`, `data:` URIs.
4. **FeatureTogglesList disables** when capability missing (UX decision from spec §4).
5. **PermissionsSummary** derives scopes from enabled toggles, updates live.
6. **OAuth polling lifecycle**: cleanup on unmount, cancel button, 1-second jitter added to interval (prevents GitHub's "slow_down" false-positive).
7. **Client repo URL parser** independently validates per GitHub rules — no blind trust on server side.
8. **Panel width memory** per session; `Ctrl+/` (Ctrl on Win/Linux, Cmd on Mac).
9. **No `dangerouslySetInnerHTML`** in this PR (introduced in PR 3 only in ReviewsSection, using `renderCommentMarkdown`).

## Execution Handoff

**REQUIRED SUB-SKILL:** `superpowers:subagent-driven-development` (20+ tasks; dispatch one subagent per task).
