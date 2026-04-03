import React, { useEffect, useState, useMemo } from 'react'
import { useMemoryStore } from '../stores/memoryStore'
import type { MemoryFile, MemoryProject } from '../../shared/types'

const TYPE_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  user:          { bg: 'rgba(137,180,250,0.12)', fg: '#89b4fa', label: 'User' },
  feedback:      { bg: 'rgba(249,226,175,0.12)', fg: '#f9e2af', label: 'Feedback' },
  project:       { bg: 'rgba(166,227,161,0.12)', fg: '#a6e3a1', label: 'Project' },
  reference:     { bg: 'rgba(203,166,247,0.12)', fg: '#cba6f7', label: 'Reference' },
  snapshot:      { bg: 'rgba(127,132,156,0.12)', fg: '#7f849c', label: 'Snapshot' },
  uncategorized: { bg: 'rgba(88,91,112,0.12)',   fg: '#585b70', label: 'Uncategorized' },
}
const TYPE_ORDER = ['user', 'feedback', 'project', 'reference', 'snapshot', 'uncategorized']

function fmt(bytes: number) { return bytes < 1024 ? bytes + 'B' : (bytes / 1024).toFixed(1) + 'KB' }
function fmtRel(ts: number) {
  const d = Math.floor((Date.now() - ts) / 86400000)
  if (d === 0) return 'today'
  if (d === 1) return '1d ago'
  if (d < 30) return d + 'd ago'
  return Math.floor(d / 30) + 'mo ago'
}
function staleClass(ts: number) {
  const d = (Date.now() - ts) / 86400000
  return d < 7 ? 'bg-green' : d < 30 ? 'bg-yellow' : 'bg-red'
}
function staleShadow(ts: number) {
  const d = (Date.now() - ts) / 86400000
  return d < 7 ? '0 0 4px rgba(166,227,161,0.4)' : d < 30 ? '0 0 4px rgba(249,226,175,0.3)' : '0 0 4px rgba(243,139,168,0.3)'
}

function TypeBar({ types, total }: { types: Record<string, number>; total: number }) {
  return (
    <div className="flex h-1 rounded-sm overflow-hidden bg-surface0">
      {TYPE_ORDER.map(t => {
        const pct = ((types[t] || 0) / (total || 1)) * 100
        if (pct === 0) return null
        return <div key={t} style={{ width: pct + '%', background: TYPE_COLORS[t]?.fg }} />
      })}
    </div>
  )
}

function TypeBadge({ type }: { type: string }) {
  const tc = TYPE_COLORS[type] || TYPE_COLORS.uncategorized
  return (
    <span
      className="font-mono text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm shrink-0"
      style={{ background: tc.bg, color: tc.fg }}
    >
      {tc.label}
    </span>
  )
}

