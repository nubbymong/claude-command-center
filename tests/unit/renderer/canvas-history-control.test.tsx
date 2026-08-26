// @vitest-environment jsdom
//
// The two-level history control (item C, phase 4): a per-artifact version
// stepper and a History ▾ picker. Row actions (archive/delete) arrive as props
// in phase 5 and are covered there.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import CanvasHistoryControl from '../../../src/renderer/components/CanvasHistoryControl'
import type { CanvasVersion } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const v = (id: string, mode: CanvasVersion['mode'], over: Partial<CanvasVersion> = {}): CanvasVersion => ({
  id,
  mode,
  createdAt: '2026-08-24T10:00:00Z',
  source: mode === 'uat' ? { mode: 'uat', distRoot: '/d', entry: 'index.html' } : { mode: 'design', entry: 'index.html' },
  ...over,
})

let container: HTMLDivElement
let root: Root

async function render(props: Partial<React.ComponentProps<typeof CanvasHistoryControl>> & { versions: CanvasVersion[]; activeVersionId: string }): Promise<void> {
  await act(async () => {
    root.render(<CanvasHistoryControl onSelectVersion={() => {}} {...props} />)
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  nowSpy?.mockRestore()
  nowSpy = null
})

// #456: a freshly-armed confirm ignores activation for CONFIRM_GUARD_MS so a
// double-click cannot arm and fire in one gesture. Deliberate confirms jump a
// mocked clock past the window instead of really waiting.
let nowSpy: ReturnType<typeof vi.spyOn> | null = null
function passGuard(): void {
  const later = Date.now() + 60_000
  nowSpy?.mockRestore()
  nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => later)
}

describe('the version stepper', () => {
  it('C3: even a single version renders the control — the dropdown is never sometimes', async () => {
    await render({ versions: [v('v1', 'design')], activeVersionId: 'v1' })
    const stepper = container.querySelector('[data-testid="canvas-version-stepper"]')
    expect(stepper).not.toBeNull()
    expect(stepper!.textContent).toContain('of 1')
    expect(container.querySelector('[data-testid="canvas-history-button"]')).not.toBeNull()
  })

  it('steps within the current artifact only, and disables the ends', async () => {
    const onSelectVersion = vi.fn()
    // Plan run v1..v3, then a mockup v4 — the stepper walks the PLAN.
    await render({ versions: [v('v1', 'plan'), v('v2', 'plan'), v('v3', 'plan'), v('v4', 'design')], activeVersionId: 'v2', onSelectVersion })
    const stepper = container.querySelector('[data-testid="canvas-version-stepper"]')!
    const prev = stepper.querySelector('[aria-label="Previous version of this artifact"]') as HTMLButtonElement
    const next = stepper.querySelector('[aria-label="Next version of this artifact"]') as HTMLButtonElement
    expect(prev.disabled).toBe(false)
    expect(next.disabled).toBe(false)
    expect(stepper.textContent).toContain('of 3')

    await act(async () => next.click())
    expect(onSelectVersion).toHaveBeenCalledWith('v3')

    // At v1 the previous is disabled (does not cross into another artifact).
    await render({ versions: [v('v1', 'plan'), v('v2', 'plan'), v('v3', 'plan'), v('v4', 'design')], activeVersionId: 'v1', onSelectVersion })
    const s2 = container.querySelector('[data-testid="canvas-version-stepper"]')!
    expect((s2.querySelector('[aria-label="Previous version of this artifact"]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the History picker', () => {
  it('lists artifacts and opens one at its latest version', async () => {
    const onSelectVersion = vi.fn()
    await render({ versions: [v('v1', 'plan'), v('v2', 'plan'), v('v3', 'design')], activeVersionId: 'v1', onSelectVersion })
    await act(async () => (container.querySelector('[data-testid="canvas-history-button"]') as HTMLButtonElement).click())
    // C3: the CURRENT artifact lists its versions directly (the history);
    // other artifacts keep their picker rows below.
    expect(container.querySelectorAll('[data-testid="canvas-history-version-row"]').length).toBeGreaterThan(0)
    const rows = container.querySelectorAll('[data-testid="canvas-history-row"]')
    expect(rows).toHaveLength(1)
    // Pick the mockup artifact — opens its latest (only) version v3.
    const mockupRow = Array.from(rows).find((r) => r.getAttribute('data-artifact-kind') === 'design')!
    await act(async () => (mockupRow.querySelector('button') as HTMLButtonElement).click())
    expect(onSelectVersion).toHaveBeenCalledWith('v3')
  })

  it('separates legacy uat builds into an Archived group', async () => {
    await render({ versions: [v('v1', 'design'), v('v2', 'uat')], activeVersionId: 'v1' })
    await act(async () => (container.querySelector('[data-testid="canvas-history-button"]') as HTMLButtonElement).click())
    expect(container.querySelector('[data-testid="canvas-history-popover"]')?.textContent).toContain('Archived')
    const uatRow = Array.from(container.querySelectorAll('[data-testid="canvas-history-row"]')).find(
      (r) => r.getAttribute('data-artifact-kind') === 'uat',
    )!
    expect(uatRow.textContent).toContain('ARCHIVED')
  })

  it('shows archive + delete row actions only when wired (phase 5)', async () => {
    const onArchive = vi.fn()
    const onDelete = vi.fn()
    await render({ versions: [v('v1', 'plan'), v('v2', 'design')], activeVersionId: 'v1', onArchive, onDelete })
    await act(async () => (container.querySelector('[data-testid="canvas-history-button"]') as HTMLButtonElement).click())
    expect(container.querySelector('[data-testid="canvas-history-archive"]')).not.toBeNull()
    // Delete confirms first: the initial control is "delete…", the confirm is separate.
    const del = container.querySelector('[data-testid="canvas-history-delete"]') as HTMLButtonElement
    expect(del).not.toBeNull()
    await act(async () => del.click())
    expect(container.querySelector('[data-testid="canvas-history-delete-confirm"]')).not.toBeNull()
    expect(onDelete).not.toHaveBeenCalled()
    passGuard()
    await act(async () => (container.querySelector('[data-testid="canvas-history-delete-confirm"]') as HTMLButtonElement).click())
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('a double-click cannot arm and fire in one gesture, and arming moves focus to the confirm (#456)', async () => {
    const onDelete = vi.fn()
    await render({ versions: [v('v1', 'plan'), v('v2', 'design')], activeVersionId: 'v1', onDelete })
    await act(async () => (container.querySelector('[data-testid="canvas-history-button"]') as HTMLButtonElement).click())

    // Both clicks of a double-click land at one point: arm, then the freshly
    // armed confirm. Inside the guard window nothing may fire.
    await act(async () => (container.querySelector('[data-testid="canvas-history-delete"]') as HTMLButtonElement).click())
    const confirm = container.querySelector('[data-testid="canvas-history-delete-confirm"]') as HTMLButtonElement
    expect(document.activeElement).toBe(confirm)
    await act(async () => confirm.click())
    expect(onDelete).not.toHaveBeenCalled()
    // Still armed — the delete waits for a deliberate second decision.
    expect(container.querySelector('[data-testid="canvas-history-delete-confirm"]')).not.toBeNull()

    passGuard()
    await act(async () => (container.querySelector('[data-testid="canvas-history-delete-confirm"]') as HTMLButtonElement).click())
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
