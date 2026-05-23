import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'

describe('TitleBar no longer carries the global account picker', () => {
  const src = readFileSync(join(__dirname, '../../../src/renderer/components/TitleBar.tsx'), 'utf-8')

  it('does not reference the account picker dropdown', () => {
    expect(src).not.toMatch(/accountRef|accountOpen|electronAPI\.account/)
  })

  it('does not import account-related IPC handlers', () => {
    expect(src).not.toMatch(/ACCOUNT_LIST|ACCOUNT_SWITCH/)
  })
})
