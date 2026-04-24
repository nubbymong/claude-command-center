# Sidebar Flexibility — Phase 1b: Section Options + ToastUndo + Nested Popovers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `<SectionOptionsPopover>` + `<ToastUndo>` and refactor `<SidebarHeaderMenu>` onto `@floating-ui/react`'s `FloatingTree` so the master `⋯` and each section's `⋯` share a single focus stack. User-visible change: every section grows a `⋯` icon with a working section popover, and "Hide in this session" flows through an undo toast.

**Architecture:** Add `@floating-ui/react` as a real dependency. Introduce a `<FloatingTree>` at the top of `PanelHeader` so both the master menu and any child section popover register as `FloatingNode`s — `FloatingFocusManager` then serialises focus. `<SectionOptionsPopover>` is generic: each section declares its slots via a `SectionOptionsConfig` lookup in `section-options-config.ts`. `<ToastUndo>` renders through a portal driven by a `toastUndoStore` (Zustand), queued so rapid destructive actions don't clobber each other. One destructive action — Hide section in session — is wired end-to-end as the reference pattern.

**Tech Stack:** TypeScript strict, Zustand 5, React 18, Tailwind v4 (Catppuccin Mocha), `@floating-ui/react` (new), `electron-vite` for HMR, vitest + @testing-library/react for unit tests.

**Depends on:** Phase 1a (`feat/sidebar-data-model`) having landed. This phase assumes `GitHubSectionId`, `SectionPref`, `window.electronAPI.github.setSectionPrefs(sessionId, id, prefs)`, `githubStore.hideSection/unhideSection` are already available.

---

## File structure

- Modify: `package.json` — add `@floating-ui/react` dependency.
- Create: `src/renderer/stores/toastUndoStore.ts` — Zustand store with queueing.
- Create: `src/renderer/components/common/ToastUndo.tsx` — portal-rendered toast component.
- Create: `src/renderer/components/github/menu/section-options-config.ts` — per-section slot declarations.
- Create: `src/renderer/components/github/menu/SectionOptionsPopover.tsx` — generic section popover.
- Modify: `src/renderer/components/github/menu/SidebarHeaderMenu.tsx` — wrap in `FloatingNode`.
- Modify: `src/renderer/components/github/PanelHeader.tsx` — host `FloatingTree` + portal the ToastUndo.
- Modify: `src/renderer/components/github/SectionFrame.tsx` — render per-section `⋯` trigger.
- Create: `tests/unit/renderer/stores/toastUndoStore.test.ts`
- Create: `tests/unit/renderer/components/common/ToastUndo.test.tsx`
- Create: `tests/unit/renderer/components/github/SectionOptionsPopover.test.tsx`
- Create: `tests/unit/renderer/components/github/nested-popover-focus.test.tsx`

All new files ≤250 LOC. Existing files grow by ≤80 LOC each.

---

### Task 1: Add `@floating-ui/react` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Verify the dep is missing**

Run: `node -e "console.log(require('./package.json').dependencies['@floating-ui/react'] || 'missing')"`
Expected output: `missing`.

- [ ] **Step 2: Install**

Run: `npm install --save @floating-ui/react@^0.27.0`
Expected: adds to `dependencies` block.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no new errors).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(sidebar): add @floating-ui/react for nested popover focus management"
```

---

### Task 2: Build the `toastUndoStore`

**Files:**
- Create: `src/renderer/stores/toastUndoStore.ts`
- Create: `tests/unit/renderer/stores/toastUndoStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/renderer/stores/toastUndoStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useToastUndoStore } from '../../../src/renderer/stores/toastUndoStore'

