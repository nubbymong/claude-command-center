import { describe, it, expect, beforeEach } from 'vitest'
import type { HookEvent } from '../../../src/shared/hook-types'
import { useHooksStore } from '../../../src/renderer/stores/hooksStore'

function mkEvent(sid: string, ts: number, event: 'PreToolUse' | 'PostToolUse' = 'PreToolUse'): HookEvent {
  return { sessionId: sid, event, summary: '', payload: {}, ts }
}

describe('hooksStore', () => {
  beforeEach(() => {
    useHooksStore.setState({
      eventsBySession: new Map(),
      droppedBySession: new Map(),
      paused: false,
      filter: null,
    })
  })

  it('appends events to the right session', () => {
    useHooksStore.getState().ingest(mkEvent('a', 1))
    useHooksStore.getState().ingest(mkEvent('b', 2, 'PostToolUse'))
    expect(useHooksStore.getState().eventsBySession.get('a')?.length).toBe(1)
    expect(useHooksStore.getState().eventsBySession.get('b')?.length).toBe(1)
  })

  it('caps renderer-side list at 200 entries', () => {
    for (let i = 0; i < 300; i++) {
      useHooksStore.getState().ingest(mkEvent('a', i))
    }
    const list = useHooksStore.getState().eventsBySession.get('a')!
    expect(list.length).toBe(200)
    // Oldest entries dropped (FIFO); ts 100 is the first kept one.
    expect(list[0].ts).toBe(100)
    expect(list[list.length - 1].ts).toBe(299)
  })

  it('rehydrate replaces the list entirely (trims to 200)', () => {
    useHooksStore.getState().ingest(mkEvent('a', 1))
    const fresh = Array.from({ length: 250 }, (_, i) => mkEvent('a', i))
    useHooksStore.getState().rehydrate('a', fresh)
    const list = useHooksStore.getState().eventsBySession.get('a')!
    expect(list.length).toBe(200)
    expect(list[0].ts).toBe(50)
  })

  it('clearSession removes session entries + dropped flag', () => {
    useHooksStore.getState().ingest(mkEvent('a', 1))
    useHooksStore.getState().markDropped('a')
    useHooksStore.getState().clearSession('a')
    expect(useHooksStore.getState().eventsBySession.has('a')).toBe(false)
    expect(useHooksStore.getState().droppedBySession.has('a')).toBe(false)
  })

  it('markDropped sets the per-session dropped latch', () => {
    useHooksStore.getState().markDropped('a')
    expect(useHooksStore.getState().droppedBySession.get('a')).toBe(true)
  })

  it('setPaused toggles the paused flag without touching events', () => {
    useHooksStore.getState().ingest(mkEvent('a', 1))
    useHooksStore.getState().setPaused(true)
    expect(useHooksStore.getState().paused).toBe(true)
    expect(useHooksStore.getState().eventsBySession.get('a')?.length).toBe(1)
  })

  it('setFilter replaces the filter set', () => {
    useHooksStore.getState().setFilter(new Set(['PreToolUse']))
    expect(useHooksStore.getState().filter?.has('PreToolUse')).toBe(true)
    useHooksStore.getState().setFilter(null)
    expect(useHooksStore.getState().filter).toBeNull()
  })
})
