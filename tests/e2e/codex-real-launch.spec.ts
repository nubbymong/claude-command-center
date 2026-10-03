/**
 * The Codex mode matrix, a real launch (P4.9, row 67; WP1.60's minimum real
 * launch smoke): the app starts a REAL Codex CLI in a Codex tab, on a managed
 * account's folder, with no sign-in (a fake API key), against the loopback
 * fake model, and the session answers a prompt. One run per installed Codex
 * given (the VM has 0.153.4 and 0.155.1).
 *
 * VM ONLY, and skipped unless the VM run gives both:
 *   CCC_E2E_REAL_CODEX       the installs, `<version>=<absolute path>` joined
 *                            by `;`: an npm install's `codex.cmd` shim or the
 *                            `codex.exe` it ships;
 *   CCC_E2E_FAKE_MODEL_URL   the loopback fake model's base URL (for example
 *                            http://127.0.0.1:18893/v1), already running.
 *
 * The rules of the 2026-10-02 VM incident hold here (completion plan 9.2):
 *   - Codex's sandbox menu is answered only by moving the selection to "2"
 *     and pressing Enter once "2." is the selected row; never option 1 (the
 *     administrator setup is the owner's), never a digit and Enter at once;
 *   - nothing is typed into a run whose composer is not ready: ready means
 *     Codex's footer is on the last line and no prompt is on screen, on two
 *     reads 300 ms apart;
 *   - the account's config.toml is hashed before and after: the app's launch
 *     writes nothing there, and Codex writes only what the answers record;
 *   - nothing starts Codex on, or writes into, the VM user's own ~/.codex:
 *     the account's folder, the instance's home and the "sign-in already on
 *     this computer" folder are all inside the spec's data dir, and a
 *     read-only listing of the user's own folder (path, size, modified time)
 *     must be the same after the run as before it.
 * Hooks given at launch need Codex's review once per account folder; the
 * spec answers "Continue without trusting" the same way (the selection
 * moved, Enter only on that row), so config.toml records no hook trust.
 * Every request stays on the VM: a dead proxy for everything but loopback.
 */
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import os from 'os'
import { spawnSync } from 'child_process'
import { launchIsolatedApp, closeIsolatedApp, type IsolatedApp } from './helpers/electron-app'
import { pathWithoutCodex } from './helpers/fake-codex'
import { isolatedHomeDir } from './helpers/isolated-env'
import {
  seedCodexAccount, realmDirOf, createCodexConfig, openSession, activeSessionId, terminalRows, ptyWrite,
} from './helpers/codex-mode'
import { classifyCodexVersion } from '../../src/main/providers/codex/cli-contract'

const IS_WIN = process.platform === 'win32'
const FAKE_MODEL_URL = (process.env.CCC_E2E_FAKE_MODEL_URL ?? '').trim()
const FAKE_KEY = 'sk-e2e-fake-key-not-real'
const DEAD_PROXY = { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }
/** The prompt the fake model answers with "Done: PLAIN 67 (...)" (row 67). */
const PROMPT = 'P310-PLAIN-67'
const REPLY = 'Done: PLAIN 67'

/** `<version>=<path>;...`, each an absolute path to an existing file. */
function realInstalls(): Array<{ version: string; bin: string }> {
  const out: Array<{ version: string; bin: string }> = []
  for (const part of (process.env.CCC_E2E_REAL_CODEX ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    const version = part.slice(0, at).trim()
    const bin = part.slice(at + 1).trim()
    if (/^\d+\.\d+\.\d+$/.test(version) && path.isAbsolute(bin) && fs.existsSync(bin)) out.push({ version, bin })
  }
  return out
}
const INSTALLS = realInstalls()

const sha = (p: string): string => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') } catch { return 'missing' }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The VM user's own Codex folders, which nothing here may touch: the real
 *  profile's .codex (os.userInfo() reads the account's profile, not the
 *  HOME/USERPROFILE a run sets), and any CODEX_HOME the runner was given. */
function ownCodexFolders(): string[] {
  const out = new Set<string>()
  try { out.add(path.join(os.userInfo().homedir, '.codex')) } catch { /* no profile */ }
  if (process.env.CODEX_HOME) out.add(path.resolve(process.env.CODEX_HOME))
  return [...out]
}

