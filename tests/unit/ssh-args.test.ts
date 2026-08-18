import { describe, it, expect } from 'vitest'
import { buildSshArgs, buildSshExecArgs } from '../../src/main/ssh-args'

// pty-manager builds the ssh argv from this helper; these pin the EXACT argv
// (order, pairing, and length) reaching ssh/ssh.exe per platform. Whole-array
// toEqual is deliberate: a membership check (arrayContaining) can't catch a
// dropped `-o`, and an orphaned `ControlPath=none` would become a positional
// argument -- i.e. the remote command -- breaking every win32 SSH session.
const target = { username: 'me', host: 'example.com', port: 22 }
// ServerAlive* are part of BASE, not a platform extra: #242 adds them on every
// platform so a dead-but-open TCP connection surfaces and tmux reconnect can
// take over. They sit inside the base literal, before the win32 mux override.
const BASE = [
  'me@example.com', '-p', '22', '-t',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
]
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

  it('emits every -o flag as a separate argv entry (never a joined string)', () => {
    // node-pty passes argv straight to CreateProcess; a joined "-o Foo=bar"
    // entry would be parsed by ssh.exe as a single malformed option.
    // 5 = StrictHostKeyChecking + ServerAliveInterval + ServerAliveCountMax
    // (#242, all platforms) + ControlMaster + ControlPath (#241, win32-only).
    const args = buildSshArgs(target, 0, 'win32')
    expect(args.filter((a) => a === '-o')).toHaveLength(5)
    expect(args.some((a) => a.includes(' '))).toBe(false)
  })

  // #242: tmux persistence depends on the connection eventually noticing
  // it's dead (see the doc comment on buildSshArgs). Unlike ControlMaster,
  // this is NOT platform-conditional.
  it('sets ServerAliveInterval=30 and ServerAliveCountMax=3 on every platform (#242)', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const args = buildSshArgs(target, 0, platform)
      expect(args).toContain('ServerAliveInterval=30')
      expect(args).toContain('ServerAliveCountMax=3')
    }
  })
})

// #265 finding 2: the builder is the argv SINK for `${username}@${host}`. ssh
// parses a leading `-` as an option (`-oProxyCommand=...` = local RCE), so the
// builder re-asserts the charset the IPC schema also gates — defence-in-depth
// against a call site that bypasses Zod and rebuilds the primitive directly.
describe('buildSshArgs rejects an option-like or whitespace host/username (sink guard)', () => {
  const rejects = /Refusing to build SSH args/
  it.each([
    ['username', '-oProxyCommand=touch /tmp/pwn'],
    ['username', '-l'],
    ['username', '- '],
    ['host', '-oProxyCommand=id'],
    ['host', '-p2222'],
  ])('throws on a leading-dash %s (%s)', (field, bad) => {
    const t = { ...target, [field]: bad }
    expect(() => buildSshArgs(t, 0, 'win32')).toThrow(rejects)
  })

  it.each([
    ['username', 'me evil'],
    ['username', 'me\tx'],
    ['host', 'example.com host2'],
    ['host', 'example.com\nrm'],
  ])('throws on whitespace in %s (%s)', (field, bad) => {
    const t = { ...target, [field]: bad }
    expect(() => buildSshArgs(t, 0, 'linux')).toThrow(rejects)
  })

  it('throws on an empty username or host', () => {
    expect(() => buildSshArgs({ ...target, username: '' }, 0, 'linux')).toThrow(rejects)
    expect(() => buildSshArgs({ ...target, host: '' }, 0, 'linux')).toThrow(rejects)
  })

  it('still accepts real hosts/usernames with internal dashes, IPv6, and DOMAIN\\user', () => {
    expect(() => buildSshArgs({ username: 'my-user', host: 'my-host.example.com', port: 22 }, 0, 'linux')).not.toThrow()
    expect(() => buildSshArgs({ username: 'root', host: '[2001:db8::1]', port: 22 }, 0, 'linux')).not.toThrow()
    expect(() => buildSshArgs({ username: 'DOMAIN\\me', host: '10.0.0.5', port: 22 }, 0, 'win32')).not.toThrow()
  })
})


// SSH tmux enhancement (item 4): buildSshExecArgs — the argv for the SEPARATE
// non-interactive ssh exec that ends a remote session (tmux kill-session +
// sidecar cleanup). Validated against real ssh.exe on Windows and ssh on Linux
// in headless testing; these pin the exact shape + guards.
describe('buildSshExecArgs (item 4 — one-shot end-remote exec)', () => {
  const target = { username: 'dev', host: 'box.example.com', port: 2222 }
  it('builds a batch, non-TTY argv with the remote command as the final positional arg', () => {
    const args = buildSshExecArgs(target, 'tmux kill-session -t ccc-x; true', 'linux')
    expect(args[0]).toBe('dev@box.example.com')
    expect(args).toContain('-p'); expect(args).toContain('2222')
    // Batch: no interactive password prompt, fail-fast connect.
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('ConnectTimeout=8')
    expect(args).toContain('StrictHostKeyChecking=accept-new')
    // No TTY and no MCP tunnel (unlike buildSshArgs).
    expect(args).not.toContain('-t')
    expect(args).not.toContain('-R')
    // The remote command is the LAST arg (ssh joins trailing args with spaces).
    expect(args[args.length - 1]).toBe('tmux kill-session -t ccc-x; true')
  })
  it('forces ControlMaster/ControlPath OFF on EVERY platform (the exec must not multiplex over the live PTY that is about to be killed)', () => {
    // Unlike buildSshArgs (win32-only #241), the end-remote exec disables
    // multiplexing everywhere: it is dispatched right before the caller tears
    // down the shared connection's master, so on a POSIX client with
    // `ControlMaster auto` a multiplexed exec would be cut off mid-kill
    // (adversarial review, 2026-08-18). Each `-o` must have its own flag so a
    // single-`-o` mutant leaves an orphaned positional.
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const args = buildSshExecArgs(target, 'true', platform)
      const i = args.indexOf('ControlMaster=no')
      const j = args.indexOf('ControlPath=none')
      expect(i).toBeGreaterThan(0)
      expect(args[i - 1]).toBe('-o')
      expect(j).toBeGreaterThan(0)
      expect(args[j - 1]).toBe('-o')
    }
  })
  it('re-asserts the same argv field guard as buildSshArgs (leading dash / whitespace / empty)', () => {
    expect(() => buildSshExecArgs({ ...target, username: '-oProxyCommand=x' }, 'true', 'linux')).toThrow()
    expect(() => buildSshExecArgs({ ...target, host: 'a b' }, 'true', 'linux')).toThrow()
    expect(() => buildSshExecArgs({ ...target, host: '' }, 'true', 'linux')).toThrow()
  })
})
