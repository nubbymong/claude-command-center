// P3.10 round 3 (F3): the owner-only folder rule's `takeOwnership`, for a
// folder the app did not make this run: on Windows the user is made its owner
// (icacls /setowner, each spelling of the user in turn) BEFORE the DACL is
// replaced, and when that cannot be done the rule fails and changes nothing.
// icacls itself is not run: the calls are recorded.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'os'

const calls: string[][] = []
let refuse: (args: string[]) => boolean = () => false
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    execFileSync: vi.fn((_file: string, args: string[]) => {
      calls.push(args)
      if (refuse(args)) throw Object.assign(new Error('access denied'), { status: 5 })
      return ''
    }),
  }
})
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => os.tmpdir() }))

import { hardenCredentialDir, takeDirOwnershipWindows, windowsAclPrincipals, _resetAclStateForTest } from '../../../src/main/account-profiles'

const IS_WINDOWS = process.platform === 'win32'
const DIR = 'C:\\Users\\riley\\AppData\\Local\\ai-code-conductor'

beforeEach(() => {
  calls.length = 0
  refuse = () => false
  _resetAclStateForTest()
})

describe.runIf(IS_WINDOWS)('hardenCredentialDir with takeOwnership (Windows)', () => {
  it('makes the user the owner first, then replaces the DACL', () => {
    expect(hardenCredentialDir(DIR, { takeOwnership: true })).toBe(true)
    const first = windowsAclPrincipals()[0]
    expect(calls[0]).toEqual([DIR, '/setowner', first])
    expect(calls.slice(1).some((a) => a.includes('/grant:r'))).toBe(true)
  })

  it('fails, and changes nothing more, when the user may not take the folder', () => {
    refuse = (a) => a.includes('/setowner')
    expect(hardenCredentialDir(DIR, { takeOwnership: true })).toBe(false)
    expect(calls.every((a) => a.includes('/setowner'))).toBe(true)
    expect(calls.map((a) => a[2])).toEqual(windowsAclPrincipals())
  })

  it('tries the next spelling of the user when one does not resolve', () => {
    const spellings = windowsAclPrincipals()
    refuse = (a) => a.includes('/setowner') && a[2] === spellings[0]
    expect(takeDirOwnershipWindows(DIR)).toBe(spellings.length > 1)
  })

  it('without it, the rule is as before: no owner change', () => {
    expect(hardenCredentialDir(DIR)).toBe(true)
    expect(calls.some((a) => a.includes('/setowner'))).toBe(false)
  })
})

describe.runIf(!IS_WINDOWS)('hardenCredentialDir with takeOwnership (POSIX)', () => {
  it('a folder that is not there fails; the owner change is Windows only', () => {
    expect(hardenCredentialDir('/nonexistent-p310-folder', { takeOwnership: true })).toBe(false)
    expect(takeDirOwnershipWindows('/tmp')).toBe(false)
  })
})
