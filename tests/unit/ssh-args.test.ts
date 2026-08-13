import { describe, it, expect } from 'vitest'
import { buildSshArgs } from '../../src/main/ssh-args'

// pty-manager builds the ssh argv from this helper; these pin the EXACT argv
// (order, pairing, and length) reaching ssh/ssh.exe per platform. Whole-array
// toEqual is deliberate: a membership check (arrayContaining) can't catch a
// dropped `-o`, and an orphaned `ControlPath=none` would become a positional
// argument -- i.e. the remote command -- breaking every win32 SSH session.
const target = { username: 'me', host: 'example.com', port: 22 }
const BASE = ['me@example.com', '-p', '22', '-t', '-o', 'StrictHostKeyChecking=accept-new']
const WIN_MUX = ['-o', 'ControlMaster=no', '-o', 'ControlPath=none']
const TUNNEL = ['-R', '5111:127.0.0.1:5111']

describe('buildSshArgs', () => {
  it('linux/darwin, no tunnel: base flags only, user config untouched', () => {
    expect(buildSshArgs(target, 0, 'linux')).toEqual([...BASE])
    expect(buildSshArgs(target, 0, 'darwin')).toEqual([...BASE])
  })

  it('linux/darwin, tunnel: base flags + the 127.0.0.1 reverse tunnel', () => {
    expect(buildSshArgs(target, 5111, 'linux')).toEqual([...BASE, ...TUNNEL])
  })

  it('win32, no tunnel: base flags + BOTH ControlMaster=no and ControlPath=none, each with its own -o (#241)', () => {
    // Exact array: a single-`-o` mutant (orphaned ControlPath=none) fails here.
    expect(buildSshArgs(target, 0, 'win32')).toEqual([...BASE, ...WIN_MUX])
  })

  it('win32, tunnel: the mux override precedes the reverse tunnel, both present (#241)', () => {
    expect(buildSshArgs(target, 5111, 'win32')).toEqual([...BASE, ...WIN_MUX, ...TUNNEL])
  })

  it('does NOT disable ControlMaster/ControlPath on non-win32 platforms', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const args = buildSshArgs(target, 0, platform)
      expect(args).not.toContain('ControlMaster=no')
      expect(args).not.toContain('ControlPath=none')
    }
  })

  it('adds the reverse tunnel only when mcpPort > 0, and never to `localhost` (the IPv6 footgun)', () => {
    expect(buildSshArgs(target, 0, 'linux').some((a) => a.startsWith('-R'))).toBe(false)
    expect(buildSshArgs(target, 0, 'win32').some((a) => a.startsWith('-R'))).toBe(false)
    expect(buildSshArgs(target, 5111, 'win32')).not.toContain('5111:localhost:5111')
  })
})
