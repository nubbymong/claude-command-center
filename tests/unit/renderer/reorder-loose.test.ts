// Drag-to-reorder among the LOOSE configs only.
//
// It used to apply to every row and splice the flat array. The array is the
// order source for everything, but the sidebar renders it filtered into
// sections and groups, so dropping a loose config onto a grouped one moved it
// in the array and changed nothing you could see — or reordered the inside of
// a group you had not touched. The loose list is where array order IS visible
// order, so it is the one place a drag can mean what it looks like it means.

import { describe, it, expect } from 'vitest'
import { reorderLoose } from '../../../src/renderer/utils/reorderLoose'

const c = (id: string) => ({ id })
// [g1, g2] are in a group; [a, b, c] are loose; g3 grouped again.
const configs = [c('g1'), c('a'), c('g2'), c('b'), c('c'), c('g3')]
const loose = new Set(['a', 'b', 'c'])

describe('reorderLoose', () => {
  it('moves a loose config to another loose position', () => {
    const next = reorderLoose(configs, loose, 'c', 'a')!
    // c lands where a was; a and b shift down; grouped configs keep their
    // relative places.
    expect(next.map((x) => x.id)).toEqual(['g1', 'c', 'a', 'g2', 'b', 'g3'])
  })

  it('moves a loose config downwards past a grouped one', () => {
    const next = reorderLoose(configs, loose, 'a', 'c')!
    expect(next.map((x) => x.id)).toEqual(['g1', 'g2', 'b', 'c', 'a', 'g3'])
  })

  it('never reorders when the drop target is grouped', () => {
    expect(reorderLoose(configs, loose, 'a', 'g2')).toBeNull()
  })

  it('never reorders when the dragged config is grouped', () => {
    expect(reorderLoose(configs, loose, 'g1', 'a')).toBeNull()
  })

  it('ignores a drop on itself', () => {
    expect(reorderLoose(configs, loose, 'a', 'a')).toBeNull()
  })

  it('ignores an id that is not in the list', () => {
    expect(reorderLoose(configs, loose, 'nope', 'a')).toBeNull()
    expect(reorderLoose(configs, new Set(['a', 'nope']), 'a', 'nope')).toBeNull()
  })

  it('does not mutate the input', () => {
    const before = configs.map((x) => x.id)
    reorderLoose(configs, loose, 'c', 'a')
    expect(configs.map((x) => x.id)).toEqual(before)
  })
})
