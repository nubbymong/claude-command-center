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

  it('is cached per run, and the reset seam re-materializes after deletion', () => {
    const first = ensureCanvasPlugin()
    fs.rmSync(first!, { recursive: true, force: true })
    // Cached: the path is answered without re-checking disk (spawn-hot path).
    expect(ensureCanvasPlugin()).toBe(first)
    _resetCanvasPluginForTest()
    const again = ensureCanvasPlugin()
    expect(again).toBe(first)
    expect(fs.existsSync(path.join(again!, 'skills', 'agent-canvas', 'SKILL.md'))).toBe(true)
  })
})
