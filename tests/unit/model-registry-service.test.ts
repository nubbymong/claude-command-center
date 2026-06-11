import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  _initRegistryForTest, getRegistry, applyOverlayEntry, reloadRegistry, removeOverlayEntry,
  onRegistryReload,
} from '../../src/main/model-registry-service'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-reg-')); _initRegistryForTest(dir) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('model-registry-service', () => {
  it('loads baseline when no overlay exists', () => {
    expect(getRegistry().models.find((m) => m.id === 'claude-opus-4-8')).toBeTruthy()
  })
  it('applyOverlayEntry persists, reloads, and the entry resolves', () => {
    applyOverlayEntry({
      id: 'claude-fable-6', patterns: ['fable-6'], family: 'fable', label: 'Fable 6',
      provenance: { addedBy: 'sentinel', date: '2026-06-11' },
    })
    expect(getRegistry().models.find((m) => m.id === 'claude-fable-6')).toBeTruthy()
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'sentinel', 'registry-overlay.json'), 'utf-8'))
    expect(onDisk.models[0].id).toBe('claude-fable-6')
  })
  it('corrupt overlay is ignored; baseline still loads (spec §7)', () => {
    fs.mkdirSync(path.join(dir, 'sentinel'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sentinel', 'registry-overlay.json'), '{not json')
    reloadRegistry()
    expect(getRegistry().models).toHaveLength(8)
  })
  it('removeOverlayEntry reverts an applied entry', () => {
    applyOverlayEntry({ id: 'x-1', patterns: ['x-1'], family: 'opus', label: 'X', provenance: { addedBy: 'user', date: '2026-06-11' } })
    removeOverlayEntry('x-1')
    expect(getRegistry().models.find((m) => m.id === 'x-1')).toBeFalsy()
  })
  it('reload notifies onRegistryReload subscribers', () => {
    let calls = 0
    const unsub = onRegistryReload(() => { calls++ })
    reloadRegistry()
    expect(calls).toBe(1)
    unsub()
    reloadRegistry()
    expect(calls).toBe(1)
  })
  it('a throwing subscriber does not break reload or other subscribers', () => {
    let after = 0
    const unsubBad = onRegistryReload(() => { throw new Error('boom') })
    const unsubGood = onRegistryReload(() => { after++ })
    expect(() => reloadRegistry()).not.toThrow()
    expect(after).toBe(1)
    unsubBad(); unsubGood()
  })
})