/** A read-only picture of a folder: every entry's relative path, size and
 *  modified time (links not followed), hashed; or 'absent'. */
function snapshot(dir: string): string {
  if (!fs.existsSync(dir)) return 'absent'
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    let names: string[]
    try { names = fs.readdirSync(d).sort() } catch { out.push(`${rel || '.'} unreadable`); return }
    for (const n of names) {
      const p = path.join(d, n)
      const r = rel ? `${rel}/${n}` : n
      let st: fs.Stats
      try { st = fs.lstatSync(p) } catch { out.push(`${r} unreadable`); continue }
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p, r)
      else out.push(`${r} ${st.size} ${Math.floor(st.mtimeMs)}`)
    }
  }
  walk(dir, '')
  return `${crypto.createHash('sha256').update(out.join('\n')).digest('hex')} (${out.length} entries)`
}

/** The throwaway account folder's config: the loopback fake model, no retries. */
function fakeModelToml(url: string): string {
  return [
    '# P4.9 real-launch spec: TEST HARNESS ONLY (a throwaway Codex home). The model is the loopback fake model; no network.',
    'model_provider = "e2efake"',
    '',
    '[model_providers.e2efake]',
    'name = "e2e fake model (loopback test harness)"',
    `base_url = "${url}"`,
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n')
}

/** Run the real CLI once outside the app (the fake-key sign-in, its check),
 *  in the account's folder, behind the dead proxy, with a home of the spec's. */
function runCli(bin: string, args: string[], env: Record<string, string>, input?: string) {
  const opts = { env, input, encoding: 'utf8' as const, timeout: 60000, windowsHide: true }
  if (IS_WIN && /\.(cmd|bat)$/i.test(bin)) {
    const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    return spawnSync(shell, ['/d', '/s', '/c', `""${bin}" ${args.join(' ')}"`], { ...opts, windowsVerbatimArguments: true })
  }
  return spawnSync(bin, args, opts)
}

/** An environment with no Codex or OpenAI variable of the runner's, a home of
 *  the spec's, and the dead proxy. */
function cliEnv(dataDir: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(OPENAI_|CODEX_)/i.test(k)) continue
    env[k] = v
  }
  const home = isolatedHomeDir(dataDir)
  fs.mkdirSync(home, { recursive: true })
  return { ...env, USERPROFILE: home, HOME: home, ...DEAD_PROXY, ...extra }
}

const TRUST = /trust the contents|Do you trust|Yes, continue/i
const SANDBOX = /Set up default sandbox|Use non-admin sandbox|Set up the Codex agent sandbox/i
const HOOKS = /Hooks need review/i
const ANY_PROMPT = /trust the contents|Do you trust|Yes, continue|No, quit|Set up default sandbox|Use non-admin sandbox|Set up the Codex agent sandbox|Hooks need review/i
/** The selected row of a Codex menu. */
const selectedRow = (rows: string[]) => rows.find((l) => /^\s*\u203a\s*\d\./.test(l)) ?? ''
/** A ready composer: no prompt on screen, and Codex's footer (model and
 *  folder, joined by a middle dot) on the last line. */
function readyOn(rows: string[]): boolean {
  const shown = rows.filter((l) => l.trim())
  return !ANY_PROMPT.test(shown.join('\n')) && /gpt-\S+ .*\u00b7 /.test(shown[shown.length - 1] ?? '')
}

test.skip(INSTALLS.length === 0 || !FAKE_MODEL_URL, 'VM only: needs CCC_E2E_REAL_CODEX (the installed Codex CLIs) and CCC_E2E_FAKE_MODEL_URL (the loopback fake model)')

// With no install given, one case stands for the run, so the report shows it
// skipped rather than nothing at all.
if (INSTALLS.length === 0) test('a real Codex launch (no real Codex CLI given)', () => { /* skipped above */ })

