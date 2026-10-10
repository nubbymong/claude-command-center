// Owner decision D3 (2026-10-10): an npm install needs Node.js. When node or
// npm is not found where the install tab would look, the npm option says so
// and its Run it for me is off (Copy still works). The check starts no
// process of its own: on Windows it walks PATH's fully qualified folders for
// the two programs the tab's line runs (npm.cmd, and node.exe, which npm.cmd
// starts); elsewhere it reads the login shell's PATH, as the tab's login
// shell builds it. PURE: the file checks and the shell are stand-ins.
import { describe, it, expect, vi } from 'vitest'
import { nodeToolsFoundWith, createNodeToolsCheck } from '../../../src/main/node-tools-probe'

const BS = String.fromCharCode(92)
const w = (s: string) => s.replace(/\//g, BS)

describe('Windows: npm.cmd and node.exe in the folders PATH names in full', () => {
  const files = (...present: string[]) => {
    const asked: string[] = []
    return { asked, isFile: async (p: string) => { asked.push(p); return present.includes(p) } }
  }

  it('found only when both are there', async () => {
    const env = { Path: w('C:/Windows;C:/Program Files/nodejs') }
    const both = files(w('C:/Program Files/nodejs/npm.cmd'), w('C:/Program Files/nodejs/node.exe'))
    expect(await nodeToolsFoundWith({ platform: 'win32', env, isFile: both.isFile })).toBe(true)
    expect(await nodeToolsFoundWith({ platform: 'win32', env, isFile: files(w('C:/Program Files/nodejs/npm.cmd')).isFile })).toBe(false)
    expect(await nodeToolsFoundWith({ platform: 'win32', env, isFile: files(w('C:/Program Files/nodejs/node.exe')).isFile })).toBe(false)
  })

  it('npm.exe alone is not enough: the line the tab types runs npm.cmd', async () => {
    const env = { Path: w('C:/nodejs') }
    expect(await nodeToolsFoundWith({ platform: 'win32', env, isFile: files(w('C:/nodejs/npm.exe'), w('C:/nodejs/node.exe')).isFile })).toBe(false)
  })

  it('a relative or %VAR% entry is never looked in', async () => {
    const env = { PATH: w('nodejs;%APPDATA%/npm;.;C:/real') }
    const f = files(w('nodejs/npm.cmd'), w('nodejs/node.exe'))
    expect(await nodeToolsFoundWith({ platform: 'win32', env, isFile: f.isFile })).toBe(false)
    expect(f.asked.every((p) => p.startsWith(w('C:/real/'))), f.asked.join(' ')).toBe(true)
  })
})

describe('macOS and Linux: npm and node in the login shell PATH', () => {
  it("looks in the login shell's PATH, not the app's own", async () => {
    const asked: string[] = []
    const found = await nodeToolsFoundWith({
      platform: 'darwin', env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      loginShellPath: async () => '/opt/homebrew/bin:/usr/bin',
      runnable: async (p) => { asked.push(p); return p === '/opt/homebrew/bin/npm' || p === '/opt/homebrew/bin/node' },
    })
    expect(found).toBe(true)
    expect(asked).toContain('/opt/homebrew/bin/npm')
  })

  it("without an answer from the login shell, the process PATH's absolute folders", async () => {
    const asked: string[] = []
    const found = await nodeToolsFoundWith({
      platform: 'linux', env: { PATH: 'relative:/usr/local/bin' },
      loginShellPath: async () => null,
      runnable: async (p) => { asked.push(p); return p.startsWith('/usr/local/bin/') },
    })
    expect(found).toBe(true)
    expect(asked.some((p) => p.startsWith('relative'))).toBe(false)
  })

  it('npm without node is not found', async () => {
    expect(await nodeToolsFoundWith({
      platform: 'linux', env: { PATH: '/usr/bin' }, loginShellPath: async () => '/usr/bin',
      runnable: async (p) => p === '/usr/bin/npm',
    })).toBe(false)
  })
})

describe('one check at a time', () => {
  it('callers that ask while a check runs share its answer; the next call checks again', async () => {
    let release: (v: string | null) => void = () => {}
    const loginShellPath = vi.fn(() => new Promise<string | null>((r) => { release = r }))
    const check = createNodeToolsCheck(() => ({ platform: 'linux', env: { PATH: '/usr/bin' }, loginShellPath, runnable: async () => true }))
    const a = check()
    const b = check()
    await Promise.resolve()
    expect(loginShellPath).toHaveBeenCalledTimes(1)
    release('/usr/bin')
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    const c = check()
    await Promise.resolve()
    expect(loginShellPath).toHaveBeenCalledTimes(2)
    release('/usr/bin')
    expect(await c).toBe(true)
  })
})
