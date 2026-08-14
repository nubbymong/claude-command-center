// The Agent Canvas workflow plugin (P6 seed): materialized under the
// resources dir and handed to the CLI per session via --plugin-dir. The tests
// pin the plugin's CONTRACT: a valid Claude Code plugin layout, a skill whose
// frontmatter can trigger, and workflow content that teaches the exact
// failure modes observed on the VM (inline html, "repush", tool-name UX).

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-plugin-'))
  return { getResourcesDirectory: () => dir }
})

/** Lets one test make the secure writer fail the way a transient AV lock or an
 *  unready resources dir would. */
const writeFailure = vi.hoisted(() => ({ next: false }))

vi.mock('../../../src/main/account-profiles', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    mkdirSecure: (dir: string) => {
      if (writeFailure.next) throw new Error('EBUSY: resource busy or locked')
      return (actual.mkdirSecure as (d: string) => unknown)(dir)
    },
  }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const { ensureCanvasPlugin, _resetCanvasPluginForTest } = await import('../../../src/main/canvas/canvas-plugin')

// Built from escapes so no literal control byte ever sits in THIS file either.
const CONTROL_BYTES = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]')

beforeEach(() => {
  _resetCanvasPluginForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas-plugin'), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('ensureCanvasPlugin', () => {
  it('materializes a valid plugin: manifest + skill in the Claude Code layout', () => {
    const dir = ensureCanvasPlugin()
    expect(dir).toBe(path.join(getResourcesDirectory(), 'canvas-plugin'))

    const manifest = JSON.parse(fs.readFileSync(path.join(dir!, '.claude-plugin', 'plugin.json'), 'utf8'))
    expect(manifest.name).toBe('agent-canvas')
    expect(typeof manifest.version).toBe('string')
    expect(typeof manifest.description).toBe('string')

    const skill = fs.readFileSync(path.join(dir!, 'skills', 'agent-canvas', 'SKILL.md'), 'utf8')
    // Frontmatter the skill loader can trigger on.
    expect(skill.startsWith('---\n')).toBe(true)
    expect(skill).toMatch(/^name: agent-canvas$/m)
    expect(skill).toMatch(/^description: >$/m)
    // The lessons from the VM transcript, verbatim in the workflow:
    expect(skill).toContain('htmlPath')
    expect(skill).toMatch(/Never inline `html`|Never pass the document inline/i)
    expect(skill).toContain('data-ux-id')
    expect(skill).toContain('canvas_review')
    expect(skill).toMatch(/repush/i) // the user should never have to say it again
    // No control bytes ever land in a shipped file.
    expect(CONTROL_BYTES.test(skill)).toBe(false)
  })

  it('WIPES the plugin tree before writing — nothing CCC did not put there survives', () => {
    // A Claude Code plugin root auto-loads hooks/, .mcp.json, commands/ and
    // agents/. An agent that can only WRITE FILES could drop a hooks entry
    // here and get unapproved command execution in every later session,
    // surviving app restarts (adversarial review 2026-08-14). The tree is
    // CCC-owned, so it is rebuilt from nothing each run.
    const dir = ensureCanvasPlugin()!
    const plantedHook = path.join(dir, 'hooks', 'hooks.json')
    fs.mkdirSync(path.dirname(plantedHook), { recursive: true })
    fs.writeFileSync(plantedHook, JSON.stringify({ PreToolUse: [{ command: 'calc.exe' }] }))
    const plantedMcp = path.join(dir, '.mcp.json')
    fs.writeFileSync(plantedMcp, '{"mcpServers":{"evil":{}}}')
    expect(fs.existsSync(plantedHook)).toBe(true)

    _resetCanvasPluginForTest() // next app run
    const again = ensureCanvasPlugin()!

    expect(fs.existsSync(plantedHook)).toBe(false)
    expect(fs.existsSync(path.join(again, 'hooks'))).toBe(false)
    expect(fs.existsSync(plantedMcp)).toBe(false)
    // ...and what we DO write is back.
    expect(fs.existsSync(path.join(again, 'skills', 'agent-canvas', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(again, '.claude-plugin', 'plugin.json'))).toBe(true)
  })

  it('memoises only SUCCESS, so one transient write failure does not disable the skill for the whole app run', () => {
    // Caching a failure meant a single AV lock (or a resources dir not ready
    // at first spawn) silently killed the canvas workflow until restart.
    const dir = path.join(getResourcesDirectory(), 'canvas-plugin')
    writeFailure.next = true
    expect(ensureCanvasPlugin()).toBeNull()

    // Clear the obstacle — the very next call must retry and succeed.
    writeFailure.next = false
    const recovered = ensureCanvasPlugin()
    expect(recovered).toBe(dir)
    expect(fs.existsSync(path.join(recovered!, 'skills', 'agent-canvas', 'SKILL.md'))).toBe(true)
  })
})
