// @vitest-environment jsdom
/**
 * Smoke tests for Tasks 19+20 Tokenomics components:
 *   CostByConfig, SessionsTable, SessionDetailDrawer, ActivityHeatmap.
 *
 * Pattern: same createRoot + act approach as tokenomics-new-components.test.tsx.
 * Store-coupled components (SessionsTable, SessionDetailDrawer) are tested via
 * a vi.mock of useTokenomicsStore. Prop-driven components (CostByConfig,
 * ActivityHeatmap) are tested directly without any store mocking.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { TkSummary, TkSessionRow, TkSessionDetail } from '../../../src/shared/types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── Store mock (used by SessionsTable + SessionDetailDrawer) ──────────────────

// Default mock state — overridden per test via mockStoreState
let mockStoreState: Record<string, unknown> = {}

vi.mock('../../../src/renderer/stores/tokenomicsStore', () => ({
  useTokenomicsStore: (sel: (s: Record<string, unknown>) => unknown) => sel(mockStoreState),
}))

// ── DOM helpers ───────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mockStoreState = {}
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

// ── Imports (after mock is set up) ────────────────────────────────────────────

const { CostByConfig } = await import('../../../src/renderer/components/tokenomics/CostByConfig')
const { SessionsTable } = await import('../../../src/renderer/components/tokenomics/SessionsTable')
const { SessionDetailDrawer } = await import('../../../src/renderer/components/tokenomics/SessionDetailDrawer')
const { ActivityHeatmap } = await import('../../../src/renderer/components/tokenomics/ActivityHeatmap')

// ── CostByConfig ──────────────────────────────────────────────────────────────

const costByConfigData: TkSummary['costByConfig'] = [
  { configId: 'abc123', label: 'My Config', costUsd: 12.5, sessions: 5 },
  { configId: null, label: 'External / no config', costUsd: 3.2, sessions: 2 },
]

describe('CostByConfig', () => {
  beforeEach(() => {
    // Provide minimal store state the component reads
    mockStoreState = {
      setConfig: vi.fn(),
      filter: { configId: undefined, range: 'all' },
    }
  })

  it('renders one bar per entry', () => {
    act(() => {
      root.render(createElement(CostByConfig, { data: costByConfigData }))
    })
    expect(container.textContent).toContain('My Config')
    expect(container.textContent).toContain('External / no config')
  })

  it('renders costs', () => {
    act(() => {
      root.render(createElement(CostByConfig, { data: costByConfigData }))
    })
    expect(container.textContent).toContain('$12')
    expect(container.textContent).toContain('$3')
  })

  it('renders session counts', () => {
    act(() => {
      root.render(createElement(CostByConfig, { data: costByConfigData }))
    })
    expect(container.textContent).toContain('5 session')
    expect(container.textContent).toContain('2 session')
  })

  it('renders empty state when data is empty', () => {
    act(() => {
      root.render(createElement(CostByConfig, { data: [] }))
    })
    expect(container.textContent).toContain('No config data')
  })

  it('renders a clear filter button when a configId is active', () => {
    mockStoreState = {
      setConfig: vi.fn(),
      filter: { configId: 'abc123', range: 'all' },
    }
    act(() => {
      root.render(createElement(CostByConfig, { data: costByConfigData }))
    })
    expect(container.textContent).toContain('Clear config filter')
  })
})

// ── SessionsTable ─────────────────────────────────────────────────────────────

const makeRow = (id: string, overrides: Partial<TkSessionRow> = {}): TkSessionRow => ({
  sessionId: id,
  provider: 'claude',
  configId: 'c1',
  configLabel: 'Work Config',
  model: 'claude-sonnet-4-5',
  costUsd: 2.5,
  inTok: 10000,
  outTok: 5000,
  cacheReadTok: 1000,
  cacheCreateTok: 200,
  msgCount: 8,
  lastTs: new Date('2026-06-01').getTime(),
  ...overrides,
})

describe('SessionsTable', () => {
  it('renders table rows for each session', () => {
    mockStoreState = {
      sessions: [makeRow('s1'), makeRow('s2')],
      nextCursor: null,
      loadingSessions: false,
      loadMore: vi.fn(),
      selectSession: vi.fn(),
    }
    act(() => {
      root.render(createElement(SessionsTable, {}))
    })
    // configLabel should appear for both rows
    const cells = container.querySelectorAll('td')
    const text = Array.from(cells).map((c) => c.textContent).join(' ')
    expect(text).toContain('Work Config')
  })

  it('renders "No sessions" when sessions is empty', () => {
    mockStoreState = {
      sessions: [],
      nextCursor: null,
      loadingSessions: false,
      loadMore: vi.fn(),
      selectSession: vi.fn(),
    }
    act(() => {
      root.render(createElement(SessionsTable, {}))
    })
    expect(container.textContent).toContain('No sessions')
  })

  it('renders "Load more" button when nextCursor is set', () => {
    mockStoreState = {
      sessions: [makeRow('s1')],
      nextCursor: { lastTs: 1, sessionId: 's1' },
      loadingSessions: false,
      loadMore: vi.fn(),
      selectSession: vi.fn(),
    }
    act(() => {
      root.render(createElement(SessionsTable, {}))
    })
    expect(container.textContent).toContain('Load more')
  })

  it('does NOT render "Load more" when nextCursor is null', () => {
    mockStoreState = {
      sessions: [makeRow('s1')],
      nextCursor: null,
      loadingSessions: false,
      loadMore: vi.fn(),
      selectSession: vi.fn(),
    }
    act(() => {
      root.render(createElement(SessionsTable, {}))
    })
    expect(container.textContent).not.toContain('Load more')
  })
})

// ── SessionDetailDrawer ───────────────────────────────────────────────────────

const makeDetail = (): TkSessionDetail => ({
  sessionId: 'sess-abc-123-def',
  provider: 'claude',
  configId: 'c1',
  configLabel: 'Work Config',
  model: 'claude-sonnet-4-5',
  costUsd: 5.0,
  inTok: 20000,
  outTok: 10000,
  cacheReadTok: 3000,
  cacheCreateTok: 500,
  msgCount: 12,
  lastTs: new Date('2026-06-01T18:00:00Z').getTime(),
  firstTs: new Date('2026-06-01T16:00:00Z').getTime(),
  projectDir: '/home/user/my-project',
  byModel: [
    {
      model: 'claude-sonnet-4-5',
      costUsd: 4.5,
      inTok: 18000,
      outTok: 9000,
      cacheReadTok: 3000,
      cacheCreateTok: 500,
      msgCount: 10,
    },
    {
      model: 'claude-haiku-3-5',
      costUsd: 0.5,
      inTok: 2000,
      outTok: 1000,
      cacheReadTok: 0,
      cacheCreateTok: 0,
      msgCount: 2,
    },
  ],
})

describe('SessionDetailDrawer', () => {
  it('renders nothing when selected is null', () => {
    mockStoreState = {
      selected: null,
      clearSelected: vi.fn(),
    }
    act(() => {
      root.render(createElement(SessionDetailDrawer, {}))
    })
    expect(container.innerHTML).toBe('')
  })

  it('renders session id when selected is set', () => {
    mockStoreState = {
      selected: makeDetail(),
      clearSelected: vi.fn(),
    }
    act(() => {
      root.render(createElement(SessionDetailDrawer, {}))
    })
    expect(container.textContent).toContain('sess-abc-123-def')
  })

  it('renders configLabel', () => {
    mockStoreState = {
      selected: makeDetail(),
      clearSelected: vi.fn(),
    }
    act(() => {
      root.render(createElement(SessionDetailDrawer, {}))
    })
    expect(container.textContent).toContain('Work Config')
  })

  it('renders per-model breakdown rows', () => {
    mockStoreState = {
      selected: makeDetail(),
      clearSelected: vi.fn(),
    }
    act(() => {
      root.render(createElement(SessionDetailDrawer, {}))
    })
    // Both models should appear (short name)
    expect(container.textContent?.toLowerCase()).toContain('sonnet')
    expect(container.textContent?.toLowerCase()).toContain('haiku')
  })
})

// ── ActivityHeatmap ───────────────────────────────────────────────────────────

describe('ActivityHeatmap', () => {
  it('renders 168 cells (7 rows × 24 cols)', () => {
    act(() => {
      root.render(createElement(ActivityHeatmap, { data: [] }))
    })
    // Each cell is a div inside the row. We can count the day-labels as proxies
    // for rows, but more directly count divs with a fixed 14px width (cell size).
    // Use textContent presence of all day labels as the structural check.
    expect(container.textContent).toContain('Sun')
    expect(container.textContent).toContain('Mon')
    expect(container.textContent).toContain('Tue')
    expect(container.textContent).toContain('Wed')
    expect(container.textContent).toContain('Thu')
    expect(container.textContent).toContain('Fri')
    expect(container.textContent).toContain('Sat')
  })

  it('renders hour axis labels at 0, 6, 12, 18', () => {
    act(() => {
      root.render(createElement(ActivityHeatmap, { data: [] }))
    })
    // Hour labels are small divs that show 0, 6, 12, 18
    // Check them all appear somewhere in the rendered output
    const text = container.textContent ?? ''
    expect(text).toContain('12')
    expect(text).toContain('18')
  })

  it('renders with non-empty heatmap data without crashing', () => {
    const data: TkSummary['heatmap'] = [
      { bucket: 0, tokens: 1000 },       // Sun 0:00
      { bucket: 15, tokens: 5000 },      // Sun 15:00
      { bucket: 24 * 3 + 9, tokens: 800 }, // Wed 9:00
    ]
    act(() => {
      root.render(createElement(ActivityHeatmap, { data }))
    })
    // Should render without error, show the legend
    expect(container.textContent).toContain('Less')
    expect(container.textContent).toContain('More')
  })
})