for (const { version, bin } of INSTALLS) {
  test.describe(`a real Codex ${version} launch (${path.basename(bin)})`, () => {
    let ctx: IsolatedApp | undefined
    test.afterAll(async () => {
      test.setTimeout(120000)
      await closeIsolatedApp(ctx)
    })

    test('starts in a Codex tab on the account folder, through its first screens by the VM rules, and answers a prompt', async () => {
      test.setTimeout(300000)
      let configToml = ''
      let projectDir = ''
      let cfgSeeded = ''
      let seededText = ''
      // The VM user's own Codex folders, before anything starts.
      const own = ownCodexFolders().map((dir) => ({ dir, before: snapshot(dir) }))
      ctx = await launchIsolatedApp({
        seedExtra: (dataDir) => {
          seedCodexAccount(dataDir, { fake: false, domTerminal: true, method: 'apiKey' })
          const realm = realmDirOf(dataDir)
          configToml = path.join(realm, 'config.toml')
          fs.writeFileSync(configToml, fakeModelToml(FAKE_MODEL_URL))
          const env = cliEnv(dataDir, { CODEX_HOME: realm })
          const login = runCli(bin, ['login', '--with-api-key'], env, `${FAKE_KEY}\n`)
          if (login.status !== 0) throw new Error(`the fake-key sign-in failed (exit ${login.status}): ${login.stderr}`)
          const status = runCli(bin, ['login', 'status'], env)
          if (!/Logged in using an API key/.test(`${status.stdout}${status.stderr}`)) throw new Error(`the account folder is not signed in with the fake key: ${status.stdout}${status.stderr}`)
          // The baseline: the seeded file and the fake-key sign-in, before the app starts.
          cfgSeeded = sha(configToml)
          seededText = fs.readFileSync(configToml, 'utf8')
          projectDir = path.join(dataDir, `project-${version}`)
          fs.mkdirSync(projectDir, { recursive: true })
        },
        env: (dataDir) => ({
          PATH: [path.dirname(bin), ...pathWithoutCodex(process.env.PATH ?? '')].join(path.delimiter),
          // "Sign-in already on this computer": an empty folder of the spec's.
          CODEX_HOME: (() => { const d = path.join(dataDir, 'codex-home'); fs.mkdirSync(d, { recursive: true }); return d })(),
          ...DEAD_PROXY,
        }),
      })
      const { page } = ctx
      // The app's start wrote nothing into the account's config.toml.
      expect(sha(configToml), 'config.toml changed while the app started').toBe(cfgSeeded)

      // The app proves the real CLI it will run.
      const discovered = await page.evaluate(async () => {
        const api = (window as unknown as { electronAPI: { providerAccounts: { discover: (id: string) => Promise<unknown> } } }).electronAPI
        return api.providerAccounts.discover('codex')
      }) as { ok: boolean; installation?: Record<string, unknown> }
      expect(discovered.installation, JSON.stringify(discovered)).toMatchObject({ discoveryState: 'found', version, compatibility: classifyCodexVersion(version) })

      await createCodexConfig(page, { label: `Real Codex ${version}`, dir: projectDir })
      await openSession(page, `Real Codex ${version}`)
      const sid = await activeSessionId(page)

      // The first screens, answered only as the VM rules allow.
      const screens: string[] = []
      let cfgAtFirstScreen: string | null = null
      let ready = false
      const deadline = Date.now() + 150000
      while (Date.now() < deadline) {
        const rows = await terminalRows(page)
        const text = rows.join('\n')
        // The sandbox menu first, then the hooks review, then the folder
        // trust: each is answered only once the row it confirms is the
        // selected one. Never option 1 of the sandbox menu.
        if (SANDBOX.test(text) && screens.filter((s) => s === 'sandbox').length < 2) {
          cfgAtFirstScreen ??= sha(configToml)
          screens.push('sandbox')
          await sleep(400)
          // A digit only moves the selection in this menu; Enter confirms.
          await ptyWrite(page, sid, '2')
          await sleep(700)
          const sel = selectedRow(await terminalRows(page))
          if (!/\u203a\s*2\.\s*Use non-admin sandbox/.test(sel)) throw new Error(`sandbox menu: option 2 is not the selected row (${JSON.stringify(sel.trim())}); nothing was confirmed`)
          await ptyWrite(page, sid, '\r')
          await sleep(1500)
          continue
        }
        if (HOOKS.test(text) && !screens.includes('hooks')) {
          cfgAtFirstScreen ??= sha(configToml)
          screens.push('hooks')
          await sleep(400)
          await ptyWrite(page, sid, '\x1b[B')
          await sleep(300)
          await ptyWrite(page, sid, '\x1b[B')
          await sleep(700)
          const sel = selectedRow(await terminalRows(page))
          if (!/\u203a\s*3\.\s*Continue without trusting/.test(sel)) throw new Error(`hooks review: option 3 is not the selected row (${JSON.stringify(sel.trim())}); nothing was confirmed`)
          await ptyWrite(page, sid, '\r')
          await sleep(1500)
          continue
        }
        if (TRUST.test(text) && !screens.includes('trust')) {
          cfgAtFirstScreen ??= sha(configToml)
          screens.push('trust')
          await sleep(400)
          const sel = selectedRow(await terminalRows(page))
          if (!/\u203a\s*1\.\s*Yes, continue/.test(sel)) throw new Error(`folder trust: "1. Yes, continue" is not the selected row (${JSON.stringify(sel.trim())}); nothing was confirmed`)
          await ptyWrite(page, sid, '\r')
          await sleep(1200)
          continue
        }
        if (readyOn(rows)) {
          await sleep(300)
          if (readyOn(await terminalRows(page))) { ready = true; break }
        }
        await sleep(250)
      }
      test.info().annotations.push({ type: 'screens', description: screens.join(', ') || 'none' })
      expect(ready, `no ready composer within the bound; the screen:\n${(await terminalRows(page)).filter((l) => l.trim()).join('\n')}`).toBe(true)
      // A new account folder in a new project shows the folder trust first,
      // and on Windows Codex's sandbox menu (PB4).
      expect(screens).toContain('trust')
      if (IS_WIN) expect(screens).toContain('sandbox')
      // The app's launch wrote nothing into the account's config.toml: what
      // changed there changed on the answers.
      expect(cfgAtFirstScreen ?? sha(configToml), 'config.toml changed before Codex asked anything').toBe(cfgSeeded)

      // A minimal turn: the text, then Enter as its own write once the
      // composer shows it (P4.1's submit form).
      await ptyWrite(page, sid, PROMPT)
      await expect.poll(async () => (await terminalRows(page)).some((l) => l.includes(PROMPT)), { timeout: 5000, message: 'the composer never showed the prompt' }).toBe(true)
      await sleep(300)
      await ptyWrite(page, sid, '\r')
      await expect.poll(async () => (await terminalRows(page)).some((l) => l.includes(REPLY)), { timeout: 60000, message: 'no reply from the fake model' }).toBe(true)

      // config.toml after: everything seeded is still there; what Codex added
      // is the folder trust and the Windows sandbox, never the administrator
      // setup and never a hook's trust.
      const after = fs.readFileSync(configToml, 'utf8')
      test.info().annotations.push({ type: 'config.toml', description: `seeded ${cfgSeeded.slice(0, 16)}; after the answers ${sha(configToml).slice(0, 16)}` })
      const afterLines = after.split(/\r?\n/)
      for (const line of seededText.split('\n').filter((l) => l.trim())) expect(afterLines, `config.toml lost: ${line}`).toContain(line)
      const seeded = new Set(seededText.split('\n'))
      let section = ''
      for (const line of afterLines) {
        if (/^\s*\[/.test(line)) section = line.trim()
        if (!line.trim() || seeded.has(line)) continue
        expect(section, `config.toml gained ${JSON.stringify(line)} under ${section || 'the top level'}`).toMatch(/^\[(projects\.|windows\])/)
      }
      expect(after).not.toMatch(/sandbox\s*=\s*"elevated"/)
      expect(after).not.toMatch(/trusted_hash/)
      expect(after).toMatch(/trust_level\s*=\s*"trusted"/)
      if (IS_WIN) expect(after).toMatch(/^\[windows\]/m)
      // Nothing of this run reached the VM user's own Codex folders.
      for (const o of own) expect(snapshot(o.dir), `${o.dir} changed during the run`).toBe(o.before)
      test.info().annotations.push({ type: 'own Codex folders', description: own.map((o) => `${o.dir}: ${o.before}`).join('; ') || 'none' })
    })
  })
}
