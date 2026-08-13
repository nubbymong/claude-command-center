// scripts/ccc.cmd — structural guards for bugs that were invisible for months (#257).
//
// A .cmd launcher has no natural test surface, which is exactly why these went
// unnoticed: every flag was silently broken while plain `ccc` worked. These are
// deliberately structural (ordering and token checks on the file itself) rather
// than behavioural — cheap, and each one pins a defect that actually shipped.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CMD = readFileSync(join(process.cwd(), 'scripts', 'ccc.cmd'), 'utf-8')
const lines = CMD.split(/\r?\n/)

/** First line index matching a predicate, or -1. */
const idx = (re: RegExp): number => lines.findIndex((l) => re.test(l))

describe('ccc.cmd — the launcher must survive its own flag parsing', () => {
  it('captures its own path BEFORE the parse loop shifts %0 away', () => {
    // `shift` shifts %0 too, so after parsing one flag `%~f0` resolves to the
    // FLAG, not the script. `start cmd /c "<cwd>\--seed-accounts" __run` then
    // failed instantly and the window vanished before a log existed.
    const self = idx(/^set "CCC_SELF=%~f0"/)
    const parse = idx(/^:parse/)
    expect(self).toBeGreaterThan(-1)
    expect(parse).toBeGreaterThan(-1)
    expect(self).toBeLessThan(parse)
  })

  it('hands the captured path to start, never %~f0', () => {
    const start = lines.find((l) => l.startsWith('start "AI Code Conductor'))
    expect(start).toBeDefined()
    expect(start).toContain('%CCC_SELF%')
    expect(start).not.toContain('%~f0')
  })

  it('still shifts while parsing — the guard must not be "stop using shift"', () => {
    // Keeping `shift` is fine; the fix is capturing %0 first. If the loop were
    // rewritten without shift these guards should be revisited, not deleted.
    expect(idx(/^shift$/)).toBeGreaterThan(-1)
  })
})

describe('ccc.cmd — a failing run has to leave something behind', () => {
  it('creates the log BEFORE the seed steps run', () => {
    // Seeding used to happen with no log file in existence, so a seed-time
    // failure had nowhere to write and the cmd /c window closed over it.
    const logFile = idx(/^set "CCC_LOGFILE=/)
    const seedConfig = idx(/^if defined CCC_SEED powershell/)
    const seedAccounts = idx(/^if defined CCC_SEED_ACCOUNTS node/)
    expect(logFile).toBeGreaterThan(-1)
    expect(seedConfig).toBeGreaterThan(logFile)
    expect(seedAccounts).toBeGreaterThan(logFile)
  })

  it('writes the truncating header before the seeds, never after them', () => {
    // The header used `>` and sat just above `npm run dev`, wiping everything the
    // seed steps had appended.
    const header = idx(/^> "%CCC_LOGFILE%" echo \[ccc\] repo=/)
    const seedAccounts = idx(/^if defined CCC_SEED_ACCOUNTS node/)
    expect(header).toBeGreaterThan(-1)
    expect(header).toBeLessThan(seedAccounts)
  })

  it('does not use Tee-Object, which writes UTF-16 on PS 5.1', () => {
    // It has no -Encoding there, so it appended mojibake into an ASCII log and
    // made the result unsearchable.
    expect(CMD).not.toContain('Tee-Object')
  })

  it('holds the window open on a non-zero exit', () => {
    const tail = CMD.slice(CMD.indexOf('npm run dev'))
    expect(tail).toMatch(/if errorlevel 1 \(/)
    expect(tail).toMatch(/pause/)
  })
})

describe('ccc.cmd — flags stay distinct', () => {
  it('parses --seed and --seed-accounts as separate flags', () => {
    // Different things at different risk: CONFIG is settings, accounts are live
    // OAuth tokens shared with prod.
    expect(CMD).toMatch(/if \/I "%~1"=="--seed"\s+set "CCC_SEED=1"/)
    expect(CMD).toMatch(/if \/I "%~1"=="--seed-accounts"\s+set "CCC_SEED_ACCOUNTS=1"/)
  })

  it('records both in the log header, so a run says what it did', () => {
    const header = lines.find((l) => l.startsWith('> "%CCC_LOGFILE%" echo [ccc] repo='))
    expect(header).toContain('seed=%CCC_SEED%')
    expect(header).toContain('seedAccounts=%CCC_SEED_ACCOUNTS%')
  })
})
