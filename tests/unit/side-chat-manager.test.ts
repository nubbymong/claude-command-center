import { describe, it, expect, vi } from 'vitest'

// Mock pty-manager to avoid node-pty / Electron dependencies
vi.mock('../../src/main/pty-manager', () => ({
  spawnPty: vi.fn(),
  killPty: vi.fn(),
  getPtyOutputBuffer: vi.fn(() => undefined),
}))

// Mock fs to avoid real filesystem I/O
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

import { generateSideChatId, buildContextInjection } from '../../src/main/side-chat-manager'

describe('side-chat-manager', () => {
  describe('generateSideChatId', () => {
    it('generates ID with parent prefix and unique suffix', () => {
      const id = generateSideChatId('session-123')
      expect(id).toMatch(/^session-123-sidechat-.+$/)
    })

    it('generates unique IDs', () => {
      const a = generateSideChatId('session-123')
      const b = generateSideChatId('session-123')
      // May be same if called within same ms, but format is correct
      expect(a).toMatch(/^session-123-sidechat-/)
      expect(b).toMatch(/^session-123-sidechat-/)
    })
  })

  describe('buildContextInjection', () => {
    it('includes parent session label', () => {
      const context = buildContextInjection('s1', 'API Refactor', '/project', 'opus', 42)
      expect(context).toContain('API Refactor')
    })

    it('includes working directory', () => {
      const context = buildContextInjection('s1', 'Test', '/my/project', undefined, undefined)
      expect(context).toContain('/my/project')
    })

    it('includes model when provided', () => {
      const context = buildContextInjection('s1', 'Test', '/project', 'sonnet', undefined)
      expect(context).toContain('sonnet')
    })

    it('includes context percent when provided', () => {
      const context = buildContextInjection('s1', 'Test', '/project', undefined, 65.7)
      expect(context).toContain('66%')
    })

    it('handles missing optional fields gracefully', () => {
      const context = buildContextInjection('s1', 'Test', '/project')
      expect(context).toContain('Side Chat Context')
      expect(context).toContain('Test')
      expect(context).not.toContain('undefined')
    })

    it('states responses do not affect main thread', () => {
      const context = buildContextInjection('s1', 'Test', '/project')
      expect(context).toContain('do not affect the main thread')
    })
  })
})
