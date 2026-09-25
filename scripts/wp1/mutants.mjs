#!/usr/bin/env node
// WP1.54 verify-the-verifier: apply one SOURCE mutant at a time, run the WP1
// characterization tests, expect RED, restore the file from an in-memory
// backup (never `git checkout`, which would discard uncommitted work). Refuses
// to start on a dirty src/ tree so a restore can be proven by `git status`.
//
//   node scripts/wp1/mutants.mjs            # all mutants
//   node scripts/wp1/mutants.mjs M3 M7      # a subset
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const MUTANTS = [
  { id: 'M1', desc: 'withProfileHome also sets CLAUDE_CONFIG_DIR', file: 'src/main/account-profiles.ts',
    from: '    USERPROFILE: home,\n', to: '    USERPROFILE: home,\n    CLAUDE_CONFIG_DIR: home,\n', filter: 'C1' },
  { id: 'M2', desc: 'clobber-proofing removed (interactive default runs on the bare global home)', file: 'src/main/pty-manager.ts',
    from: '    if (!shellOnly && !resolvedProfileId) {\n      const primary = getPrimaryProfileId()', to: '    if (false) {\n      const primary = getPrimaryProfileId()', filter: 'C1' },
  { id: 'M3', desc: 'delete handler skips the post-clear in-use re-check', file: 'src/main/ipc/account-profiles-handlers.ts',
    from: '    if (isProfileInUseByLiveSession(p.id)) {\n      removeWebSession(p.id)', to: '    if (false) {\n      removeWebSession(p.id)', filter: 'C5' },
  // M4 and M7 mutated src/main/ipc/codex-handlers.ts for the C4
  // characterization. WP2 commit 6g deleted that file with the codex:* IPC,
  // and C4 with it; the ids are not reused.
  { id: 'M5', desc: 'withProfileHome drops the git/npm real-home pins', file: 'src/main/account-profiles.ts',
    from: "    GIT_CONFIG_GLOBAL: path.join(realHome, '.gitconfig'),\n    npm_config_userconfig: path.join(realHome, '.npmrc'),\n", to: '', filter: 'C1' },
  { id: 'M6', desc: 'PATH dedupe guard removed', file: 'src/main/account-profiles.ts',
    from: '  if (!already) next[pathKey]', to: '  if (true) next[pathKey]', filter: 'C1' },
  { id: 'M8', desc: 'delete handler id guard removed', file: 'src/main/ipc/account-profiles-handlers.ts',
    from: "    if (!p || !isValidProfileId(p.id)) return { ok: false, error: 'invalid profile id' }", to: "    if (!p) return { ok: false, error: 'invalid profile id' }", filter: 'C5' },
]

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedDirectly) {
  const only = process.argv.slice(2)
  const dirty = spawnSync('git', ['-C', ROOT, 'status', '--short', '--', 'src'], { encoding: 'utf8' }).stdout.trim()
  if (dirty) { console.error(`refusing to mutate a dirty src/ tree:\n${dirty}`); process.exit(2) }
  let allRed = true
  for (const m of MUTANTS.filter((m) => !only.length || only.includes(m.id))) {
    const p = resolve(ROOT, m.file)
    const backup = readFileSync(p, 'utf8')
    const eol = backup.includes('\r\n') ? '\r\n' : '\n'
    const from = m.from.split('\n').join(eol)
    const to = m.to.split('\n').join(eol)
    if (!backup.includes(from)) { console.log(`SKIP ${m.id} ${m.desc}: anchor not found (source moved; update the mutant)`); allRed = false; continue }
    writeFileSync(p, backup.replace(from, to))
    try {
      const applied = readFileSync(p, 'utf8') !== backup
      const r = spawnSync('npx', ['vitest', 'run', 'tests/wp1', '-t', m.filter], { cwd: ROOT, encoding: 'utf8', shell: true })
      const out = r.stdout + r.stderr
      const failed = /Tests\s+\d+ failed/.test(out)
      console.log(`${failed ? 'RED ' : 'GREEN'} ${m.id} ${m.desc} (mutation applied=${applied}) ${(out.match(/Tests\s+[^\n]+/) || [''])[0]}`)
      if (!failed) allRed = false
    } finally {
      writeFileSync(p, backup)
    }
  }
  const after = spawnSync('git', ['-C', ROOT, 'status', '--short', '--', 'src'], { encoding: 'utf8' }).stdout.trim()
  console.log('src restored clean:', after === '' ? 'yes' : 'NO -> ' + after)
  process.exit(allRed && after === '' ? 0 : 1)
}
