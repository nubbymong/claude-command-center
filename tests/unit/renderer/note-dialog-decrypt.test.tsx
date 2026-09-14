// @vitest-environment jsdom
/**
 * A note that cannot be decrypted must not be overwritten (ADR-009 pass on
 * #386). `notes:load` answers null when the keychain is unavailable, the file
 * is missing or damaged, or decryption fails -- and the IPC itself can reject.
 * Before this, either case left an EMPTY editable note with Save enabled, and
 * one click replaced the ciphertext with nothing.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'note-new' }))

const load = vi.fn()
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, notes: { list: vi.fn(async () => []), load, save: vi.fn(async () => true), delete: vi.fn(async () => true) } }

const { default: NoteDialog } = await import('../../../src/renderer/components/NoteDialog')

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); load.mockReset() })
afterEach(() => { act(() => { root.unmount() }); container.remove() })

const byTest = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const NOTE = { id: 'n1', label: 'API keys', color: '#F9E2AF', createdAt: 1 }
const mount = async (onSave = vi.fn()) => {
  await act(async () => { root.render(React.createElement(NoteDialog, { note: NOTE, configId: 'cfg', onSave, onCancel: vi.fn() })) })
  await act(async () => { await Promise.resolve() })
  return onSave
}

describe('an undecryptable note', () => {
  it('null from notes:load → says why, no editor, Save disabled', async () => {
    load.mockResolvedValue(null)
    await mount()
    expect(byTest('note-decrypt-failed')!.textContent).toContain('could not be decrypted')
    expect(byTest('note-content')).toBeNull()
    expect((byTest('note-save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a rejected notes:load is the same outcome, never "Decrypting…" forever', async () => {
    load.mockRejectedValue(new Error('ipc down'))
    await mount()
    expect(byTest('note-decrypting')).toBeNull()
    expect(byTest('note-decrypt-failed')).not.toBeNull()
    expect((byTest('note-save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a decrypted note edits and saves as before', async () => {
    load.mockResolvedValue('secret text')
    const onSave = await mount()
    expect((byTest('note-content') as HTMLTextAreaElement).value).toBe('secret text')
    expect((byTest('note-save') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { (byTest('note-save') as HTMLButtonElement).click() })
    expect(onSave).toHaveBeenCalledWith('n1', 'API keys', 'secret text', '#F9E2AF', undefined)
  })
})
