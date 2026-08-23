import { describe, it, expect, beforeEach } from 'vitest'
import { shellOperatorsIn } from '../../src/shared/gui-exe'
import { getCachedProbe, setCachedProbe, __clearProbeCache } from '../../src/renderer/lib/gui-exe-probe-cache'
import type { ExeProbeResult } from '../../src/shared/gui-exe'

// #379 review MAJOR-5 and MAJOR-6.

describe('shellOperatorsIn — what a captured run will NOT honour', () => {
  it('is empty for a plain command', () => {
    expect(shellOperatorsIn('bambu-studio --debug 2')).toEqual([])
    expect(shellOperatorsIn('')).toEqual([])
  })

  it('reports a redirect, which capture turns into two literal arguments', () => {
    expect(shellOperatorsIn('tool --debug 2 > log.txt')).toEqual(['>'])
  })

  it('reports && as one operator, not as two &', () => {
    // The reason the two-character forms are scanned first.
    expect(shellOperatorsIn('tool --x && next')).toEqual(['&&'])
    expect(shellOperatorsIn('tool --x || next')).toEqual(['||'])
    expect(shellOperatorsIn('tool >> log.txt')).toEqual(['>>'])
  })

  it('reports a pipe, a semicolon and a background &', () => {
    expect(shellOperatorsIn('a | b')).toEqual(['|'])
    expect(shellOperatorsIn('a ; b')).toEqual([';'])
    expect(shellOperatorsIn('a & b')).toEqual(['&'])
  })

  it('reports PowerShell expansions that will arrive literally', () => {
    expect(shellOperatorsIn('tool $env:TOKEN')).toEqual(['$env:'])
    expect(shellOperatorsIn('tool $(Get-Date)')).toEqual(['$('])
    expect(shellOperatorsIn('tool `n')).toEqual(['`'])
  })

  it('reports 2> without also reporting a bare >', () => {
    expect(shellOperatorsIn('tool 2> err.txt')).toEqual(['2>'])
  })

  it('lists several, without duplicates', () => {
    expect(shellOperatorsIn('a > x | b > y')).toEqual(['|', '>'])
  })

  it('over-warns rather than under-warns: a quoted operator still counts', () => {
    // Deliberately not a parser. One extra sentence of warning is cheaper than a
    // command that silently did something else.
    expect(shellOperatorsIn('tool --name "a > b"')).toEqual(['>'])
  })
})

describe('the renderer probe cache — ordering and cost (#379 MAJOR-6)', () => {
  const gui: ExeProbeResult = { status: 'gui', token: 'bambu-studio', exePath: 'C:\\tools\\bambu-studio.exe' }

  beforeEach(() => __clearProbeCache())

  it('is empty until something is stored', () => {
    expect(getCachedProbe('bambu-studio', 'C:\\work')).toBeNull()
  })

  it('returns the stored result, so a repeat press can decide synchronously', () => {
    setCachedProbe('bambu-studio', 'C:\\work', gui)
    expect(getCachedProbe('bambu-studio', 'C:\\work')).toEqual(gui)
  })

  it('keys on the exact command line -- different arguments can be a different program', () => {
    setCachedProbe('bambu-studio --a', 'C:\\work', gui)
    expect(getCachedProbe('bambu-studio --b', 'C:\\work')).toBeNull()
  })

  it('keys on the working directory', () => {
    setCachedProbe('tool', 'C:\\one', gui)
    expect(getCachedProbe('tool', 'C:\\two')).toBeNull()
  })

  it('expires, so a tool installed or removed a minute ago is not remembered wrongly', () => {
    let t = 1_000_000
    const now = () => t
    setCachedProbe('tool', 'C:\\work', gui, now)
    t += 29_000
    expect(getCachedProbe('tool', 'C:\\work', now)).toEqual(gui)
    t += 2_000 // past the 30 s TTL
    expect(getCachedProbe('tool', 'C:\\work', now)).toBeNull()
  })

  it('is bounded, so a long session cannot grow it without end', () => {
    for (let i = 0; i < 200; i++) setCachedProbe(`tool-${i}`, 'C:\\work', gui)
    // The oldest are evicted; the newest survive.
    expect(getCachedProbe('tool-0', 'C:\\work')).toBeNull()
    expect(getCachedProbe('tool-199', 'C:\\work')).toEqual(gui)
  })
})
