/// <reference types="vite/client" />
/**
 * P3.12 round 1 (A4): the GitHub Session Context's recent-files heading names
 * the session's own assistant (the handler reports it with the context), and
 * the handler reads the list relative to the session's folder.
 */
import { describe, it, expect } from 'vitest'
import { recentFilesHeading } from '../../../src/renderer/components/github/sections/recent-files-heading'
import sectionSource from '../../../src/renderer/components/github/sections/SessionContextSection.tsx?raw'
import handlersSource from '../../../src/main/ipc/github-handlers.ts?raw'

describe('the recent-files heading (P3.12 round 1, A4)', () => {
  it('names the session\'s assistant', () => {
    expect(recentFilesHeading('codex')).toBe('Codex recently edited:')
    expect(recentFilesHeading('claude')).toBe('Claude recently edited:')
    expect(recentFilesHeading(undefined)).toBe('Claude recently edited:')
  })

  it('the section shows the heading for the assistant the context reports, never a fixed one', () => {
    expect(sectionSource).toContain('recentFilesHeading(ctx.assistant)')
    expect(sectionSource).not.toMatch(/Claude recently edited/)
  })

  it('the handler reports the session\'s assistant and reads the list relative to the session\'s folder', () => {
    const at = handlersSource.indexOf('IPC.GITHUB_SESSION_CONTEXT_GET')
    const body = handlersSource.slice(at, handlersSource.indexOf('ipcMain.handle(', at + 10))
    expect(body).toContain('extractFileSignals(events.toolCalls, session?.workingDirectory)')
    expect(body).toMatch(/assistant: session\?\.provider === 'codex' \? 'codex' : 'claude'/)
  })

  it('X6: the list keys each row on its file\'s path, not its shown text', () => {
    expect(sectionSource).toContain('key={f.pathKey ?? f.filePath}')
    expect(sectionSource).not.toContain('key={f.filePath}')
  })
})
