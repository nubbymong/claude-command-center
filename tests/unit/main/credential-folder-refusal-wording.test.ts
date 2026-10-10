// When the app cannot make an account's sign-in folders private to the user,
// the refusal names the folder the user can act on: AI Code Conductor's
// resources folder (where the account folders live), never "the app data
// folder", which a Windows user reads as %APPDATA%, another folder. (The
// managed account folders of the other provider say the same:
// realm-folders-owner-only-wiring.test.ts.)
//
// Host-safe: no process starts.
import { describe, it, expect, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const no = (file: unknown) => { throw new Error(`no process in this test: ${String(file)}`) }
  const execFileSync = vi.fn(no)
  const execFile = vi.fn(no)
  const spawn = vi.fn(no)
  const spawnSync = vi.fn(no)
  const execSync = vi.fn(no)
  return { ...real, execFileSync, execFile, spawn, spawnSync, execSync, default: { ...real, execFileSync, execFile, spawn, spawnSync, execSync } }
})

import { CREDENTIAL_FOLDER_REFUSAL } from '../../../src/main/account-profiles'

describe('a refusal to use an account\'s sign-in folders names the resources folder', () => {
  it('names AI Code Conductor\'s resources folder, never the app data folder', () => {
    expect(CREDENTIAL_FOLDER_REFUSAL).toMatch(/AI Code Conductor's resources folder/)
    expect(CREDENTIAL_FOLDER_REFUSAL).not.toMatch(/app data folder|app's data folder/i)
  })
})
