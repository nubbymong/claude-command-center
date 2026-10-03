import React, { useEffect, useState, useMemo } from 'react'
import { useMemoryStore, findMemory } from '../stores/memoryStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useProviderAccountsStore, accountDisplayName, providerView, ACCOUNT_NAME_FALLBACK } from '../stores/providerAccountsStore'
import { usesClaude, usesCodex } from '../onboarding/provider-choice'
import { ACCOUNT_MEMORY_DELETE_SHOWN, isAccountMemoryFile } from '../../shared/account-memories'
import type { AccountMemories, AccountMemoryFile } from '../../shared/account-memories'
import type { AccountsSnapshot } from '../../shared/providers'
import type { ProviderId } from '../../shared/types'
import { AccountMemoriesSection } from './memory/AccountMemoriesSection'
import type { LabelledAccountMemories } from './memory/AccountMemoriesSection'
import type { LiveSessionLite } from './memory/live-sessions'
import PageFrame from './PageFrame'
import MemoryKpiRow from './memory/MemoryKpiRow'
import MemoryActivityChart from './memory/MemoryActivityChart'
import MemoryTypeDonut from './memory/MemoryTypeDonut'
import { ProjectsRankedList } from './memory/ProjectsRankedList'
import ProjectDrilldown from './memory/ProjectDrilldown'
import MemoryReadingDrawer from './memory/MemoryReadingDrawer'
import MemorySearchResults from './memory/MemorySearchResults'
import {
  deriveKpis,
  activityBuckets,
  typeCounts,
  indexHealth,
  filterProjects,
  type ScopeFilter,
} from './memory/memory-stats'
import { liveSessionsForProject } from './memory/live-sessions'

/** A provider's name when the accounts snapshot has not named it yet. */
const PROVIDER_NAME_FALLBACK: Readonly<Record<ProviderId, string>> = { claude: 'Claude Code', codex: 'Codex' }

/** The name an account's memories are shown under: the account's own name
 *  as Settings, Accounts shows it. */
function accountMemoryLabel(snapshot: AccountsSnapshot | null, entry: AccountMemories): string {
  const account = snapshot?.accounts.find((a) => a.id === entry.accountId)
  return account ? accountDisplayName(snapshot, account) : ACCOUNT_NAME_FALLBACK
}

const SCOPE_OPTIONS: { label: string; value: ScopeFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Active 30d', value: 'active30d' },
  { label: 'Stale', value: 'stale' },
]

