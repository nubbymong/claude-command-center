import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  injectHooks,
  removeHooks,
  MVP_EVENTS,
} from '../../../src/main/hooks/session-hooks-writer'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-writer-test-'))
}

describe('session-hooks-writer', () => {
  let dir = ''
  let file = ''
  beforeEach(() => {
    dir = tmp()
    file = path.join(dir, 'settings-sid-a.json')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('injects hooks for all MVP events', () => {
    injectHooks({ sessionId: 'sid-a', settingsPath: file, port: 19334, secret: 'abc123' })
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
    injectHooks({ sessionId: 'sid-a', settingsPath: file, port: 19334, secret: 'abc' })
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(settings.statusLine.command).toBe('x')
    expect(settings.model).toBe('opus')
    expect(settings.hooks).toBeDefined()
  })

  it('inject is idempotent - repeated calls do not duplicate entries', () => {
    injectHooks({ sessionId: 'sid-a', settingsPath: file, port: 19334, secret: 'abc' })
    injectHooks({ sessionId: 'sid-a', settingsPath: file, port: 19334, secret: 'def' })
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(settings.hooks.PreToolUse.length).toBe(1)
    expect(settings.hooks.PreToolUse[0].hooks[0].headers['X-CCC-Hook-Token']).toBe('def')
  })

  it('remove strips only the hooks key', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: 'keep' }))
    injectHooks({ sessionId: 'sid-a', settingsPath: file, port: 19334, secret: 'abc' })
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
    injectHooks({ sessionId: 'sid-b', settingsPath: deep, port: 19335, secret: 'xyz' })
    expect(fs.existsSync(deep)).toBe(true)
  })
})
