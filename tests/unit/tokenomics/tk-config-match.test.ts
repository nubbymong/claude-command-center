import { describe, it, expect } from 'vitest'
import { findConfigForCwd, isJunkCwd } from '../../../src/main/tokenomics/tk-config-match'
import type { TkConfigDim } from '../../../src/main/tokenomics/tk-types'

const configs: TkConfigDim[] = [
  { configId: 'a', label: 'Root', workingDirectory: 'F:\\work' },
  { configId: 'b', label: 'App',  workingDirectory: 'F:\\work\\app' },
]

describe('findConfigForCwd', () => {
  it('returns the longest matching prefix', () => {
    expect(findConfigForCwd('F:\\work\\app\\src', configs)?.configId).toBe('b')
  })
  it('falls back to the shorter prefix when the longer does not match', () => {
    expect(findConfigForCwd('F:\\work\\other', configs)?.configId).toBe('a')
  })
  it('is case-insensitive and slash-insensitive on Windows paths', () => {
    expect(findConfigForCwd('f:/WORK/App', configs)?.configId).toBe('b')
  })
  it('returns null when no config matches', () => {
    expect(findConfigForCwd('C:\\Users\\nicho\\elsewhere', configs)).toBeNull()
  })
  it('returns null for empty cwd or empty config list', () => {
    expect(findConfigForCwd('', configs)).toBeNull()
    expect(findConfigForCwd('F:\\work', [])).toBeNull()
  })
  it('does not match a sibling whose name shares a prefix (boundary check)', () => {
    expect(findConfigForCwd('F:\\work2\\x', configs)).toBeNull()
  })
})

describe('isJunkCwd', () => {
  it('flags system + temp + hookprobe dirs', () => {
    expect(isJunkCwd('C:\\Windows\\System32')).toBe(true)
    expect(isJunkCwd('C:\\Users\\nicho\\AppData\\Local\\Temp\\x')).toBe(true)
    expect(isJunkCwd('F:\\hookprobe-1234')).toBe(true)
  })
  it('passes real project dirs', () => {
    expect(isJunkCwd('F:\\work\\app')).toBe(false)
  })
  it('treats empty as junk', () => {
    expect(isJunkCwd('')).toBe(true)
  })
})
