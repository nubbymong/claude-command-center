import { describe, it, expect } from 'vitest'
import { removeRetiredCommands } from '../../../src/renderer/utils/configHydration'
import type { CustomCommand } from '../../../src/renderer/stores/commandStore'

const cmd = (id: string, label = id): CustomCommand => ({
  id,
  label,
  prompt: 'x',
  scope: 'global',
})

describe('removeRetiredCommands', () => {
  it('removes the legacy builtin-setup-statusline command', () => {
    const input = [cmd('builtin-setup-statusline', 'Setup Statusline'), cmd('user-123', 'My cmd')]
    const out = removeRetiredCommands(input)
    expect(out.map((c) => c.id)).toEqual(['user-123'])
  })

  it('returns the SAME reference when there is nothing to remove (no-op detect)', () => {
    const input = [cmd('user-1'), cmd('user-2')]
    const out = removeRetiredCommands(input)
    expect(out).toBe(input)
  })

  it('never removes a user command that merely mentions statusline in its label', () => {
    const input = [cmd('user-xyz', 'Setup Statusline')]
    const out = removeRetiredCommands(input)
    expect(out).toBe(input)
    expect(out).toHaveLength(1)
  })

  it('handles an empty list', () => {
    const input: CustomCommand[] = []
    expect(removeRetiredCommands(input)).toBe(input)
  })
})
