/**
 * The store rules the one-row bar leans on (ADR-018 D6, D7):
 *   - moveCommand rewrites ONLY the target band's ordinals, `beforeId` null
 *     means the end of the band, and a move INTO the other band is the scope
 *     change the bar has already confirmed (config band takes `configId`,
 *     Global clears it); it persists at once -- a drag is a deliberate act;
 *   - setCommandSection is the only path that writes `sectionId`, and clears it;
 *   - togglePinned flips and UN-sets (never leaves `pinned: false` litter);
 *   - clearReview drops the upgrade tag and writes nothing when there was none.
 * The bar's own tests mock this store wholesale, so these rules live here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn(), saveConfigDebounced: vi.fn() }))

const { useCommandStore } = await import('../../../src/renderer/stores/commandStore')
const { saveConfigNow } = await import('../../../src/renderer/utils/config-saver')
type CustomCommand = import('../../../src/renderer/stores/commandStore').CustomCommand

const cmd = (id: string, over: Partial<CustomCommand> = {}): CustomCommand => ({ id, label: id, prompt: 'x', scope: 'global', ...over })
const byId = (id: string) => useCommandStore.getState().commands.find((c) => c.id === id)!
const orderOf = (ids: string[]) => ids.map((id) => [id, byId(id).order])

beforeEach(() => {
  useCommandStore.setState({
    commands: [
      cmd('g1', { order: 0 }), cmd('g2', { order: 1 }), cmd('g3', { order: 2 }),
      cmd('c1', { scope: 'config', configId: 'cfg', order: 0 }), cmd('c2', { scope: 'config', configId: 'cfg', order: 1 }),
      cmd('o1', { scope: 'config', configId: 'other', order: 0 }),
    ],
    sections: [],
    isLoaded: true,
  })
  vi.mocked(saveConfigNow).mockClear()
})

describe('moveCommand -- within a band', () => {
  it('puts the moved chip before the named one and renumbers only that band', () => {
    useCommandStore.getState().moveCommand('g3', 'g1', 'global')
    expect(orderOf(['g3', 'g1', 'g2'])).toEqual([['g3', 0], ['g1', 1], ['g2', 2]])
    // The Session bands are untouched -- their ordinals and scope as before.
    expect(orderOf(['c1', 'c2', 'o1'])).toEqual([['c1', 0], ['c2', 1], ['o1', 0]])
    expect(byId('g3').scope).toBe('global')
  })

  it('beforeId null means the end of the band', () => {
    useCommandStore.getState().moveCommand('g1', null, 'global')
    expect(orderOf(['g2', 'g3', 'g1'])).toEqual([['g2', 0], ['g3', 1], ['g1', 2]])
  })

  it('persists at once, once, under the commands key', () => {
    useCommandStore.getState().moveCommand('g1', null, 'global')
    expect(saveConfigNow).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveConfigNow).mock.calls[0][0]).toBe('commands')
  })

  it('an unknown id changes nothing and writes nothing', () => {
    const before = useCommandStore.getState().commands
    useCommandStore.getState().moveCommand('nope', null, 'global')
    expect(useCommandStore.getState().commands).toBe(before)
    expect(saveConfigNow).not.toHaveBeenCalled()
  })
})

describe('moveCommand -- across bands is the confirmed scope change', () => {
  it('Session → Global: becomes global, loses its configId, takes its place in the Global band', () => {
    useCommandStore.getState().moveCommand('c1', 'g2', 'global', 'cfg')
    const c1 = byId('c1')
    expect(c1.scope).toBe('global')
    expect(c1.configId).toBeUndefined()
    expect(orderOf(['g1', 'c1', 'g2', 'g3'])).toEqual([['g1', 0], ['c1', 1], ['g2', 2], ['g3', 3]])
    // The band it left keeps its own ordinals; nothing else re-scoped.
    expect(byId('c2').scope).toBe('config')
    expect(byId('c2').order).toBe(1)
  })

  it('Global → Session: becomes config-scoped TO THAT CONFIG and joins the end of its band', () => {
    useCommandStore.getState().moveCommand('g2', null, 'config', 'cfg')
    const g2 = byId('g2')
    expect(g2.scope).toBe('config')
    expect(g2.configId).toBe('cfg')
    expect(orderOf(['c1', 'c2', 'g2'])).toEqual([['c1', 0], ['c2', 1], ['g2', 2]])
    // Another config's band is not touched.
    expect(byId('o1').order).toBe(0)
    expect(byId('o1').configId).toBe('other')
  })
})

describe('setCommandSection', () => {
  it('is the one writer of sectionId, and undefined clears it', () => {
    useCommandStore.getState().setCommandSection('g1', 'sec-a')
    expect(byId('g1').sectionId).toBe('sec-a')
    useCommandStore.getState().setCommandSection('g1', undefined)
    expect(byId('g1').sectionId).toBeUndefined()
    expect(saveConfigNow).toHaveBeenCalledTimes(2)
  })
})

describe('togglePinned', () => {
  it('pins, then UN-sets rather than writing pinned:false', () => {
    useCommandStore.getState().togglePinned('g1')
    expect(byId('g1').pinned).toBe(true)
    useCommandStore.getState().togglePinned('g1')
    expect(byId('g1').pinned).toBeUndefined()
    expect('pinned' in byId('g1') ? byId('g1').pinned : undefined).toBeUndefined()
  })
})

describe('clearReview', () => {
  it('drops the tag and persists; with no tag it changes nothing and writes nothing', () => {
    useCommandStore.setState({ commands: [cmd('r1', { needsReview: ['secret-like-arg'] }), cmd('r2')] })
    useCommandStore.getState().clearReview('r1')
    expect(byId('r1').needsReview).toBeUndefined()
    expect(saveConfigNow).toHaveBeenCalledTimes(1)
    const before = useCommandStore.getState().commands
    useCommandStore.getState().clearReview('r2')
    expect(useCommandStore.getState().commands).toBe(before)
    expect(saveConfigNow).toHaveBeenCalledTimes(1)
  })
})

describe('addCommand', () => {
  it('goes to the END of its own band', () => {
    useCommandStore.getState().addCommand(cmd('c3', { scope: 'config', configId: 'cfg' }))
    expect(byId('c3').order).toBe(2)
    useCommandStore.getState().addCommand(cmd('g4'))
    expect(byId('g4').order).toBe(3)
  })
})