describe('toastUndoStore', () => {
  beforeEach(() => {
    useToastUndoStore.setState({ queue: [] })
  })

  it('show() enqueues a toast with a unique id', () => {
    useToastUndoStore.getState().show({ label: 'Hidden', onUndo: () => undefined })
    const q = useToastUndoStore.getState().queue
    expect(q.length).toBe(1)
    expect(q[0].label).toBe('Hidden')
    expect(typeof q[0].id).toBe('string')
  })

  it('dismiss() removes the first matching toast', () => {
    useToastUndoStore.getState().show({ label: 'A', onUndo: () => undefined })
    useToastUndoStore.getState().show({ label: 'B', onUndo: () => undefined })
    const id = useToastUndoStore.getState().queue[0].id
    useToastUndoStore.getState().dismiss(id)
    const q = useToastUndoStore.getState().queue
    expect(q.length).toBe(1)
    expect(q[0].label).toBe('B')
  })

  it('runUndo() calls the stored handler with the snapshot and dismisses', () => {
    const spy = vi.fn()
    useToastUndoStore.getState().show({
      label: 'X', snapshot: { value: 42 }, onUndo: spy,
    })
    const id = useToastUndoStore.getState().queue[0].id
    useToastUndoStore.getState().runUndo(id)
    expect(spy).toHaveBeenCalledWith({ value: 42 })
    expect(useToastUndoStore.getState().queue.length).toBe(0)
  })

  it('show() does NOT clobber an existing toast — queue grows', () => {
    useToastUndoStore.getState().show({ label: 'first', onUndo: () => undefined })
    useToastUndoStore.getState().show({ label: 'second', onUndo: () => undefined })
    expect(useToastUndoStore.getState().queue.length).toBe(2)
    expect(useToastUndoStore.getState().queue.map((t) => t.label)).toEqual(['first', 'second'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/stores/toastUndoStore.test.ts`
Expected: FAIL — "Cannot find module ../../../src/renderer/stores/toastUndoStore".

- [ ] **Step 3: Write the store**

Create `src/renderer/stores/toastUndoStore.ts`:

```ts
import { create } from 'zustand'

export interface ToastUndoEntry<S = unknown> {
  id: string
  label: string
  snapshot?: S
  onUndo: (snapshot: S | undefined) => void
  /** Optional duration override; default 5000ms handled by <ToastUndo>. */
  durationMs?: number
}

export interface ShowOpts<S = unknown> {
  label: string
  snapshot?: S
  onUndo: (snapshot: S | undefined) => void
  durationMs?: number
}

interface ToastUndoState {
  queue: ToastUndoEntry[]
  show: <S = unknown>(opts: ShowOpts<S>) => string
  dismiss: (id: string) => void
  runUndo: (id: string) => void
}

let counter = 0
function nextId(): string {
  counter += 1
  return `toast_${Date.now().toString(36)}_${counter}`
}

export const useToastUndoStore = create<ToastUndoState>((set, get) => ({
  queue: [],
  show: (opts) => {
    const id = nextId()
    const entry: ToastUndoEntry = {
      id,
      label: opts.label,
      snapshot: opts.snapshot,
      onUndo: opts.onUndo as ToastUndoEntry['onUndo'],
      durationMs: opts.durationMs,
    }
    set({ queue: [...get().queue, entry] })
    return id
  },
  dismiss: (id) => {
    set({ queue: get().queue.filter((t) => t.id !== id) })
  },
  runUndo: (id) => {
    const entry = get().queue.find((t) => t.id === id)
    if (!entry) return
    entry.onUndo(entry.snapshot)
    set({ queue: get().queue.filter((t) => t.id !== id) })
  },
}))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/renderer/stores/toastUndoStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/stores/toastUndoStore.ts tests/unit/renderer/stores/toastUndoStore.test.ts
git commit -m "feat(sidebar): toastUndoStore with queueing"
```

---

### Task 3: Build `<ToastUndo>` component

**Files:**
- Create: `src/renderer/components/common/ToastUndo.tsx`
- Create: `tests/unit/renderer/components/common/ToastUndo.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/renderer/components/common/ToastUndo.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useToastUndoStore } from '../../../../src/renderer/stores/toastUndoStore'
import { ToastUndo } from '../../../../src/renderer/components/common/ToastUndo'

describe('ToastUndo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useToastUndoStore.setState({ queue: [] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing when queue is empty', () => {
    const { container } = render(<ToastUndo />)
    expect(container.textContent).toBe('')
  })

  it('renders label + undo button with aria-live polite', () => {
    useToastUndoStore.getState().show({ label: 'Hidden. Undo?', onUndo: () => undefined })
    render(<ToastUndo />)
    expect(screen.getByText('Hidden. Undo?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
  })

  it('click Undo runs the handler with snapshot', () => {
    const spy = vi.fn()
    useToastUndoStore.getState().show({ label: 'X', snapshot: 7, onUndo: spy })
    render(<ToastUndo />)
    fireEvent.click(screen.getByRole('button', { name: /undo/i }))
    expect(spy).toHaveBeenCalledWith(7)
    expect(useToastUndoStore.getState().queue.length).toBe(0)
  })

  it('auto-dismisses after 5s default', () => {
    useToastUndoStore.getState().show({ label: 'X', onUndo: () => undefined })
    render(<ToastUndo />)
    expect(useToastUndoStore.getState().queue.length).toBe(1)
    act(() => { vi.advanceTimersByTime(5100) })
    expect(useToastUndoStore.getState().queue.length).toBe(0)
  })

  it('renders multiple queued toasts stacked', () => {
    useToastUndoStore.getState().show({ label: 'first', onUndo: () => undefined })
    useToastUndoStore.getState().show({ label: 'second', onUndo: () => undefined })
    render(<ToastUndo />)
    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/components/common/ToastUndo.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the component**

Create `src/renderer/components/common/ToastUndo.tsx`:

```tsx
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useToastUndoStore, type ToastUndoEntry } from '../../stores/toastUndoStore'

const DEFAULT_DURATION_MS = 5000

function ToastRow({ entry }: { entry: ToastUndoEntry }) {
  const dismiss = useToastUndoStore((s) => s.dismiss)
  const runUndo = useToastUndoStore((s) => s.runUndo)

  useEffect(() => {
    const t = setTimeout(() => dismiss(entry.id), entry.durationMs ?? DEFAULT_DURATION_MS)
    return () => clearTimeout(t)
  }, [entry.id, entry.durationMs, dismiss])

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded px-3 py-2 shadow-lg transition-opacity duration-200"
      style={{
        background: 'var(--color-surface0)',
        color: 'var(--color-text)',
        border: '1px solid var(--color-surface1)',
        minWidth: 240,
        maxWidth: 360,
      }}
    >
      <span className="flex-1 text-sm truncate">{entry.label}</span>
      <button
        className="rounded px-2 py-0.5 text-xs font-medium transition-colors hover:opacity-80"
        style={{ color: 'var(--color-blue)' }}
        onClick={() => runUndo(entry.id)}
      >
        Undo
      </button>
      <button
        aria-label="Dismiss"
        className="text-xs transition-colors hover:opacity-80"
        style={{ color: 'var(--color-overlay0)' }}
        onClick={() => dismiss(entry.id)}
      >
        {String.fromCodePoint(0x2715)}
      </button>
    </div>
  )
}

export function ToastUndo() {
  const queue = useToastUndoStore((s) => s.queue)
  if (queue.length === 0) return null
  if (typeof document === 'undefined') return null

  const target = document.body
  return createPortal(
    <div
      className="pointer-events-none fixed bottom-6 right-6 z-[1000] flex flex-col-reverse gap-2"
    >
      {queue.map((entry) => (
        <div key={entry.id} className="pointer-events-auto">
          <ToastRow entry={entry} />
        </div>
      ))}
    </div>,
    target,
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/renderer/components/common/ToastUndo.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/common/ToastUndo.tsx tests/unit/renderer/components/common/ToastUndo.test.tsx
git commit -m "feat(sidebar): ToastUndo portal component"
```

---

### Task 4: Write `section-options-config.ts`

**Files:**
- Create: `src/renderer/components/github/menu/section-options-config.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/renderer/components/github/section-options-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SECTION_OPTIONS_CONFIG } from '../../../../src/renderer/components/github/menu/section-options-config'

describe('SECTION_OPTIONS_CONFIG', () => {
  it('provides a slot declaration for every section id', () => {
    const ids = [
      'sessionContext','activePR','ci','reviews','linkedIssues',
      'localGit','notifications','liveActivity',
    ] as const
    for (const id of ids) {
      expect(SECTION_OPTIONS_CONFIG[id]).toBeDefined()
    }
  })

  it('CI declares filter + autoExpandOnFailure slots', () => {
    const cfg = SECTION_OPTIONS_CONFIG.ci
    expect(cfg.specificSlots.some((s) => s.key === 'filter')).toBe(true)
    expect(cfg.specificSlots.some((s) => s.key === 'autoExpandOnFailure')).toBe(true)
  })

  it('Notifications declares refreshSec slot override with reasonable clamp', () => {
    const cfg = SECTION_OPTIONS_CONFIG.notifications
    const slot = cfg.specificSlots.find((s) => s.key === 'refreshSec')
    expect(slot).toBeDefined()
    expect(slot?.kind).toBe('number')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/components/github/section-options-config.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the config**

Create `src/renderer/components/github/menu/section-options-config.ts`:

```ts
import type { GitHubSectionId, SectionPref } from '../../../../shared/github-types'

export type SlotKind = 'boolean' | 'number' | 'select'

export interface SpecificSlot {
  key: keyof SectionPref
  label: string
  kind: SlotKind
  /** For 'select' only — choices rendered in the dropdown. */
  options?: Array<{ value: string; label: string }>
  /** For 'number' only — min/max used for clamping + validation. */
  min?: number
  max?: number
  /** Shown underneath the control as helper copy. */
  hint?: string
}

export interface SectionOptionsConfigEntry {
  /** Human label shown in popover title. */
  title: string
  /** Whether the section supports the shared 'compact' toggle. */
  hasCompact: boolean
  /** Whether the section supports a per-section refresh-interval control. */
  hasRefreshInterval: boolean
  /** Whether "Hide in this session" is a reasonable offer. */
  hasHideInSession: boolean
  /** Section-specific controls, appended after the shared slots. */
  specificSlots: SpecificSlot[]
}

const EMPTY: SpecificSlot[] = []

export const SECTION_OPTIONS_CONFIG: Record<GitHubSectionId, SectionOptionsConfigEntry> = {
  sessionContext: {
    title: 'Session Context options',
    hasCompact: true,
    hasRefreshInterval: false,
    hasHideInSession: true,
    specificSlots: EMPTY,
  },
  activePR: {
    title: 'Active PR options',
    hasCompact: true,
    hasRefreshInterval: true,
    hasHideInSession: true,
    specificSlots: EMPTY,
  },
  ci: {
    title: 'CI / Actions options',
    hasCompact: true,
    hasRefreshInterval: true,
    hasHideInSession: true,
    specificSlots: [
      {
        key: 'filter',
        label: 'Default filter',
        kind: 'select',
        options: [
          { value: 'all', label: 'All' },
          { value: 'failing', label: 'Failing' },
          { value: 'this-branch', label: 'This branch' },
          { value: 'pr-only', label: 'PR only' },
        ],
      },
      {
        key: 'autoExpandOnFailure',
        label: 'Auto-expand failed runs',
        kind: 'boolean',
      },
    ],
  },
  reviews: {
    title: 'Reviews & Comments options',
    hasCompact: true,
    hasRefreshInterval: true,
    hasHideInSession: true,
    specificSlots: [
      {
        key: 'filter',
        label: 'Default filter',
        kind: 'select',
        options: [
          { value: 'open', label: 'Open' },
          { value: 'resolved', label: 'Resolved' },
          { value: 'all', label: 'All' },
        ],
      },
    ],
  },
  linkedIssues: {
    title: 'Linked Issues options',
    hasCompact: true,
    hasRefreshInterval: false,
    hasHideInSession: true,
    specificSlots: [
      {
        key: 'filter',
        label: 'Default filter',
        kind: 'select',
        options: [
          { value: 'open', label: 'Open' },
          { value: 'all', label: 'All' },
          { value: 'primary', label: 'Primary only' },
        ],
      },
      {
        key: 'sortBy',
        label: 'Sort by',
        kind: 'select',
        options: [
          { value: 'last-activity', label: 'Last activity' },
          { value: 'linked-at', label: 'Linked at' },
          { value: 'state', label: 'State' },
          { value: 'number', label: 'Number' },
        ],
      },
    ],
  },
  localGit: {
    title: 'Local Git options',
    hasCompact: true,
    hasRefreshInterval: true,
    hasHideInSession: true,
    specificSlots: EMPTY,
  },
  notifications: {
    title: 'Notifications options',
    hasCompact: true,
    hasRefreshInterval: true,
    hasHideInSession: true,
    specificSlots: [
      {
        key: 'refreshSec',
        label: 'Poll every (seconds)',
        kind: 'number',
        min: 30,
        max: 600,
        hint: '30 to 600 seconds',
      },
    ],
  },
  liveActivity: {
    title: 'Live Activity options',
    hasCompact: true,
    hasRefreshInterval: false,
    hasHideInSession: true,
    specificSlots: EMPTY,
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/renderer/components/github/section-options-config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/github/menu/section-options-config.ts tests/unit/renderer/components/github/section-options-config.test.ts
git commit -m "feat(sidebar): section-options-config declares per-section slots"
```

---

### Task 5: Build `<SectionOptionsPopover>` with nested-popover-aware floating-ui

**Files:**
- Create: `src/renderer/components/github/menu/SectionOptionsPopover.tsx`
- Create: `tests/unit/renderer/components/github/SectionOptionsPopover.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/renderer/components/github/SectionOptionsPopover.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FloatingTree } from '@floating-ui/react'

const store = {
  sectionPrefsBySession: { s1: { ci: { filter: 'failing' as string | undefined, autoExpandOnFailure: true } } } as Record<string, Record<string, unknown>>,
  hiddenSectionsBySession: { s1: [] as string[] },
  hideSection: vi.fn(),
  setSectionPrefs: vi.fn(),
}

vi.mock('../../../../src/renderer/stores/githubStore', () => ({
  useGitHubStore: (sel: (s: typeof store) => unknown) => sel(store),
}))

vi.mock('../../../../src/renderer/stores/toastUndoStore', () => ({
  useToastUndoStore: Object.assign(
    (sel: any) => sel({ show: () => 'id', dismiss: () => undefined, runUndo: () => undefined, queue: [] }),
    { getState: () => ({ show: vi.fn(() => 'id'), dismiss: vi.fn(), runUndo: vi.fn(), queue: [] }) },
  ),
}))

import { SectionOptionsPopover } from '../../../../src/renderer/components/github/menu/SectionOptionsPopover'

function Wrap(props: React.ComponentProps<typeof SectionOptionsPopover>) {
  return <FloatingTree><SectionOptionsPopover {...props} /></FloatingTree>
}

describe('SectionOptionsPopover', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders the CI title + filter select + autoExpand toggle', () => {
    render(<Wrap sessionId="s1" sectionId="ci" open onClose={() => undefined} />)
    expect(screen.getByText(/CI .* options/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/default filter/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/auto-expand failed runs/i)).toBeInTheDocument()
  })

  it('changing the filter select calls setSectionPrefs with the new value', async () => {
    render(<Wrap sessionId="s1" sectionId="ci" open onClose={() => undefined} />)
    fireEvent.change(screen.getByLabelText(/default filter/i), { target: { value: 'all' } })
    await waitFor(() => {
      expect(store.setSectionPrefs).toHaveBeenCalledWith('s1', 'ci', { filter: 'all' })
    })
  })

  it('toggling autoExpand calls setSectionPrefs', async () => {
    render(<Wrap sessionId="s1" sectionId="ci" open onClose={() => undefined} />)
    fireEvent.click(screen.getByLabelText(/auto-expand failed runs/i))
    await waitFor(() => {
      expect(store.setSectionPrefs).toHaveBeenCalledWith('s1', 'ci', { autoExpandOnFailure: false })
    })
  })

  it('Hide in this session calls hideSection and closes', async () => {
    const onClose = vi.fn()
    render(<Wrap sessionId="s1" sectionId="ci" open onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /hide in this session/i }))
    await waitFor(() => {
      expect(store.hideSection).toHaveBeenCalledWith('s1', 'ci')
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('does not render when open is false', () => {
    const { container } = render(<Wrap sessionId="s1" sectionId="ci" open={false} onClose={() => undefined} />)
    expect(container.textContent).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/components/github/SectionOptionsPopover.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Write the component**

Create `src/renderer/components/github/menu/SectionOptionsPopover.tsx`:

```tsx
import { useRef, useId } from 'react'
import {
  useFloating, useInteractions, useDismiss, useRole, useClick,
  FloatingFocusManager, FloatingNode, useFloatingNodeId, useFloatingParentNodeId,
  offset, flip, shift,
} from '@floating-ui/react'
import { useGitHubStore } from '../../../stores/githubStore'
import { useToastUndoStore } from '../../../stores/toastUndoStore'
import type { GitHubSectionId, SectionPref } from '../../../../shared/github-types'
import { SECTION_OPTIONS_CONFIG, type SpecificSlot } from './section-options-config'

interface Props {
  sessionId: string
  sectionId: GitHubSectionId
  open: boolean
  onClose: () => void
  /** Anchor element from the parent; optional — if omitted popover renders un-anchored. */
  anchor?: HTMLElement | null
}

export function SectionOptionsPopover({ sessionId, sectionId, open, onClose, anchor }: Props) {
  const nodeId = useFloatingNodeId()
  const parentId = useFloatingParentNodeId()
  const cfg = SECTION_OPTIONS_CONFIG[sectionId]
  const labelId = useId()

  const prefs = useGitHubStore(
    (s) => (s as any).sectionPrefsBySession?.[sessionId]?.[sectionId] as SectionPref | undefined,
  )
  const hidden = useGitHubStore(
    (s) => ((s as any).hiddenSectionsBySession?.[sessionId] as GitHubSectionId[] | undefined) ?? [],
  )
  const setSectionPrefs = useGitHubStore((s) => (s as any).setSectionPrefs as
    (sessionId: string, id: GitHubSectionId, prefs: SectionPref) => Promise<void>)
  const hideSection = useGitHubStore((s) => (s as any).hideSection as
    (sessionId: string, id: GitHubSectionId) => Promise<void>)
  const unhideSection = useGitHubStore((s) => (s as any).unhideSection as
    (sessionId: string, id: GitHubSectionId) => Promise<void>)

  const { refs, floatingStyles, context } = useFloating({
    nodeId,
    open,
    onOpenChange: (next) => { if (!next) onClose() },
    placement: 'bottom-end',
    middleware: [offset(4), flip(), shift({ padding: 6 })],
    elements: anchor ? { reference: anchor } : undefined,
  })

  const dismiss = useDismiss(context, { bubbles: false })
  const role = useRole(context, { role: 'dialog' })
  const click = useClick(context, { enabled: false })
  const { getFloatingProps } = useInteractions([dismiss, role, click])

  const snapshotRef = useRef<SectionPref | undefined>(undefined)

  if (!open) {
    return parentId !== null ? <FloatingNode id={nodeId} /> : null
  }

  const writePref = (patch: Partial<SectionPref>) => {
    snapshotRef.current = prefs
    void setSectionPrefs(sessionId, sectionId, patch)
  }

  const onHideInSession = () => {
    const wasHidden = hidden.includes(sectionId)
    void hideSection(sessionId, sectionId)
    useToastUndoStore.getState().show({
      label: 'Hidden. Undo?',
      snapshot: { wasHidden },
      onUndo: (snap) => {
        if (snap && (snap as { wasHidden?: boolean }).wasHidden) return
        void unhideSection(sessionId, sectionId)
      },
    })
    onClose()
  }

  const body = (
    <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        aria-labelledby={labelId}
        className="z-30 w-64 rounded p-3 shadow-lg"
        {...getFloatingProps({
          onKeyDown: (e) => { if (e.key === 'Escape') onClose() },
        })}
        // Catppuccin Mocha base/surface0 frame via inline var so Tailwind stays layout-only
        // eslint-disable-next-line react/forbid-dom-props
      >
        <div
          className="rounded border p-3"
          style={{
            background: 'var(--color-base)',
            borderColor: 'var(--color-surface0)',
            color: 'var(--color-text)',
          }}
        >
          <div id={labelId} className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-overlay1)' }}>
            {cfg.title}
          </div>

          {cfg.hasCompact && (
            <label className="mb-2 flex items-center justify-between gap-2 text-sm">
              <span>Compact mode</span>
              <input
                type="checkbox"
                checked={Boolean(prefs?.compact)}
                onChange={(e) => writePref({ compact: e.target.checked })}
              />
            </label>
          )}

          {cfg.specificSlots.map((slot) => (
            <SlotControl
              key={slot.key as string}
              slot={slot}
              value={prefs?.[slot.key]}
              onChange={(v) => writePref({ [slot.key]: v } as Partial<SectionPref>)}
            />
          ))}

          {cfg.hasRefreshInterval && !cfg.specificSlots.some((s) => s.key === 'refreshSec') && (
            <label className="mt-2 flex items-center justify-between gap-2 text-sm">
              <span>Refresh every (s)</span>
              <input
                type="number"
                min={30}
                max={600}
                value={prefs?.refreshSec ?? ''}
                placeholder="default"
                onChange={(e) => {
                  const raw = e.target.value
                  if (raw === '') { writePref({ refreshSec: undefined }); return }
                  const n = Math.max(30, Math.min(600, Number(raw)))
                  writePref({ refreshSec: n })
                }}
                className="w-20 rounded px-2 py-0.5 text-right text-xs"
                style={{ background: 'var(--color-surface0)', color: 'var(--color-text)' }}
              />
            </label>
          )}

          {cfg.hasHideInSession && (
            <div className="mt-3 border-t pt-2" style={{ borderColor: 'var(--color-surface0)' }}>
              <button
                className="w-full rounded px-2 py-1 text-left text-sm font-medium transition-colors"
                style={{ color: 'var(--color-red)' }}
                onClick={onHideInSession}
              >
                Hide in this session
              </button>
            </div>
          )}
        </div>
      </div>
    </FloatingFocusManager>
  )

  return <FloatingNode id={nodeId}>{body}</FloatingNode>
}

function SlotControl({
  slot, value, onChange,
}: {
  slot: SpecificSlot
  value: unknown
  onChange: (v: unknown) => void
}) {
  const controlId = useId()
  if (slot.kind === 'boolean') {
    return (
      <label htmlFor={controlId} className="mb-2 flex items-center justify-between gap-2 text-sm">
        <span>{slot.label}</span>
        <input
          id={controlId}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    )
  }
  if (slot.kind === 'number') {
    return (
      <label htmlFor={controlId} className="mb-2 flex items-center justify-between gap-2 text-sm">
        <span>{slot.label}</span>
        <input
          id={controlId}
          type="number"
          min={slot.min}
          max={slot.max}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') { onChange(undefined); return }
            const n = Number(raw)
            const min = slot.min ?? -Infinity
            const max = slot.max ?? Infinity
            onChange(Math.max(min, Math.min(max, n)))
          }}
          className="w-24 rounded px-2 py-0.5 text-right text-xs"
          style={{ background: 'var(--color-surface0)', color: 'var(--color-text)' }}
        />
      </label>
    )
  }
  // select
  return (
    <label htmlFor={controlId} className="mb-2 flex items-center justify-between gap-2 text-sm">
      <span>{slot.label}</span>
      <select
        id={controlId}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        className="rounded px-2 py-0.5 text-xs"
        style={{ background: 'var(--color-surface0)', color: 'var(--color-text)' }}
      >
        <option value="">default</option>
        {slot.options?.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/renderer/components/github/SectionOptionsPopover.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/github/menu/SectionOptionsPopover.tsx tests/unit/renderer/components/github/SectionOptionsPopover.test.tsx
git commit -m "feat(sidebar): SectionOptionsPopover with per-section slots + Hide-in-session"
```

---

### Task 6: Migrate `<SidebarHeaderMenu>` onto `FloatingNode`

**Files:**
- Modify: `src/renderer/components/github/menu/SidebarHeaderMenu.tsx`

- [ ] **Step 1: Read the Phase 1a implementation**

Read the existing `SidebarHeaderMenu.tsx` from top to bottom so you understand its current prop surface. The changes wrap it without altering existing rows.

- [ ] **Step 2: Wrap the return value in `FloatingNode`**

At the top of the file, add imports:

```tsx
import {
  FloatingNode, FloatingFocusManager, useFloating, useFloatingNodeId,
  useInteractions, useDismiss, useRole, offset, flip, shift,
} from '@floating-ui/react'
```

Inside the component, replace the bare `if (!open) return null` + positioned `<div role="menu">` with a floating-ui wrapper. Keep the existing row-rendering JSX as `menuBody`. Example shape:

```tsx
export function SidebarHeaderMenu({ sessionId, open, onClose, anchor }: Props & { anchor?: HTMLElement | null }) {
  const nodeId = useFloatingNodeId()
  const { refs, floatingStyles, context } = useFloating({
    nodeId,
    open,
    onOpenChange: (next) => { if (!next) onClose() },
    placement: 'bottom-end',
    middleware: [offset(4), flip(), shift({ padding: 6 })],
    elements: anchor ? { reference: anchor } : undefined,
  })
  const dismiss = useDismiss(context, { bubbles: false })
  const role = useRole(context, { role: 'menu' })
  const { getFloatingProps } = useInteractions([dismiss, role])

  // …existing selectors + buildMenuRows() stay untouched…

  if (!open) return <FloatingNode id={nodeId} />

  const menuBody = (
    <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        role="menu"
        aria-label="Sidebar sections"
        className="z-20 w-64 rounded p-2 shadow-lg"
        {...getFloatingProps({ onKeyDown: (e) => { if (e.key === 'Escape') onClose() } })}
      >
        <div
          className="rounded border p-2"
          style={{ background: 'var(--color-base)', borderColor: 'var(--color-surface0)' }}
        >
          {/* existing rows + footer buttons unchanged */}
        </div>
      </div>
    </FloatingFocusManager>
  )

  return <FloatingNode id={nodeId}>{menuBody}</FloatingNode>
}
```

Important: `bubbles: false` on `useDismiss` is what keeps a click inside a child popover from cascading up and closing the parent menu. The `FloatingTree` host in Task 7 then lets the child's own `useDismiss` close only itself.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Re-run Phase 1a's SidebarHeaderMenu tests**

Run: `npx vitest run tests/unit/renderer/components/github/SidebarHeaderMenu.test.tsx`
Expected: PASS (existing tests still green). Adjust test `render()` to wrap in `<FloatingTree>` if the tests now complain about a missing tree context.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/github/menu/SidebarHeaderMenu.tsx tests/unit/renderer/components/github/SidebarHeaderMenu.test.tsx
git commit -m "feat(sidebar): SidebarHeaderMenu uses FloatingNode + FloatingFocusManager"
```

---

### Task 7: Host `FloatingTree` in `PanelHeader` + mount ToastUndo

**Files:**
- Modify: `src/renderer/components/github/PanelHeader.tsx`

- [ ] **Step 1: Read the current file**

Read the existing `PanelHeader.tsx` once. Identify where the master `⋯` button is (added in Phase 1a). The wrapper must surround both the master button AND the section `⋯` buttons so all nodes share one tree.

- [ ] **Step 2: Wrap the render in `FloatingTree`**

At the top of the return, wrap the entire JSX tree in `<FloatingTree>`:

```tsx
import { FloatingTree } from '@floating-ui/react'
import { ToastUndo } from '../common/ToastUndo'

// …component body up to return:

return (
  <FloatingTree>
    <div className="flex items-center gap-2 px-3 py-2 border-b border-surface0 bg-mantle">
      {/* existing header contents including the master ⋯ button from Phase 1a */}
    </div>
    <ToastUndo />
  </FloatingTree>
)
```

The `FloatingTree` only affects descendant popovers — plain DOM nodes render unchanged. `ToastUndo` lives here so any destructive action in any descendant popover finds a mounted host.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/github/PanelHeader.tsx
git commit -m "feat(sidebar): host FloatingTree + ToastUndo in PanelHeader"
```

---

### Task 8: Add `⋯` trigger to `SectionFrame` + open `SectionOptionsPopover`

**Files:**
- Modify: `src/renderer/components/github/SectionFrame.tsx`

- [ ] **Step 1: Read current SectionFrame**

Confirm where the existing right-side icon cluster lives (near line 44-53 in the current file). The new `⋯` trigger joins it.

- [ ] **Step 2: Edit SectionFrame**

Extend the props interface + render so a `⋯` trigger opens `<SectionOptionsPopover>` anchored to that trigger:

```tsx
import { useState, useRef, type ReactNode } from 'react'
import { useGitHubStore } from '../../stores/githubStore'
import { SectionOptionsPopover } from './menu/SectionOptionsPopover'
import type { GitHubSectionId } from '../../../shared/github-types'

interface Props {
  sessionId: string
  id: GitHubSectionId
  title: string
  summary?: ReactNode
  rightAction?: ReactNode
  emptyIndicator?: boolean
  defaultCollapsed?: boolean
  children: ReactNode
}

export default function SectionFrame({
  sessionId, id, title, summary, rightAction,
  emptyIndicator, defaultCollapsed, children,
}: Props) {
  const saved = useGitHubStore((s) => s.sessionStates[sessionId]?.collapsedSections[id])
  const collapsed = saved ?? defaultCollapsed ?? false
  const setCollapsed = useGitHubStore((s) => s.setSectionCollapsed)

  const [optionsOpen, setOptionsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  return (
    <section className="border-b border-surface0" data-section-id={id}>
      <div className="flex items-center gap-2 px-3 py-2 hover:bg-surface0/50">
        <button
          aria-expanded={!collapsed}
          aria-controls={`sec-body-${id}`}
          className="flex flex-1 items-center gap-2 text-left focus:outline focus:outline-2 focus:outline-blue"
          onClick={() => setCollapsed(sessionId, id, !collapsed)}
        >
          <span className="text-xs text-mauve w-3" aria-hidden="true">
            {collapsed ? String.fromCodePoint(0x25b6) : String.fromCodePoint(0x25bc)}
          </span>
          <span className="text-xs font-medium uppercase text-subtext0 tracking-wide">{title}</span>
          {summary && <span className="text-xs text-overlay1 ml-2 truncate">{summary}</span>}
        </button>

        <span className="ml-auto flex items-center gap-2 shrink-0">
          {emptyIndicator && (
            <span className="text-xs text-overlay0" aria-label="empty">
              {String.fromCodePoint(0x2014)}
            </span>
          )}
          {rightAction}
          <button
            ref={triggerRef}
            aria-label={`${title} options`}
            aria-expanded={optionsOpen}
            className="rounded p-0.5 text-overlay0 transition-colors hover:text-text hover:bg-surface0"
            onClick={(e) => { e.stopPropagation(); setOptionsOpen((v) => !v) }}
          >
            {String.fromCodePoint(0x22ef)}
          </button>
          <SectionOptionsPopover
            sessionId={sessionId}
            sectionId={id}
            open={optionsOpen}
            onClose={() => setOptionsOpen(false)}
            anchor={triggerRef.current}
          />
        </span>
      </div>

      {!collapsed && (
        <div id={`sec-body-${id}`} className="px-3 pb-3">
          {children}
        </div>
      )}
    </section>
  )
}
```

Two behaviour-preserving notes:
- The `⋯` click `stopPropagation()`s so it doesn't trigger the collapse/expand toggle.
- The popover is always mounted (so `FloatingNode` registers with the tree) but renders nothing when `open` is false.

- [ ] **Step 3: Update any callers that passed `id: string`**

If any existing section passes a non-`GitHubSectionId` string (e.g. an ad-hoc debug section) the TypeScript error surfaces here. Fix by narrowing the string to `GitHubSectionId` or widen `Props.id` back to `GitHubSectionId | string` with a runtime guard before calling `SectionOptionsPopover`. Expected: types are already aligned because Phase 1a introduced `GitHubSectionId`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/github/SectionFrame.tsx
git commit -m "feat(sidebar): SectionFrame adds per-section options trigger"
```

---

### Task 9: Nested-popover focus integration test

**Files:**
- Create: `tests/unit/renderer/components/github/nested-popover-focus.test.tsx`

- [ ] **Step 1: Write the test**

Create `tests/unit/renderer/components/github/nested-popover-focus.test.tsx`:

```tsx
import React, { useState, useRef } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { FloatingTree } from '@floating-ui/react'

// Shared mock store used by both popovers
const store = {
  featureToggles: { activePR: true, ci: true, reviews: true, linkedIssues: true, notifications: true, localGit: true, sessionContext: true },
  profiles: { p1: { capabilities: ['notifications', 'pulls', 'actions', 'issues', 'contents'] } },
  hiddenSectionsBySession: { s1: [] as string[] },
  defaultVisibleSections: null as string[] | null,
  sectionPrefsBySession: { s1: {} as Record<string, unknown> },
  hideSection: vi.fn(async () => undefined),
  unhideSection: vi.fn(async () => undefined),
  resetHidden: vi.fn(async () => undefined),
  saveAsDefault: vi.fn(async () => undefined),
  clearDefault: vi.fn(async () => undefined),
  setSectionPrefs: vi.fn(async () => undefined),
}
vi.mock('../../../../src/renderer/stores/githubStore', () => ({
  useGitHubStore: (sel: (s: typeof store) => unknown) => sel(store),
}))
vi.mock('../../../../src/renderer/stores/toastUndoStore', () => ({
  useToastUndoStore: Object.assign(
    (sel: any) => sel({ show: () => 'id', dismiss: () => undefined, runUndo: () => undefined, queue: [] }),
    { getState: () => ({ show: vi.fn(() => 'id'), dismiss: vi.fn(), runUndo: vi.fn(), queue: [] }) },
  ),
}))

import { SidebarHeaderMenu } from '../../../../src/renderer/components/github/menu/SidebarHeaderMenu'
import { SectionOptionsPopover } from '../../../../src/renderer/components/github/menu/SectionOptionsPopover'

function Harness() {
  const [parentOpen, setParentOpen] = useState(true)
  const [childOpen, setChildOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <FloatingTree>
      <button ref={anchorRef} onClick={() => setChildOpen((v) => !v)}>open child</button>
      <SidebarHeaderMenu sessionId="s1" open={parentOpen} onClose={() => setParentOpen(false)} />
      <SectionOptionsPopover
        sessionId="s1"
        sectionId="ci"
        open={childOpen}
        onClose={() => setChildOpen(false)}
        anchor={anchorRef.current}
      />
    </FloatingTree>
  )
}

describe('nested popover focus and dismiss behaviour', () => {
  it('opening the child popover does not close the parent', () => {
    render(<Harness />)
    expect(screen.getByRole('menu', { name: /sidebar sections/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'open child' }))
    expect(screen.getByText(/CI .* options/i)).toBeInTheDocument()
    expect(screen.getByRole('menu', { name: /sidebar sections/i })).toBeInTheDocument()
  })

  it('Escape inside the child closes only the child', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'open child' }))
    const childDialog = screen.getByText(/CI .* options/i).closest('[role="dialog"]')
    expect(childDialog).toBeTruthy()
    act(() => { fireEvent.keyDown(childDialog!, { key: 'Escape' }) })
    expect(screen.queryByText(/CI .* options/i)).not.toBeInTheDocument()
    // Parent still open:
    expect(screen.getByRole('menu', { name: /sidebar sections/i })).toBeInTheDocument()
  })

  it('clicking outside both closes them from outer in', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'open child' }))
    expect(screen.getByText(/CI .* options/i)).toBeInTheDocument()
    act(() => { fireEvent.mouseDown(document.body) })
    // Both should eventually close; floating-ui dispatches in dom order.
    expect(screen.queryByText(/CI .* options/i)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/unit/renderer/components/github/nested-popover-focus.test.tsx`
Expected: PASS (3 tests). If one of the dismissal assertions fails, double-check `useDismiss(..., { bubbles: false })` in `SidebarHeaderMenu` — `bubbles: true` would cascade-close the parent on child click.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/renderer/components/github/nested-popover-focus.test.tsx
git commit -m "test(sidebar): nested popover focus + dismiss integration"
```

---

### Task 10: Manual smoke test + typecheck + full test run + PR

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS with no new errors.

- [ ] **Step 2: Full unit test run**

Run: `npx vitest run`
Expected: PASS — all previous tests + the 4 new files added here.

- [ ] **Step 3: Manual smoke in dev**

Run: `npm run dev`

Walk through:
1. Open sidebar, click the master `⋯` — verify parent menu opens.
2. Click a section's `⋯` (e.g. CI) — verify the child popover opens AND the master menu stays rendered behind it.
3. Press `Esc` inside the child — verify only the child closes.
4. Click "Hide in this session" on CI — CI row disappears from sidebar, a toast "Hidden. Undo?" appears bottom-right, Undo click brings CI back.
5. Let the toast auto-dismiss (5s) — verify it fades out.
6. Quickly click "Hide" on two sections in a row — verify both toasts stack, neither clobbers the other.
7. Change the CI filter select to "failing" — reopen the popover after closing it — verify the select remembers "failing".
8. Resize the sidebar to its minimum 280px — verify the `⋯` triggers don't overflow; if they do, hide them until hover as the spec's risk table mandates (small-width polish can defer to a follow-up; note it in the PR description if so).

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/sidebar-section-options
gh pr create --title "sidebar 1b: section options popover + ToastUndo + nested popover focus" --body "$(cat <<'EOF'
## Summary
- Adds `@floating-ui/react` dependency.
- Introduces `<SectionOptionsPopover>` generic per-section popover with a `SECTION_OPTIONS_CONFIG` lookup declaring per-section slots (CI filter + autoExpandOnFailure, Reviews filter, Linked Issues filter + sort, Notifications refresh interval).
- Introduces `<ToastUndo>` as a real component driven by a queueable `toastUndoStore`. 5s default, portal-rendered, `aria-live="polite"`.
- Migrates `<SidebarHeaderMenu>` onto `FloatingNode` + `FloatingFocusManager` and wraps the sidebar header in a `FloatingTree` so the master and per-section popovers share a single focus stack. Clicking a child popover no longer tears down the parent; Esc dismisses only the topmost layer.
- Wires "Hide in this session" end-to-end as the reference destructive-action pattern: fires `githubStore.hideSection`, surfaces a "Hidden. Undo?" toast with a snapshot, undo restores via `unhideSection`.

## Test plan
- [x] `npx vitest run` green.
- [x] `npm run typecheck` green.
- [x] Smoke: master menu + child CI popover coexist, Esc closes child only.
- [x] Smoke: Hide a section via its popover, see toast, click Undo, section returns.
- [x] Smoke: two rapid Hide actions stack two toasts, each undoable.
- [x] Smoke: changing a CI filter / autoExpand slot persists across popover re-open.
EOF
)"
```

---

## Self-review checklist

- [ ] Every task has exact file paths.
- [ ] Every code step shows the full code to write (no "similar to" placeholders).
- [ ] Every test has expected failure / expected pass output.
- [ ] `@floating-ui/react` added as a runtime dependency, not devDependency.
- [ ] `SidebarHeaderMenu` and `SectionOptionsPopover` both wrap themselves in `FloatingNode` — required for `FloatingTree` to register them.
- [ ] `useDismiss(..., { bubbles: false })` on BOTH popovers so clicks inside the child do not cascade-close the parent.
- [ ] `ToastUndo` is a portal so its fixed-position layer cannot be clipped by sidebar overflow.
- [ ] `toastUndoStore.show()` is queueing, not clobbering — verified by the queue-length test.
- [ ] The only user-visible new flow is `SectionOptionsPopover` + Hide-in-session + ToastUndo. Existing sections render unchanged until the user touches the new `⋯`.
- [ ] No `\u{...}` escapes — `String.fromCodePoint(0x22ef)` and `String.fromCodePoint(0x2715)` used.
- [ ] No Node imports in renderer.
- [ ] Catppuccin colours via `var(--color-<name>)` inline styles; Tailwind used for layout only.
- [ ] No em dashes in user-visible strings (`"Hidden. Undo?"`, `"Hide in this session"`, `"30 to 600 seconds"` — all clean).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
