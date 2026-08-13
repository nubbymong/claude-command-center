import { describe, it, expect } from 'vitest'
import { buildSshArgs } from '../../src/main/ssh-args'

// pty-manager builds the ssh argv from this helper; these pin exactly which
// flags reach ssh/ssh.exe per platform.
const target = { username: 'me', host: 'example.com', port: 22 }

describe('buildSshArgs', () => {
  it('forces ControlMaster/ControlPath off on win32 (Windows OpenSSH has no multiplexing) -- #241', () => {
    const args = buildSshArgs(target, 0, 'win32')
    expect(args).toContain('ControlMaster=no')
    expect(args).toContain('ControlPath=none')
    // Each must be paired with its own -o so ssh actually parses it.
    expect(args).toEqual(expect.arrayContaining(['-o', 'ControlMaster=no', '-o', 'ControlPath=none']))
  })

  it('does NOT disable ControlMaster/ControlPath on non-win32 platforms', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const args = buildSshArgs(target, 0, platform)
      expect(args).not.toContain('ControlMaster=no')
      expect(args).not.toContain('ControlPath=none')
    }
  })

  it('keeps the base flags (target, port, TTY, host-key policy) on every platform', () => {
    const args = buildSshArgs(target, 0, 'linux')
    expect(args.slice(0, 6)).toEqual(['me@example.com', '-p', '22', '-t', '-o', 'StrictHostKeyChecking=accept-new'])
  })

  it('adds the Conductor MCP reverse tunnel to 127.0.0.1 only when mcpPort > 0', () => {
    expect(buildSshArgs(target, 5111, 'linux')).toEqual(expect.arrayContaining(['-R', '5111:127.0.0.1:5111']))
    expect(buildSshArgs(target, 0, 'linux').some((a) => a.startsWith('-R'))).toBe(false)
    // The IPv6 footgun: never tunnel to `localhost`.
    expect(buildSshArgs(target, 5111, 'win32')).not.toContain('5111:localhost:5111')
  })
})