export default function MemoryPage({ onClose, onOpenSessionLogs, onJumpToSession }: {
  onClose?: () => void
  onOpenSessionLogs?: (sessionId: string) => void
  onJumpToSession?: (sessionId: string) => void
}) {
  const {
    projects, memories, accountMemories, loading, error,
    selectedProject, selectedMemoryId, searchQuery, selectedContent,
    scopeFilter, typeFilter, sortBy, sortDir, recentSessions,
    scan, selectProject, selectMemory, setSearch, deleteMemory, writeFrontmatter,
    setScopeFilter, setTypeFilter, setSort,
  } = useMemoryStore()

  // Subscribe to a STABLE STRING KEY of only the structural fields
  // liveSessionsForProject reads (id / workingDirectory / sessionType). A plain
  // string compares by value (Object.is), so the statusline bridge's ~1-3×/s
  // telemetry ticks — which never touch these fields — don't re-render the page
  // (the old raw `s.sessions` selector re-rendered on every tick via array
  // identity churn). The lite-session array is reconstructed from the key, so it
  // only changes when the key does.
  const sessionsKey = useSessionStore((s) =>
    s.sessions.map((x) => `${x.id}\t${x.workingDirectory ?? ''}\t${x.sessionType}`).join('\n'),
  )
  const sessions = useMemo<LiveSessionLite[]>(
    () =>
      sessionsKey
        ? sessionsKey.split('\n').map((line) => {
            const [id, workingDirectory, sessionType] = line.split('\t')
            return { id, label: '', workingDirectory, sessionType }
          })
        : [],
    [sessionsKey],
  )
  const [searchInput, setSearchInput] = useState('')

  // Memory lives in ~/.claude/projects (junctioned into every account home), so
  // it is intentionally shared across accounts. Surface that only when more than
  // one account profile exists, so single-account users see no extra noise.
  const multiAccount = useAccountProfilesStore((s) => s.profiles.length >= 2)

  useEffect(() => { scan() }, [])

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 200)
    return () => clearTimeout(t)
  }, [searchInput])

  // WP2 PR 4, P4.4 (row 55): each account's own memories, for the providers
  // in use, grouped by provider, each file named by its account.
  const claudeOn = useSettingsStore((s) => usesClaude(s.settings))
  const codexOn = useSettingsStore((s) => usesCodex(s.settings))
  const providerSnapshot = useProviderAccountsStore((s) => s.snapshot)
  const accountGroups = useMemo(() => {
    const inUse = (p: ProviderId): boolean => (p === 'codex' ? codexOn : claudeOn)
    const groups = new Map<ProviderId, LabelledAccountMemories[]>()
    for (const entry of accountMemories ?? []) {
      if (!inUse(entry.providerId)) continue
      const list = groups.get(entry.providerId) ?? []
      list.push({ entry, label: accountMemoryLabel(providerSnapshot, entry) })
      groups.set(entry.providerId, list)
    }
    return [...groups.entries()].map(([providerId, accounts]) => ({
      providerId,
      providerName: providerView(providerSnapshot, providerId)?.displayName ?? PROVIDER_NAME_FALLBACK[providerId],
      accounts,
    }))
  }, [accountMemories, providerSnapshot, claudeOn, codexOn])
  // The accounts' files as search and the drawer see them: `project` names
  // the account.
  const accountFiles = useMemo<AccountMemoryFile[]>(
    () => accountGroups.flatMap((g) => g.accounts.flatMap(({ entry, label }) => entry.files.map((f) => ({ ...f, project: label })))),
    [accountGroups],
  )

  const selectedMem = useMemo(
    () => (selectedMemoryId
      ? findMemory({ memories }, selectedMemoryId) ?? accountFiles.find((m) => m.id === selectedMemoryId)
      : undefined),
    [memories, accountFiles, selectedMemoryId],
  )

  // Dashboard derivations — now is captured once per render; < 1ms for typical
  // corpus sizes (~hundreds of files), so no stale concern within a render cycle.
  const { kpis, health, buckets, types } = useMemo(() => {
    const now = Date.now()
    return {
      kpis: deriveKpis(memories, projects, now),
      health: indexHealth(projects),
      buckets: activityBuckets(memories, now),
      types: typeCounts(memories),
    }
  }, [memories, projects])

  // Live session counts per project — recalculated when sessions or projects change.
  const liveCounts = useMemo(
    () => Object.fromEntries(
      projects.map(p => [p.projectDir, liveSessionsForProject(sessions, p.projectDir).length])
    ),
    [sessions, projects],
  )

  // Ranked/filtered project list. `now` is captured once per data change (not per
  // render): the old inline filterProjects(..., Date.now()) produced a fresh array
  // every render, defeating ProjectsRankedList's memo and re-rendering it on every
  // statusline tick. Minute-granularity scope buckets don't need per-render `now`.
  const rankedProjects = useMemo(
    () => filterProjects(projects, memories, scopeFilter, Date.now()),
    [projects, memories, scopeFilter],
  )

  // Breadcrumb
  const breadcrumb = searchQuery
    ? [{ label: 'All Projects', action: () => { setSearchInput(''); setSearch(''); selectProject(null) } }, { label: `Search: "${searchQuery}"` }]
    : selectedProject
    ? [{ label: 'All Projects', action: () => selectProject(null) }, { label: memories.find(m => m.projectDir === selectedProject)?.project ?? selectedProject }]
    : [{ label: 'All Projects' }]

  const memoryIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
      <line x1="9" y1="21" x2="15" y2="21" />
      <line x1="10" y1="24" x2="14" y2="24" />
    </svg>
  )

  const memoryContext = (
    <span className="flex items-center gap-1.5">
      {breadcrumb.map((b, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="text-surface2">/</span>}
          {b.action ? (
            <span onClick={b.action} className="text-blue cursor-pointer hover:opacity-80">{b.label}</span>
          ) : (
            <span className="text-subtext1">{b.label}</span>
          )}
        </React.Fragment>
      ))}
    </span>
  )

  const memoryActions = (
    <div className="flex items-center gap-2">
      {/* Scope segmented control — dashboard only */}
      {!searchQuery && !selectedProject && (
        <div
          className="flex rounded overflow-hidden"
          style={{ border: '1px solid var(--border-subtle)' }}
        >
          {SCOPE_OPTIONS.map(({ label, value }) => {
            const active = scopeFilter === value
            return (
              <button
                key={value}
                onClick={() => setScopeFilter(value)}
                className="px-2.5 py-0.5 text-xs transition-colors"
                style={{
                  background: active ? 'var(--accent)' : 'var(--surface-stage)',
                  color: active ? 'var(--surface-base)' : 'var(--text-secondary)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}

      {multiAccount && (
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-lavender/10 text-lavender border border-lavender/25 shrink-0"
          title="Memory lives in ~/.claude/projects, which is shared across every account"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          Shared across accounts
        </span>
      )}

      <div className="relative w-56">
        <svg className="absolute left-2 top-1/2 -translate-y-1/2 text-overlay0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          type="text"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder="Search all memories…"
          className="w-full bg-surface0 border border-surface1 text-text pl-7 pr-2 py-0.5 rounded text-xs focus:outline-none focus:border-blue placeholder:text-overlay0"
        />
      </div>
    </div>
  )

  return (
    <PageFrame
      icon={memoryIcon}
      iconAccent="lavender"
      title="Memory"
      context={memoryContext}
      actions={memoryActions}
      onClose={onClose}
      scrollable={false}
    >
      {/* Where each part of the page comes from (P5.9; WP2 PR 4 P4.4), shown
          while Codex is in use: its memories live in each account's folder. */}
      {codexOn && (
        <div className="rounded-md bg-blue/10 border border-blue/30 p-3 text-sm text-blue mx-5 mt-3">
          Claude Code memories come from <code className="font-mono text-[12px]">~/.claude/projects/*/memory/</code>, shared by every Claude account. Each Codex account keeps its own, listed by account below, read-only for now. Codex also reads project instructions from <code className="font-mono text-[12px]">AGENTS.md</code> files.
        </div>
      )}

      {/* Main body */}
      <div className="flex-1 overflow-y-auto p-5">
        {loading && memories.length === 0 && accountFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-overlay0 gap-2">
            <span className="font-mono text-xs">Scanning memory directories...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-16 text-red gap-2">
            <span className="font-mono text-xs">{error}</span>
          </div>
        ) : projects.length === 0 && accountGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-overlay0 gap-2">
            <span className="font-mono text-xs">No memory directories found</span>
            <span className="text-[11px] text-overlay0">Claude Code stores memories in ~/.claude/projects/*/memory/</span>
          </div>
        ) : searchQuery ? (
          <MemorySearchResults
            memories={accountFiles.length > 0 ? [...memories, ...accountFiles] : memories}
            query={searchQuery}
            selectedId={selectedMemoryId}
            onSelect={selectMemory}
            onClear={() => { setSearchInput(''); setSearch('') }}
          />
        ) : selectedProject ? (
          <ProjectDrilldown
            projectDir={selectedProject}
            project={projects.find(p => p.projectDir === selectedProject)}
            memories={memories.filter(m => m.projectDir === selectedProject)}
            typeFilter={typeFilter}
            sortBy={sortBy}
            sortDir={sortDir}
            recentSessions={recentSessions[selectedProject] ?? []}
            liveSessions={liveSessionsForProject(sessions, selectedProject)}
            selectedMemoryId={selectedMemoryId}
            onBack={() => selectProject(null)}
            onSelectMemory={selectMemory}
            onSetTypeFilter={setTypeFilter}
            onSetSort={setSort}
            onJumpToSession={onJumpToSession ?? (() => {})}
            onOpenSessionLogs={onOpenSessionLogs ?? (() => {})}
          />
        ) : (
          /* Dashboard: Claude's store, then each account's own memories */
          <>
            {projects.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-overlay0 gap-2">
                <span className="font-mono text-xs">No memory directories found</span>
                <span className="text-[11px] text-overlay0">Claude Code stores memories in ~/.claude/projects/*/memory/</span>
              </div>
            ) : (
              <>
                <MemoryKpiRow kpis={kpis} health={health} />
                <div className="grid grid-cols-3 gap-3 mb-5">
                  <div className="col-span-2">
                    <MemoryActivityChart buckets={buckets} />
                  </div>
                  <MemoryTypeDonut types={types} />
                </div>
                <ProjectsRankedList
                  projects={rankedProjects}
                  liveCounts={liveCounts}
                  onSelect={selectProject}
                />
              </>
            )}
            {accountGroups.map((g) => (
              <AccountMemoriesSection
                key={g.providerId}
                providerId={g.providerId}
                providerName={g.providerName}
                accounts={g.accounts}
                selectedId={selectedMemoryId}
                onSelect={selectMemory}
              />
            ))}
          </>
        )}
      </div>

      {/* Reading drawer — overlays everything */}
      {selectedMem && (isAccountMemoryFile(selectedMem) ? (
        // An account's own memory: read-only (no frontmatter edit; Delete only
        // once its VM check passes, ACCOUNT_MEMORY_DELETE_SHOWN).
        <MemoryReadingDrawer
          key={selectedMem.id}
          memory={selectedMem}
          content={selectedContent}
          placeLabel="Account"
          onClose={() => selectMemory(null)}
          onDelete={ACCOUNT_MEMORY_DELETE_SHOWN ? () => deleteMemory(selectedMem.id) : undefined}
        />
      ) : (
        <MemoryReadingDrawer
          key={selectedMem.id}
          memory={selectedMem}
          content={selectedContent}
          onClose={() => selectMemory(null)}
          onDelete={() => deleteMemory(selectedMem.id)}
          onWriteFrontmatter={() => writeFrontmatter(selectedMem.id, {
            name: selectedMem.name,
            description: selectedMem.description,
            type: selectedMem.type,
          })}
        />
      ))}
    </PageFrame>
  )
}
