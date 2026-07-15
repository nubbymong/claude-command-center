import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { resolveCwd } from '../../../src/main/path-utils'

describe('resolveCwd', () => {
  let realDir: string
  let realSubdir: string

  beforeAll(() => {
    realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-path-utils-'))
    realSubdir = path.join(realDir, 'nested')
    fs.mkdirSync(realSubdir)
  })

  afterAll(() => {
    try { fs.rmSync(realDir, { recursive: true, force: true }) } catch {}
  })

  it('returns homedir for undefined / empty / "." / "~"', () => {
    expect(resolveCwd(undefined)).toBe(os.homedir())
    expect(resolveCwd('')).toBe(os.homedir())
    expect(resolveCwd('.')).toBe(os.homedir())
    expect(resolveCwd('~')).toBe(os.homedir())
  })

  it('expands "~/foo" against homedir when target exists', () => {
    // homedir itself is guaranteed to exist; "~/" should resolve to it.
    expect(resolveCwd('~/')).toBe(os.homedir())
  })

  it('returns absolute path as-is when the directory exists', () => {
    expect(resolveCwd(realSubdir)).toBe(path.resolve(realSubdir))
  })

  it('falls back to homedir when the resolved path does not exist', () => {
    const missing = path.join(realDir, 'definitely-not-here', 'nope')
    expect(resolveCwd(missing)).toBe(os.homedir())
  })

  it('falls back to homedir when the resolved path is a file, not a directory', () => {
    const filePath = path.join(realDir, 'a-file.txt')
    fs.writeFileSync(filePath, 'x')
    expect(resolveCwd(filePath)).toBe(os.homedir())
  })

  it('falls back to homedir for non-existent tilde-relative paths', () => {
    expect(resolveCwd('~/__definitely_not_a_real_dir_xyz__')).toBe(os.homedir())
  })
})