// Simple markdown renderer
function renderMarkdown(content: string): string {
  return content
    .replace(/^---[\s\S]*?---\n*/m, '') // strip frontmatter
    .replace(/^### (.+)$/gm, '<h3 class="font-mono text-xs text-subtext0 font-semibold mt-4 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="font-mono text-[13px] text-blue font-semibold mt-4 mb-1">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="font-mono text-[15px] text-text font-semibold mt-4 mb-2">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-text font-semibold">$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="font-mono text-[11px] bg-surface0 px-1 py-0.5 rounded text-peach">$1</code>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 mb-0.5">$1</li>')
    .replace(/\n{2,}/g, '</p><p class="mb-2">')
    .replace(/\n/g, '<br>')
}

// ── Project Cards View ──
function ProjectsView({ projects, memories, onSelect }: { projects: MemoryProject[]; memories: MemoryFile[]; onSelect: (name: string) => void }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2.5">
      {projects.map(p => {
        const preview = memories.find(m => m.project === p.name && m.filename !== 'MEMORY.md')
        return (
          <div
            key={p.name}
            onClick={() => onSelect(p.name)}
            className="bg-mantle border border-surface0 rounded-md p-4 cursor-pointer transition-all hover:border-surface1 hover:bg-[rgba(137,180,250,0.03)]"
          >
            <div className="flex items-center gap-2.5 mb-2.5">
              <span className="font-mono text-[13px] font-medium text-text flex-1">{p.name}</span>
              <span className="font-mono text-[10px] bg-surface0 text-overlay1 px-2 py-0.5 rounded-full">{p.fileCount} files</span>
            </div>
            <div className="flex items-center gap-3 font-mono text-[10px] text-overlay0 mb-2.5">
              <span>{fmt(p.totalSize)}</span>
              <span className="flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full ${staleClass(p.lastModified)}`} style={{ boxShadow: staleShadow(p.lastModified) }} />
                {fmtRel(p.lastModified)}
              </span>
              {p.memoryMdLines != null && p.memoryMdLines > 200 && (
                <span className="text-yellow">index: {p.memoryMdLines} lines</span>
              )}
            </div>
            <TypeBar types={p.types} total={p.fileCount} />
            <div className="flex gap-2 flex-wrap mt-2">
              {TYPE_ORDER.filter(t => p.types[t]).map(t => (
                <span key={t} className="flex items-center gap-1 font-mono text-[9px] text-overlay0">
                  <span className="w-1 h-1 rounded-full" style={{ background: TYPE_COLORS[t]?.fg }} />
                  {TYPE_COLORS[t]?.label} {p.types[t]}
                </span>
              ))}
            </div>
            {preview && (
              <p className="text-[11px] text-overlay1 mt-2 line-clamp-2">{preview.description}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Project Detail View (grouped by type) ──
function ProjectDetailView({ project, memories, selectedId, onSelect, collapsedGroups, onToggle, onBack }: {
  project: string
  memories: MemoryFile[]
  selectedId: string | null
  onSelect: (id: string) => void
  collapsedGroups: Set<string>
  onToggle: (type: string) => void
  onBack: () => void
}) {
  const projectMems = memories.filter(m => m.project === project)
  const grouped: Record<string, MemoryFile[]> = {}
  TYPE_ORDER.forEach(t => grouped[t] = [])
  projectMems.forEach(m => {
    if (grouped[m.type]) grouped[m.type].push(m)
    else grouped.uncategorized.push(m)
  })

  const totalSize = projectMems.reduce((s, m) => s + m.size, 0)

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1.5 font-mono text-[11px] text-blue bg-transparent border-none cursor-pointer mb-4 hover:opacity-80">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        All Projects
      </button>

      <div className="flex items-center gap-4 font-mono text-[11px] mb-5">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-[13px] text-text">{projectMems.length}</span>
          <span className="text-overlay0">memories</span>
        </div>
        <div className="w-px h-4 bg-surface1" />
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-[13px] text-text">{fmt(totalSize)}</span>
          <span className="text-overlay0">total</span>
        </div>
      </div>

      {TYPE_ORDER.map(type => {
        const items = grouped[type]
        if (items.length === 0) return null
        const tc = TYPE_COLORS[type]
        const collapsed = collapsedGroups.has(type)

        return (
          <div key={type} className="mb-4">
            <div
              onClick={() => onToggle(type)}
              className="flex items-center gap-2 py-1.5 cursor-pointer select-none group"
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tc.fg }} />
              <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-overlay1 group-hover:text-text transition-colors">
                {tc.label}
              </span>
              <span className="font-mono text-[10px] text-overlay0">{items.length}</span>
              <span className="flex-1 h-px bg-surface0" />
              <span className={`text-overlay0 text-[10px] transition-transform ${collapsed ? '-rotate-90' : ''}`}>
                {String.fromCharCode(0x25BC)}
              </span>
            </div>
            {!collapsed && (
              <div className="pl-4">
                {items.map(m => (
                  <div
                    key={m.id}
                    onClick={() => onSelect(m.id)}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded cursor-pointer transition-colors mb-0.5 ${
                      selectedId === m.id ? 'bg-[rgba(137,180,250,0.1)]' : 'hover:bg-[rgba(137,180,250,0.05)]'
                    }`}
                  >
                    <span className="font-mono text-xs text-text flex-1 truncate">{m.name}</span>
                    <span className="text-[11px] text-overlay1 flex-[2] truncate min-w-0">{m.description}</span>
                    <div className="flex items-center gap-2 font-mono text-[10px] text-overlay0 shrink-0">
                      {m.hasFrontmatter && (
                        <span className="text-[8px] text-teal opacity-60 border border-teal/20 px-1 rounded-sm">FM</span>
                      )}
                      <span>{fmt(m.size)}</span>
                      <span className={`w-1.5 h-1.5 rounded-full ${staleClass(m.modified)}`} style={{ boxShadow: staleShadow(m.modified) }} />
                      <span>{fmtRel(m.modified)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Search Results ──
function SearchResults({ memories, query, selectedId, onSelect, onClear }: {
  memories: MemoryFile[]
  query: string
  selectedId: string | null
  onSelect: (id: string) => void
  onClear: () => void
}) {
  const ql = query.toLowerCase()
  const results = memories.filter(m =>
    m.name.toLowerCase().includes(ql) ||
    m.description.toLowerCase().includes(ql) ||
    m.project.toLowerCase().includes(ql) ||
    m.filename.toLowerCase().includes(ql)
  ).sort((a, b) => b.modified - a.modified)

  return (
    <div>
      <button onClick={onClear} className="flex items-center gap-1.5 font-mono text-[11px] text-blue bg-transparent border-none cursor-pointer mb-4 hover:opacity-80">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        Clear search
      </button>
      <div className="font-mono text-[11px] text-overlay1 mb-3">
        {results.length} result{results.length !== 1 ? 's' : ''} for "{query}"
      </div>
      {results.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-overlay0 gap-2">
          <span className="font-mono text-xs">No memories match "{query}"</span>
        </div>
      ) : results.map(m => {
        const tc = TYPE_COLORS[m.type] || TYPE_COLORS.uncategorized
        return (
          <div
            key={m.id}
            onClick={() => onSelect(m.id)}
            className={`flex items-center gap-2.5 p-3 border border-surface0 rounded mb-1.5 cursor-pointer transition-all ${
              selectedId === m.id ? 'bg-[rgba(137,180,250,0.1)] border-blue' : 'hover:bg-[rgba(137,180,250,0.04)] hover:border-surface1'
            }`}
          >
            <TypeBadge type={m.type} />
            <div className="flex-1 min-w-0">
              <div className="font-mono text-xs text-text">{m.name}</div>
              <div className="font-mono text-[10px] text-overlay0 mt-0.5">Local / {m.project} / {m.filename}</div>
              <div className="text-[11px] text-overlay1 truncate mt-0.5">{m.description}</div>
            </div>
            <div className="font-mono text-[10px] text-overlay0 shrink-0 text-right">
              <div>{fmt(m.size)}</div>
              <div>{fmtRel(m.modified)}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Detail Panel ──
function DetailPanel({ memory, content, onClose, onDelete, onWriteFrontmatter }: {
  memory: MemoryFile
  content: string | null
  onClose: () => void
  onDelete: () => void
  onWriteFrontmatter: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const tc = TYPE_COLORS[memory.type] || TYPE_COLORS.uncategorized

  return (
    <div className="w-[440px] min-w-[440px] border-l border-surface0 bg-mantle flex flex-col">
      <div className="px-4 py-3 border-b border-surface0 flex items-center gap-2.5 shrink-0">
        <TypeBadge type={memory.type} />
        <span className="font-mono text-[13px] font-medium text-text flex-1 truncate">{memory.name}</span>
        <div className="flex gap-1.5">
          {!memory.hasFrontmatter && (
            <button onClick={onWriteFrontmatter} className="font-mono text-[10px] px-2.5 py-1 rounded-sm border border-surface1 bg-surface0 text-subtext0 cursor-pointer hover:border-overlay0 hover:text-text transition-all">
              + Metadata
            </button>
          )}
          {!confirmDelete ? (
            <button onClick={() => setConfirmDelete(true)} className="font-mono text-[10px] px-2.5 py-1 rounded-sm border border-surface1 bg-surface0 text-subtext0 cursor-pointer hover:border-red hover:text-red transition-all">
              Delete
            </button>
          ) : (
            <button onClick={onDelete} className="font-mono text-[10px] px-2.5 py-1 rounded-sm border border-red bg-red/10 text-red cursor-pointer">
              Confirm
            </button>
          )}
        </div>
        <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded bg-transparent border-none text-overlay0 cursor-pointer hover:bg-surface0 hover:text-text transition-all text-base">
          {String.fromCodePoint(0x00D7)}
        </button>
      </div>
      <div className="px-4 py-3 border-b border-surface0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 shrink-0">
        <span className="font-mono text-[10px] text-overlay0 uppercase tracking-wide">Type</span>
        <span className="font-mono text-[11px] text-subtext1">{memory.type} {memory.hasFrontmatter ? '(frontmatter)' : '(inferred)'}</span>
        <span className="font-mono text-[10px] text-overlay0 uppercase tracking-wide">Project</span>
        <span className="font-mono text-[11px] text-subtext1">{memory.project}</span>
        <span className="font-mono text-[10px] text-overlay0 uppercase tracking-wide">Machine</span>
        <span className="font-mono text-[11px] text-subtext1">Local</span>
        <span className="font-mono text-[10px] text-overlay0 uppercase tracking-wide">Path</span>
        <span className="font-mono text-[11px] text-subtext1 truncate" title={memory.path}>{memory.path}</span>
        <span className="font-mono text-[10px] text-overlay0 uppercase tracking-wide">Size</span>
        <span className="font-mono text-[11px] text-subtext1">{fmt(memory.size)}</span>
        <span className="font-mono text-[10px] text-overlay0 uppercase tracking-wide">Modified</span>
        <span className="font-mono text-[11px] text-subtext1">{new Date(memory.modified).toISOString().slice(0, 10)} ({fmtRel(memory.modified)})</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {content === null ? (
          <div className="text-overlay0 font-mono text-xs">Loading...</div>
        ) : (
          <div
            className="text-xs leading-relaxed text-subtext1"
            dangerouslySetInnerHTML={{ __html: '<p>' + renderMarkdown(content) + '</p>' }}
          />
        )}
      </div>
    </div>
  )
}

// ── Main Page ──
export default function MemoryPage() {
  const {
    projects, memories, warnings, totalSize, loading, error,
    selectedProject, selectedMemoryId, searchQuery, collapsedGroups, selectedContent,
    scan, selectProject, selectMemory, setSearch, toggleGroup, deleteMemory, writeFrontmatter, dismissWarnings,
  } = useMemoryStore()

  const [searchInput, setSearchInput] = useState('')

  useEffect(() => { scan() }, [])

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 200)
    return () => clearTimeout(t)
  }, [searchInput])

  const selectedMem = useMemo(() => memories.find(m => m.id === selectedMemoryId), [memories, selectedMemoryId])

  const breadcrumb = searchQuery
    ? [{ label: 'All Projects', action: () => { setSearchInput(''); setSearch(''); selectProject(null) } }, { label: `Search: "${searchQuery}"` }]
    : selectedProject
    ? [{ label: 'All Projects', action: () => selectProject(null) }, { label: selectedProject }]
    : [{ label: 'All Projects' }]

  return (
    <div className="flex flex-col h-full">
      {/* Top Bar */}
      <div className="flex items-center gap-4 px-5 py-3 border-b border-surface0 bg-mantle shrink-0">
        <span className="font-mono text-[13px] font-semibold text-text tracking-wide">Memory</span>
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-overlay0 flex-1">
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
        </div>
        <div className="relative w-60">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-overlay0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search all memories..."
            className="w-full bg-surface0 border border-surface1 text-text pl-8 pr-3 py-1.5 rounded text-xs focus:outline-none focus:border-blue placeholder:text-overlay0"
          />
        </div>
      </div>

      {/* Warning Banner */}
      {warnings.length > 0 && (
        <div className="flex items-center gap-2 px-5 py-2 bg-yellow/[0.06] border-b border-yellow/10 shrink-0">
          <svg className="text-yellow opacity-80 shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span className="font-mono text-[11px] text-yellow flex-1">{warnings[0].message}</span>
          {warnings.length > 1 && (
            <span className="font-mono text-[10px] text-yellow/60">+{warnings.length - 1} more</span>
          )}
          <button onClick={dismissWarnings} className="font-mono text-[10px] text-yellow border border-yellow/20 bg-transparent px-2 py-0.5 rounded-sm cursor-pointer hover:bg-yellow/10">
            Dismiss
          </button>
        </div>
      )}

      {/* Main Content + Detail */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 overflow-y-auto p-5">
          {loading && memories.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-overlay0 gap-2">
              <span className="font-mono text-xs">Scanning memory directories...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-16 text-red gap-2">
              <span className="font-mono text-xs">{error}</span>
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-overlay0 gap-2">
              <span className="font-mono text-xs">No memory directories found</span>
              <span className="text-[11px] text-overlay0">Claude Code stores memories in ~/.claude/projects/*/memory/</span>
            </div>
          ) : (
            <>
              {/* Stats strip */}
              {!searchQuery && !selectedProject && (
                <div className="flex items-center gap-4 font-mono text-[11px] mb-5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-[13px] text-text">{memories.length}</span>
                    <span className="text-overlay0">memories</span>
                  </div>
                  <div className="w-px h-4 bg-surface1" />
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-[13px] text-text">{projects.length}</span>
                    <span className="text-overlay0">projects</span>
                  </div>
                  <div className="w-px h-4 bg-surface1" />
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-[13px] text-text">{fmt(totalSize)}</span>
                    <span className="text-overlay0">total</span>
                  </div>
                </div>
              )}

              {searchQuery ? (
                <SearchResults
                  memories={memories}
                  query={searchQuery}
                  selectedId={selectedMemoryId}
                  onSelect={id => selectMemory(id)}
                  onClear={() => { setSearchInput(''); setSearch('') }}
                />
              ) : selectedProject ? (
                <ProjectDetailView
                  project={selectedProject}
                  memories={memories}
                  selectedId={selectedMemoryId}
                  onSelect={id => selectMemory(id)}
                  collapsedGroups={collapsedGroups}
                  onToggle={toggleGroup}
                  onBack={() => selectProject(null)}
                />
              ) : (
                <ProjectsView
                  projects={projects}
                  memories={memories}
                  onSelect={selectProject}
                />
              )}
            </>
          )}
        </div>

        {/* Detail Panel */}
        {selectedMem && (
          <DetailPanel
            memory={selectedMem}
            content={selectedContent}
            onClose={() => selectMemory(null)}
            onDelete={() => deleteMemory(selectedMem.id)}
            onWriteFrontmatter={() => {
              writeFrontmatter(selectedMem.id, {
                name: selectedMem.name,
                description: selectedMem.description,
                type: selectedMem.type,
              })
            }}
          />
        )}
      </div>
    </div>
  )
}
