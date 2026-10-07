// The layout of a Codex account folder's `memories/` (WP2 PR 4, P4.4, row 55).
//
// Where it comes from, entry by entry (`source`):
// - `pb6-run`: made by Codex itself in probe PB6 (2026-10-02, Codex 0.155.1
//   through its codex.exe and 0.153.4 through its npm .cmd shim, the same on
//   both): `memories/` is a GIT REPOSITORY (`.git/` with the sample hooks)
//   holding `extensions/ad_hoc/instructions.md`, `phase2_workspace_diff.md`,
//   a heading-only `raw_memories.md` and an empty `rollout_summaries/`. The
//   names, the nesting and the heading-first shape are the run's; the text is
//   a stand-in (the probe recorded sizes and an anonymised first line only).
// - `seeded`: NOT made by that run (the fake model answered nothing for the
//   memory stage to keep). Codex's own strings name `MEMORY.md` and
//   `memory_summary.md` under `memories/`; these two are seeded from that,
//   with stand-in text. Their real format is an owner check on a working
//   model (OR4).
// - `probe`: not Codex's; a file a test plants to prove a rule (here: an
//   `.md` file inside `.git/`, which must never be listed either).
//
// Plain data: a test builds it into its own fake file system, or into a temp
// folder in a quarantined suite (CI and VM only).

export type MemoryFixtureSource = 'pb6-run' | 'seeded' | 'probe'

export interface MemoryFixtureEntry {
  /** Path inside `memories/`, written with `/`. */
  rel: string
  kind: 'dir' | 'file'
  source: MemoryFixtureSource
  content?: string
}

const lines = (...l: string[]): string => l.join('\n') + '\n'

export const PB6_MEMORIES: readonly MemoryFixtureEntry[] = Object.freeze([
  // The git repository Codex keeps the folder as (pb6-run; a few of its 43 entries).
  { rel: '.git', kind: 'dir', source: 'pb6-run' },
  { rel: '.git/HEAD', kind: 'file', source: 'pb6-run', content: 'ref: refs/heads/master\n' },
  { rel: '.git/config', kind: 'file', source: 'pb6-run', content: lines('[core]', '\trepositoryformatversion = 0', '\tfilemode = false', '\tbare = false') },
  { rel: '.git/description', kind: 'file', source: 'pb6-run', content: "Unnamed repository; edit this file 'description' to name the repository.\n" },
  { rel: '.git/hooks', kind: 'dir', source: 'pb6-run' },
  { rel: '.git/hooks/pre-commit.sample', kind: 'file', source: 'pb6-run', content: lines('#!/bin/sh', '# stand-in for the sample hook') },
  { rel: '.git/info', kind: 'dir', source: 'pb6-run' },
  { rel: '.git/info/exclude', kind: 'file', source: 'pb6-run', content: lines('# git ls-files --others --exclude-from=.git/info/exclude') },
  { rel: '.git/info/notes.md', kind: 'file', source: 'probe', content: lines('# Never listed', 'An .md file inside .git, planted by the test.') },
  { rel: '.git/refs', kind: 'dir', source: 'pb6-run' },
  { rel: '.git/refs/heads', kind: 'dir', source: 'pb6-run' },
  { rel: '.git/refs/heads/master', kind: 'file', source: 'pb6-run', content: '0000000000000000000000000000000000000000\n' },
  // The files Codex wrote beside it (pb6-run).
  { rel: 'extensions', kind: 'dir', source: 'pb6-run' },
  { rel: 'extensions/ad_hoc', kind: 'dir', source: 'pb6-run' },
  {
    rel: 'extensions/ad_hoc/instructions.md', kind: 'file', source: 'pb6-run',
    content: lines('# Ad-hoc notes', '', 'Stand-in text: the run wrote 14 lines here, a heading first.', '', '- one', '- two'),
  },
  {
    rel: 'phase2_workspace_diff.md', kind: 'file', source: 'pb6-run',
    content: lines('# Memory Workspace Diff', '', 'Stand-in text: the run wrote 20 lines here, a heading first.'),
  },
  { rel: 'raw_memories.md', kind: 'file', source: 'pb6-run', content: lines('# Raw Memories', '', '') },
  { rel: 'rollout_summaries', kind: 'dir', source: 'pb6-run' },
  // Seeded from Codex's strings (not made by the run; their format is OR4).
  {
    rel: 'MEMORY.md', kind: 'file', source: 'seeded',
    content: lines('# Memory', '', 'Seeded stand-in: the user prefers small commits.'),
  },
  {
    rel: 'memory_summary.md', kind: 'file', source: 'seeded',
    content: lines('# Memory summary', '', 'Seeded stand-in: a summary of what Codex remembers.'),
  },
])

/** The `.md` files a listing of the fixture must show, in path order: every
 *  file outside `.git/`, and nothing else. */
export const PB6_LISTED_MD: readonly string[] = Object.freeze(
  PB6_MEMORIES
    .filter((e) => e.kind === 'file' && e.rel.endsWith('.md') && !e.rel.split('/').includes('.git'))
    .map((e) => e.rel)
    .sort(),
)
