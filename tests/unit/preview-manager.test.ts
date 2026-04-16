import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/config-manager', () => ({
  readConfig: vi.fn().mockReturnValue(null),
  saveConfig: vi.fn(),
}))

vi.mock('../../src/main/debug-logger', () => ({
  logInfo: vi.fn(),
}))

vi.mock('fs', () => ({
  default: {
    promises: {
      access: vi.fn(),
    },
    constants: { R_OK: 4 },
  },
  promises: {
    access: vi.fn(),
  },
  constants: { R_OK: 4 },
}))

import {
  detectDevServerUrl,
  isPreviewableFile,
  getFileContentType,
  checkForDevServer,
  clearDetectedServers,
  addSuppressedProject,
} from '../../src/main/preview-manager'

describe('preview-manager', () => {
  describe('detectDevServerUrl', () => {
    it('detects Vite dev server URL', () => {
      const data = '  Local:   http://localhost:5173/'
      expect(detectDevServerUrl(data)).toBe('http://localhost:5173')
    })

    it('detects Next.js dev server', () => {
      const data = 'ready - started server on 0.0.0.0:3000, url: http://localhost:3000'
      expect(detectDevServerUrl(data)).toBe('http://localhost:3000')
    })

    it('detects Express listening on port', () => {
      const data = 'Server listening on port 8080'
      expect(detectDevServerUrl(data)).toBe('http://localhost:8080')
    })

    it('detects generic server running at URL', () => {
      const data = 'Server running at http://127.0.0.1:4000'
      expect(detectDevServerUrl(data)).toBe('http://127.0.0.1:4000')
    })

    it('returns null for non-matching data', () => {
      expect(detectDevServerUrl('Compiling TypeScript...')).toBeNull()
      expect(detectDevServerUrl('Build succeeded')).toBeNull()
      expect(detectDevServerUrl('')).toBeNull()
    })

    it('strips ANSI escape codes before matching', () => {
      const data = '\x1b[32m  Local:   http://localhost:5173/\x1b[0m'
      expect(detectDevServerUrl(data)).toBe('http://localhost:5173')
    })
  })

  describe('isPreviewableFile', () => {
    it('returns true for .html', () => {
      expect(isPreviewableFile('index.html')).toBe(true)
    })

    it('returns true for .png', () => {
      expect(isPreviewableFile('screenshot.png')).toBe(true)
    })

    it('returns true for .pdf', () => {
      expect(isPreviewableFile('document.pdf')).toBe(true)
    })

    it('returns true for .svg', () => {
      expect(isPreviewableFile('icon.svg')).toBe(true)
    })

    it('returns true for .md', () => {
      expect(isPreviewableFile('README.md')).toBe(true)
    })

    it('returns false for .ts', () => {
      expect(isPreviewableFile('app.ts')).toBe(false)
    })

    it('returns false for .js', () => {
      expect(isPreviewableFile('index.js')).toBe(false)
    })

    it('returns false for .json', () => {
      expect(isPreviewableFile('package.json')).toBe(false)
    })

    it('returns false for .txt', () => {
      expect(isPreviewableFile('notes.txt')).toBe(false)
    })
  })

  describe('getFileContentType', () => {
    it('returns text/html for .html', () => {
      expect(getFileContentType('page.html')).toBe('text/html')
    })

    it('returns image/png for .png', () => {
      expect(getFileContentType('image.png')).toBe('image/png')
    })

    it('returns application/pdf for .pdf', () => {
      expect(getFileContentType('doc.pdf')).toBe('application/pdf')
    })

    it('returns image/svg+xml for .svg', () => {
      expect(getFileContentType('logo.svg')).toBe('image/svg+xml')
    })

    it('returns application/octet-stream for unknown extensions', () => {
      expect(getFileContentType('data.xyz')).toBe('application/octet-stream')
      expect(getFileContentType('file.bin')).toBe('application/octet-stream')
    })
  })

  describe('checkForDevServer', () => {
    beforeEach(() => {
      clearDetectedServers('session-1')
      clearDetectedServers('session-2')
    })

    it('returns URL on first detection', () => {
      const result = checkForDevServer(
        'session-1',
        '  Local:   http://localhost:5173/',
        '/project/a'
      )
      expect(result).toBe('http://localhost:5173')
    })

    it('returns null for same URL on second detection (deduplication)', () => {
      checkForDevServer('session-1', '  Local:   http://localhost:5173/', '/project/a')
      const result = checkForDevServer(
        'session-1',
        '  Local:   http://localhost:5173/',
        '/project/a'
      )
      expect(result).toBeNull()
    })

    it('returns null for suppressed projects', () => {
      addSuppressedProject('/project/suppressed')
      const result = checkForDevServer(
        'session-2',
        '  Local:   http://localhost:5173/',
        '/project/suppressed'
      )
      expect(result).toBeNull()
    })

    it('returns null when data does not match any pattern', () => {
      const result = checkForDevServer('session-1', 'no server here', '/project/a')
      expect(result).toBeNull()
    })
  })
})
