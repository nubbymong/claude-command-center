import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  injectHooks,
  removeHooks,
  buildHooksBlock,
  resolveInheritedHooks,
  MVP_EVENTS,
} from '../../../src/main/hooks/session-hooks-writer'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-writer-test-'))
}

// A project/user command-hook entry, in Claude's matcher-wrapped schema.
function cmdHook(command: string, matcher = '') {
  return { matcher, hooks: [{ type: 'command', command }] }
}

function writeSettings(claudeDir: string, hooks: unknown, file = 'settings.json') {
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(path.join(claudeDir, file), JSON.stringify({ hooks }))
}

describe('session-hooks-writer', () => {
  let dir = ''
  let file = ''
  let home = '' // hermetic user-settings home (no real ~/.claude)
  let proj = '' // hermetic project cwd (no .claude unless a test adds one)
  beforeEach(() => {
    dir = tmp()
    file = path.join(dir, 'settings-sid-a.json')
    home = path.join(dir, 'home')
    // Project cwd nested UNDER the fake home so the project-root walk is bounded
    // by the homeDir ceiling (keeps the test off the real ~/.claude).
    proj = path.join(home, 'work')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(proj, { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // Base args with hermetic cwd/home so no real user/project hooks leak in.
  const base = (over: Record<string, unknown> = {}) => ({
    sessionId: 'sid-a', settingsPath: file, port: 19334, secret: 'abc123',
    cwd: proj, homeDir: home, ...over,
  })

  it('injects hooks for all MVP events', () => {
    injectHooks(base())
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
    for (const kind of MVP_EVENTS) {
      expect(Array.isArray(settings.hooks[kind])).toBe(true)
      const wrapper = settings.hooks[kind][0]
      expect(wrapper.matcher).toBe('')
      expect(Array.isArray(wrapper.hooks)).toBe(true)
      expect(wrapper.hooks[0].type).toBe('http')
      expect(wrapper.hooks[0].url).toBe('http://localhost:19334/hook/sid-a')
      expect(wrapper.hooks[0].headers['X-CCC-Hook-Token']).toBe('abc123')
    }
  })

  it('preserves other keys in the settings file', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ statusLine: { type: 'command', command: 'x' }, model: 'opus' }),
    )
    injectHooks(base({ secret: 'abc' }))
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(settings.statusLine.command).toBe('x')
    expect(settings.model).toBe('opus')
    expect(settings.hooks).toBeDefined()
  })

  it('inject is idempotent - repeated calls do not duplicate entries', () => {
    injectHooks(base({ secret: 'abc' }))
    injectHooks(base({ secret: 'def' }))
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(settings.hooks.PreToolUse.length).toBe(1)
    expect(settings.hooks.PreToolUse[0].hooks[0].headers['X-CCC-Hook-Token']).toBe('def')
  })

  it('remove strips only the hooks key', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: 'keep' }))
    injectHooks(base({ secret: 'abc' }))
    removeHooks({ settingsPath: file })
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(settings.statusLine).toBe('keep')
    expect(settings.hooks).toBeUndefined()
  })

  it('remove on missing file is a no-op', () => {
    expect(() =>
      removeHooks({ settingsPath: path.join(dir, 'nope.json') }),
    ).not.toThrow()
  })

  it('remove on file with no hooks key is a no-op', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: 'keep' }))
    expect(() => removeHooks({ settingsPath: file })).not.toThrow()
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(settings.statusLine).toBe('keep')
  })

  it('inject creates the parent dir if missing', () => {
    const deep = path.join(dir, 'nested', 'dir', 'settings-sid-b.json')
    injectHooks(base({ sessionId: 'sid-b', settingsPath: deep, port: 19335, secret: 'xyz' }))
    expect(fs.existsSync(deep)).toBe(true)
  })

  it('injects a UserPromptSubmit hook (clear signal for the flasher)', () => {
    const block = buildHooksBlock('sess', 1234, 'secret')
    expect(block.UserPromptSubmit).toBeDefined()
  })

  // ── #137: merge inherited hooks instead of shadowing them ──
  it('MERGES a project command hook with the CCC http hook (#137)', () => {
    writeSettings(path.join(proj, '.claude'), { PreToolUse: [cmdHook('carp-hook.ps1', 'Bash')] })
    injectHooks(base())
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const pre = settings.hooks.PreToolUse
    expect(pre.length).toBe(2)
    // inherited project hook preserved (order: inherited first)...
    expect(pre[0].hooks[0].command).toBe('carp-hook.ps1')
    expect(pre[0].matcher).toBe('Bash')
    // ...and CCC's http hook still present.
    expect(pre[1].hooks[0].type).toBe('http')
  })

  it('merges user + project + project-local hooks', () => {
    writeSettings(path.join(home, '.claude'), { UserPromptSubmit: [cmdHook('user.sh')] })
    writeSettings(path.join(proj, '.claude'), { UserPromptSubmit: [cmdHook('project.sh')] })
    writeSettings(path.join(proj, '.claude'), { UserPromptSubmit: [cmdHook('local.sh')] }, 'settings.local.json')
    const inherited = resolveInheritedHooks(proj, home)
    const cmds = inherited.UserPromptSubmit.map((e: { hooks: { command: string }[] }) => e.hooks[0].command)
    expect(cmds).toEqual(['user.sh', 'project.sh', 'local.sh'])
  })

  it('resolves project hooks from a nested cwd (walks up to the .claude root)', () => {
    writeSettings(path.join(proj, '.claude'), { Stop: [cmdHook('root.sh')] })
    const nested = path.join(proj, 'packages', 'app')
    fs.mkdirSync(nested, { recursive: true })
    const inherited = resolveInheritedHooks(nested, home)
    expect(inherited.Stop[0].hooks[0].command).toBe('root.sh')
  })

  it('dedupes a byte-identical hook present in both project and local (no double-fire)', () => {
    writeSettings(path.join(proj, '.claude'), { Stop: [cmdHook('same.sh')] })
    writeSettings(path.join(proj, '.claude'), { Stop: [cmdHook('same.sh')] }, 'settings.local.json')
    const inherited = resolveInheritedHooks(proj, home)
    expect(inherited.Stop.length).toBe(1)
  })

  it('is fail-safe when there are no inherited settings (empty → CCC hooks only)', () => {
    const inherited = resolveInheritedHooks(proj, home)
    expect(inherited).toEqual({})
    injectHooks(base())
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(settings.hooks.PreToolUse.length).toBe(1)
  })
})
