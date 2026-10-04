// [host] WP2 PR 4, P4.5 (row 57): a Cloud Agent on Codex is one `codex exec`
// through the CLI runner, from a prepared launch: PB5's argv without `-C`
// (the project is the working folder, as the reviewer's run is), the task on
// stdin, each permission choice mapped as section 10's question 7 builds its
// default A (default: read-only; skip-permissions: Auto's workspace-write),
// never danger-full-access or a sandbox bypass, no --ephemeral and no
// --ignore-user-config; the model and effort held to the launch's own rules
// and the runner's PLAIN_ARG; a network-path project refused on the npm
// `.cmd` route. The JSONL is read as it streams: each agent message is handed
// on, stderr is handed on (a refused edit shows only there), usage is summed
// and priced. PURE: no process is started (the runner's spawn is faked).
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  codexAgentArgs, codexAgentCommandLine, codexAgentSandbox, createCodexBackgroundOperations, CODEX_AGENT_EFFORTS, CODEX_AGENT_TIMEOUT_MS,
} from '../../../../src/main/providers/codex/agent-run'
import { CODEX_EFFORTS } from '../../../../src/main/sanitize-restored-spawn-options'
import type { CodexRunDeps } from '../../../../src/main/providers/codex/cli-runner'
import { CODEX_EXEC_EXIT_SETTLE_MS } from '../../../../src/main/providers/codex/review'
import { redactFailure } from '../../../../src/main/providers/review-support'

const fixture = (version: string, name: string) => readFileSync(join(__dirname, `../../../fixtures/codex/cli/${version}/${name}`), 'utf8')
const PLAIN_ARG = /^[A-Za-z0-9._,:=/[\]-]+$/

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { end: vi.fn(), on: vi.fn() }
}

function fakeDeps(platform: NodeJS.Platform = 'win32') {
  const spawned: Array<{ file: string; args: readonly string[]; opts: Record<string, unknown>; child: FakeChild }> = []
  const scopes: unknown[] = []
  const deps: CodexRunDeps = {
    platform,
    spawn: ((file: string, args: readonly string[], opts: Record<string, unknown>) => {
      const child = new FakeChild()
      spawned.push({ file, args, opts, child })
      return child
    }) as never,
    killTree: ((c: EventEmitter, o?: { scope?: string }) => { scopes.push(o?.scope); queueMicrotask(() => c.emit('exit', null, 'SIGKILL')) }) as never,
  }
  return { deps, spawned, scopes }
}

const ENV = { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\res\\codex-realms\\realm-1', CCC_SESSION: 'x', CONDUCTOR_MCP_TOKEN: 'y' }
const input = (over: Record<string, unknown> = {}) => ({
  executable: 'C:\\Tools\\codex.exe', env: ENV, cwd: 'D:\\work\\proj', prompt: 'Tidy the imports.', skipPermissions: false, ...over,
})

describe('the argv (PB5; question 7, default A)', () => {
  it('the default runs read-only, skip-permissions runs Auto: workspace-write; never danger-full-access', () => {
    expect(codexAgentSandbox(false)).toBe('read-only')
    expect(codexAgentSandbox(true)).toBe('workspace-write')
    expect(codexAgentSandbox('yes' as never)).toBe('read-only')
    expect(codexAgentArgs({ sandbox: 'read-only' })).toEqual(['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-'])
    expect(codexAgentArgs({ sandbox: 'workspace-write', model: 'gpt-5.5', effort: 'high' }))
      .toEqual(['exec', '--json', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort=high', '-s', 'workspace-write', '--skip-git-repo-check', '-'])
    for (const bad of ['danger-full-access', 'workspace_write', '', undefined, null]) {
      expect(codexAgentArgs({ sandbox: bad }), String(bad)).toHaveProperty('refused')
    }
  })

  it('no path, no --ephemeral, no --ignore-user-config, no -C, no sandbox bypass; every element passes PLAIN_ARG', () => {
    for (const sandbox of ['read-only', 'workspace-write'] as const) {
      const args = codexAgentArgs({ sandbox, model: 'gpt-oss:20b', effort: 'xhigh' }) as string[]
      for (const a of args) expect(PLAIN_ARG.test(a), a).toBe(true)
      for (const never of ['--ephemeral', '--ignore-user-config', '-C', '--cd', '--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--yolo', 'danger-full-access']) {
        expect(args).not.toContain(never)
      }
      // No element is a path: no backslash, no drive, no leading slash.
      expect(args.filter((a) => a.includes('\\') || /^[A-Za-z]:/.test(a) || a.startsWith('/'))).toEqual([])
      expect(args.at(-1)).toBe('-')
    }
  })

  it('the model and the effort: absent or empty pass nothing, effort none passes nothing; anything else outside the launch rules is refused', () => {
    expect(codexAgentArgs({ sandbox: 'read-only', model: '', effort: 'none' })).toEqual(['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-'])
    for (const model of ['-rf', 'gpt 5', 'gpt-5.5;calc', 'a&b', 'x'.repeat(65), '/abs', 7]) {
      expect(codexAgentArgs({ sandbox: 'read-only', model }), String(model)).toHaveProperty('refused')
    }
    for (const effort of ['HIGH', 'extreme', 'high ', 'high&calc', 3]) {
      expect(codexAgentArgs({ sandbox: 'read-only', effort }), String(effort)).toHaveProperty('refused')
    }
  })

  it("the efforts are the launch's own list less 'none'", () => {
    expect([...CODEX_AGENT_EFFORTS]).toEqual(CODEX_EFFORTS.filter((e) => e !== 'none'))
  })

  it('every flag is one both supported CLIs list for exec', () => {
    for (const version of ['0.153.4', '0.155.1']) {
      const help = fixture(version, 'help/exec-help.txt')
      for (const flag of ['--json', '-m, --model', '-c, --config', '-s, --sandbox', '--skip-git-repo-check']) expect(help, `${version} ${flag}`).toContain(flag)
      for (const level of ['read-only', 'workspace-write']) expect(help, `${version} ${level}`).toContain(level)
    }
  })

  it('the command line: direct on an executable, through cmd.exe verbatim for an npm shim', () => {
    const direct = codexAgentCommandLine('C:\\Tools\\codex.exe', { sandbox: 'read-only' }, 'win32', { SystemRoot: 'C:\\Windows' })
    expect(direct).toMatchObject({ file: 'C:\\Tools\\codex.exe', verbatim: false, args: ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-'] })
    const shim = codexAgentCommandLine('C:\\npm\\codex.cmd', { sandbox: 'workspace-write', model: 'gpt-5.5' }, 'win32', { SystemRoot: 'C:\\Windows' })
    expect(shim).toMatchObject({ file: 'C:\\Windows\\System32\\cmd.exe', verbatim: true })
    expect((shim as { args: string[] }).args.at(-1)).toBe('""C:\\npm\\codex.cmd" exec --json -m gpt-5.5 -s workspace-write --skip-git-repo-check -"')
    expect(codexAgentCommandLine('codex.exe', { sandbox: 'read-only' }, 'win32', { SystemRoot: 'C:\\Windows' })).toHaveProperty('refused')
  })
})

describe('the run', () => {
  it('runs in the project as its working folder, the task on stdin, no shell, the Conductor variables removed, no deadline of its own', async () => {
    const { deps, spawned } = fakeDeps()
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    const s = spawned[0]
    expect(s.file).toBe('C:\\Tools\\codex.exe')
    expect(s.args).toEqual(['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-'])
    expect(s.opts).toMatchObject({ cwd: 'D:\\work\\proj', shell: false, windowsHide: true })
    const env = s.opts.env as Record<string, string>
    expect(env.CODEX_HOME).toBe(ENV.CODEX_HOME)
    expect(env.CCC_SESSION).toBeUndefined()
    expect(env.CONDUCTOR_MCP_TOKEN).toBeUndefined()
    expect(s.child.stdin.end).toHaveBeenCalledWith('Tidy the imports.')
    s.child.emit('exit', 0)
    s.child.emit('close', 0)
    expect(await p).toEqual({ ok: true })
    expect(CODEX_AGENT_TIMEOUT_MS).toBe(2_147_483_647)
  })

  it('skip-permissions runs workspace-write; the model and effort reach the argv', async () => {
    const { deps, spawned } = fakeDeps()
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ skipPermissions: true, model: 'gpt-5.5', effort: 'medium' }))
    expect(spawned[0].args).toEqual(['exec', '--json', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort=medium', '-s', 'workspace-write', '--skip-git-repo-check', '-'])
    spawned[0].child.emit('close', 0)
    await p
  })

  for (const version of ['0.153.4', '0.155.1']) {
    for (const name of ['exec-json.jsonl', 'exec-edit-json.jsonl']) {
      it(`${version} ${name}: every agent message handed on in order, usage summed and priced`, async () => {
        const { deps, spawned } = fakeDeps()
        const texts: string[] = []
        const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ model: 'gpt-5.5', onText: (t: string) => texts.push(t) }))
        const jsonl = fixture(version, name)
        // Split mid-line, as a pipe delivers it.
        const cut = Math.floor(jsonl.length / 2)
        spawned[0].child.stdout.emit('data', jsonl.slice(0, cut))
        spawned[0].child.stdout.emit('data', jsonl.slice(cut))
        spawned[0].child.emit('close', 0)
        const r = await p
        const expected = jsonl.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
          .filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text)
        expect(expected.length).toBeGreaterThan(0)
        expect(texts).toEqual(expected)
        const usage = jsonl.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'turn.completed').usage
        expect(r).toMatchObject({ ok: true, usage: { inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens } })
        expect(typeof (r as { costUsd?: number }).costUsd).toBe('number')
      })
    }
  }

  it('no model named: no cost (Codex chose the model), tokens still kept', async () => {
    const { deps, spawned } = fakeDeps()
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    spawned[0].child.stdout.emit('data', fixture('0.155.1', 'exec-json.jsonl'))
    spawned[0].child.emit('close', 0)
    const r = await p
    expect(r.ok && r.usage?.inputTokens).toBeGreaterThan(0)
    expect(r).not.toHaveProperty('costUsd')
  })

  it('stderr is handed on as it arrives (a refused edit exits 0 and shows only there)', async () => {
    const { deps, spawned } = fakeDeps()
    const said: string[] = []
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ onDiagnostic: (t: string) => said.push(t) }))
    spawned[0].child.stderr.emit('data', 'patch rejected: writing is blocked by read-only sandbox\n')
    spawned[0].child.emit('close', 0)
    expect(await p).toEqual({ ok: true })
    expect(said).toEqual(['patch rejected: writing is blocked by read-only sandbox\n'])
  })

  // [host] PR 4 ADR-009 round 1 (L4-4): what stderr hands on is kept in the
  // agent's record and shown, so it is redacted as the failure message is,
  // a whole line (or a whole key block) at a time, so a credential a pipe
  // chunk split is still matched.
  it('stderr is handed on redacted, whole lines at a time: a credential split across chunks, or a key block across lines, never shows; what is left goes at the end', async () => {
    const { deps, spawned } = fakeDeps()
    const said: string[] = []
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ onDiagnostic: (t: string) => said.push(t) }))
    const token = 'sk-' + 'abcdefghij0123456789' + 'KLMNOP'
    const err = spawned[0].child.stderr
    err.emit('data', `TRACE refresh with Bearer ${token.slice(0, 9)}`)
    err.emit('data', `${token.slice(9)}\nnext `)
    const edge = (k: 'BEGIN' | 'END') => `-----${k} ` + 'PRIVATE KEY-----'
    const body = 'MIIEv' + 'Q'.repeat(60)
    err.emit('data', `line\n${edge('BEGIN')}\n${body.slice(0, 30)}`)
    err.emit('data', `${body.slice(30)}\n${edge('END')}\ntail without end`)
    spawned[0].child.emit('close', 0)
    expect(await p).toEqual({ ok: true })
    const all = said.join('')
    expect(all).not.toContain(token.slice(3))
    expect(all).not.toContain(token.slice(9))
    expect(all).not.toContain('MIIEv')
    expect(all).toContain('Bearer [REDACTED]')
    expect(all).toContain('next line\n')
    expect(said.at(-1)).toBe('tail without end')
    // Each piece handed on ends a line, but the last.
    for (const s of said.slice(0, -1)) expect(s.endsWith('\n'), s).toBe(true)
  })

  // [host] PR 4 ADR-009 round 2: a line with no newline is cut at a space once
  // past the redaction window; finding that space is one pass whatever the
  // line holds (no space at all, a Bearer before a long run of spaces), so a
  // large stderr read never holds the main process.
  // PR 4 review (R-ADRFIX-4): asserted as growth, not wall-clock time, so a
  // loaded machine does not fail it: four times the line takes under eight
  // times as long (linear: about four; a search whose time grows with the
  // square: about sixteen).
  it('a long unterminated stderr line is handed on in time linear in its length, whatever it holds, and nothing is lost', async () => {
    // Every line is past WINDOW (64 KiB), so the cut is looked for.
    const shapes: Array<(n: number) => string> = [
      (n) => 'z'.repeat(n),
      (n) => 'z'.repeat(n / 10) + ' Basic' + ' '.repeat(n) + 'end',
      (n) => ('x Bearer' + ' '.repeat(8000)).repeat(n / 8000),
      (n) => ('z'.repeat(990) + ' Bearer  !').repeat(n / 1000),
    ]
    /** How long one read of `line` takes to be handed on (milliseconds). */
    const pushTime = (line: string): number => {
      const { deps, spawned } = fakeDeps()
      void createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input())
      const t0 = performance.now()
      spawned[0].child.stderr.emit('data', line)
      const ms = performance.now() - t0
      spawned[0].child.emit('close', 0)
      return ms
    }
    const FLOOR_MS = 2
    const FACTOR = 8
    for (const make of shapes) {
      const small = make(72_000)
      const big = make(288_000)
      let t1 = Infinity
      for (let i = 0; i < 3; i++) t1 = Math.min(t1, pushTime(small))
      // A ceiling far above any machine's time for 72 KB, only so that a
      // search that is not linear fails here at once rather than run on.
      expect(t1, small.slice(0, 12)).toBeLessThan(1_500)
      // Best of three as for the small size (no need to go on once one is
      // under the bound: the best can only fall).
      let t4 = Infinity
      for (let i = 0; i < 3 && t4 >= FACTOR * Math.max(t1, FLOOR_MS); i++) t4 = Math.min(t4, pushTime(big))
      expect(t4 / Math.max(t1, FLOOR_MS), `${small.slice(0, 12)}: ${t1.toFixed(1)} ms, then ${t4.toFixed(1)} ms`).toBeLessThan(FACTOR)
      const { deps, spawned } = fakeDeps()
      const said: string[] = []
      const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ onDiagnostic: (t: string) => said.push(t) }))
      spawned[0].child.stderr.emit('data', big)
      spawned[0].child.emit('close', 0)
      expect(await p).toEqual({ ok: true })
      expect(said.join('') === big, big.slice(0, 12)).toBe(true)
    }
    // The cut never falls between a Bearer and its token.
    const { deps, spawned } = fakeDeps()
    const said: string[] = []
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ onDiagnostic: (t: string) => said.push(t) }))
    const token = 'abcdefghijklmnop' + '0123456789'
    spawned[0].child.stderr.emit('data', 'z'.repeat(70_000) + ' Bearer ' + token)
    spawned[0].child.emit('close', 0)
    await p
    expect(said.length).toBe(2)
    expect(said.join('')).not.toContain(token)
    expect(said.join('')).toContain('Bearer [REDACTED]')
  })

  // [host] PR 4 ADR-009 round 2: a secret field's name and separator ending
  // one line, its value starting the next: the redactor matches the two
  // together, so the first line is held until the next one arrives.
  it('a secret field whose value starts the next line is redacted with it, however the pipe splits them; the held line still goes at the end', async () => {
    const value = 'hunter2-correct-horse'
    for (const chunks of [
      ['codex: request failed "password":\n', `"${value}"\n`],
      ['retry with api_key =  \n', `${value}\n`],
      ['x\n"access_token": \n', `"${value}", "next": 1\n`],
      ['client_secret=', `\n${value}\n`],
    ]) {
      const { deps, spawned } = fakeDeps()
      const said: string[] = []
      const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ onDiagnostic: (t: string) => said.push(t) }))
      spawned[0].child.stderr.emit('data', chunks[0])
      expect(said.join(''), chunks[0]).not.toMatch(/password|api_key|access_token|client_secret/)
      spawned[0].child.stderr.emit('data', chunks[1])
      spawned[0].child.emit('close', 0)
      await p
      expect(said.join(''), chunks[0]).not.toContain(value)
      expect(said.join(''), chunks[0]).toContain('[REDACTED]')
    }
    const { deps, spawned } = fakeDeps()
    const said: string[] = []
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ onDiagnostic: (t: string) => said.push(t) }))
    spawned[0].child.stderr.emit('data', 'an ordinary line\nthe last line says token:\n')
    expect(said).toEqual(['an ordinary line\n'])
    spawned[0].child.emit('close', 0)
    await p
    expect(said.join('')).toBe('an ordinary line\nthe last line says token:\n')
  })

  // [host] PR 4 ADR-009 residuals: a line past the window, cut by a pipe read
  // right after a credential's lead-in (a secret field and its separator, or
  // a Bearer), keeps the lead-in for the next read, so the redactor sees the
  // two together; the result is what one read of the whole would give.
  it('a line past the window cut by a read right after a secret field or a Bearer keeps the lead-in with what follows: redacted as one read would be', async () => {
    const value = 'QwErTyUiOpAsDfGhJkLzXcVbNm'
    const tok = 'abcdefghijklmnopQRSTUVWX' + '12345'
    for (const [chunks, secret] of [
      [['{"blob":"' + 'x'.repeat(66_000) + '","api_key": ', `"${value}","z":1}\n`], value],
      [['{"blob":"' + 'x'.repeat(66_000) + '","api_key":', `"${value}","z":1}\n`], value],
      [['y'.repeat(66_000) + ' ok password = ', `${value} next\n`], value],
      [['x'.repeat(66_000) + ',Authorization:Bearer ', `${tok} next\n`], tok],
      [['x'.repeat(66_000) + ',Authorization:Bearer ' + tok.slice(0, 10), `${tok.slice(10)} next\n`], tok],
    ] as Array<[string[], string]>) {
      const { deps, spawned } = fakeDeps()
      const said: string[] = []
      const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ onDiagnostic: (t: string) => said.push(t) }))
      for (const c of chunks) spawned[0].child.stderr.emit('data', c)
      spawned[0].child.emit('close', 0)
      await p
      const all = said.join('')
      expect(all, chunks[0].slice(-24)).not.toContain(secret)
      expect(all === redactFailure(chunks.join('')), chunks[0].slice(-24)).toBe(true)
    }
  })

  /** What the run hands on from stderr, read in these chunks. */
  const diag = async (chunks: string[]): Promise<string[]> => {
    const { deps, spawned } = fakeDeps()
    const said: string[] = []
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ onDiagnostic: (t: string) => said.push(t) }))
    for (const c of chunks) spawned[0].child.stderr.emit('data', c)
    spawned[0].child.emit('close', 0)
    await p
    return said
  }

  // [host] PR 4 ADR-009 residuals (round 4): a line past the window keeps its
  // last LINE_TAIL for the next read, so a read that ends anywhere inside a
  // credential (the Bearer word, its token, a field or its value) leaves it
  // whole for the redactor.
  it('a line past the window, split by a read at any offset across a credential (the Bearer word, its token, a JSON field and its value), comes out as one read of it would', async () => {
    const tok = 'abcdefghijklmnopQRSTUVWX' + '12345'
    const value = 'QwErTyUiOpAsDfGhJkLzXcVbNm'
    const shapes = [
      { full: 'x'.repeat(66_000) + ',Authorization:Bearer ' + tok + ' next\n', from: ',Authorization:', secret: tok },
      { full: '{"blob":"' + 'x'.repeat(66_000) + '","api_key":"' + value + '","z":1}\n', from: ',"api_key"', secret: value },
    ]
    for (const { full, from, secret } of shapes) {
      const want = redactFailure(full)
      expect(want).not.toContain(secret)
      const start = full.indexOf(from)
      const stop = full.indexOf(secret) + secret.length + 1
      for (let k = start; k <= stop; k++) {
        const said = await diag([full.slice(0, k), full.slice(k)])
        expect(said.join('') === want, `${from} split at ${k - start}`).toBe(true)
      }
    }
  })

  it('a space inside a credential is not taken for the cut: the cut keeps the redaction of the text around it', async () => {
    const line = 'x'.repeat(50_000) + ' "password": "' + 'word '.repeat(10) + 'end"' + 'y'.repeat(30_000)
    const said = await diag([line])
    expect(said.length).toBe(2)
    expect(said.join('')).not.toContain('word word')
    expect(said.join('') === redactFailure(line)).toBe(true)
  })

  it('a bound that falls inside a credential steps back until the cut keeps the redaction', async () => {
    // No whitespace; the line is cut at most LINE_TAIL (20 KiB) before its
    // end, which here is 2500 characters into a 3000-character value.
    const line = 'x'.repeat(50_000) + '"password":"' + 'p'.repeat(3000) + '"' + 'y'.repeat(19_979)
    const said = await diag([line])
    expect(said.length).toBe(2)
    expect(said.join('')).not.toContain('p'.repeat(100))
    expect(said.join('') === redactFailure(line)).toBe(true)
  })

  it('the cut never falls between the two halves of a surrogate pair', async () => {
    const line = String.fromCodePoint(0x1f600).repeat(40_000) + 'y'
    const said = await diag([line])
    expect(said.length).toBe(2)
    expect(said.join('') === line).toBe(true)
    for (const s of said) {
      expect(/[\uD800-\uDBFF]$/.test(s), 'ends in a high surrogate').toBe(false)
      expect(/^[\uDC00-\uDFFF]/.test(s), 'starts with a low surrogate').toBe(false)
    }
  })

  it('any chunking of a mixed stream (whole lines, held fields, long lines with credentials) comes out as one read of it would: nothing lost, repeated or moved', async () => {
    const tok = 'abcdefghijklmnopQRSTUVWX' + '12345'
    const value = 'QwErTyUiOpAsDfGhJkLzXcVbNm'
    const corpus = ['warning: a', 'the token:', '  next-value-here', 'ok "password" :', '"pw-on-next"', 'plain line', 'x'.repeat(3000), 'secret=', 'later',
      'x'.repeat(70_000) + ',Authorization:Bearer ' + tok + ' and {"api_key":"' + value + '"}',
      '"password": "my long pass phrase" ' + 'y'.repeat(70_000), 'done'].join('\n') + '\n'
    const want = redactFailure(corpus)
    expect(want).not.toContain(tok)
    let seed = 11
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
    // Reads of 1 to 40 characters a few times, of up to 6000 the rest.
    for (let k = 0; k < 40; k++) {
      const parts: string[] = []
      for (let i = 0; i < corpus.length;) { const n = 1 + (rnd() % (k < 3 ? 40 : 6000)); parts.push(corpus.slice(i, i + n)); i += n }
      expect((await diag(parts)).join('') === want, `chunking ${k}`).toBe(true)
    }
  })

  // [host] PR 4 ADR-009 round 1 (L4-4): the CLI-operation allowlist drops
  // RUST_LOG (verbose logs can print secrets); the agent run drops it too.
  it('RUST_LOG never reaches the run: any spelling on Windows, the exact name elsewhere', async () => {
    const win = fakeDeps()
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => win.deps }).run(input({ env: { ...ENV, RUST_LOG: 'trace', rust_log: 'debug', Rust_Log: 'info', RUST_BACKTRACE: '1' } }))
    const we = win.spawned[0].opts.env as Record<string, string>
    expect(Object.keys(we).filter((k) => k.toUpperCase() === 'RUST_LOG')).toEqual([])
    expect(we.RUST_BACKTRACE).toBe('1')
    expect(we.CODEX_HOME).toBe(ENV.CODEX_HOME)
    win.spawned[0].child.emit('close', 0)
    await p
    const posix = fakeDeps('linux')
    const q = createCodexBackgroundOperations({ platform: 'linux', runDeps: () => posix.deps }).run(input({ executable: '/usr/bin/codex', cwd: '/home/me/proj', env: { PATH: '/usr/bin', CODEX_HOME: '/r', RUST_LOG: 'trace', rust_log: 'x' } }))
    const pe = posix.spawned[0].opts.env as Record<string, string>
    expect(pe.RUST_LOG).toBeUndefined()
    expect(pe.rust_log).toBe('x')
    posix.spawned[0].child.emit('close', 0)
    await q
  })

  // [host] PR 4 ADR-009 round 1 (L4-1): on the npm `.cmd` route cmd.exe starts
  // in the project, and the environment decides where its programs come from:
  // NoDefaultCurrentDirectoryInExePath set, and only absolute PATH entries.
  it('on the npm .cmd route cmd.exe starts in the project with NoDefaultCurrentDirectoryInExePath=1 (one spelling, whatever the launch had) and only absolute PATH entries', async () => {
    const { deps, spawned } = fakeDeps()
    const env = { Path: '.;C:\\Windows;rel\\bin;;D:/tools;"C:\\Program Files\\nodejs"', SystemRoot: 'C:\\Windows', nodefaultcurrentdirectoryinexepath: '0', CODEX_HOME: ENV.CODEX_HOME }
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ executable: 'C:\\npm\\codex.cmd', env }))
    const s = spawned[0]
    expect(s.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(s.opts.cwd).toBe('D:\\work\\proj')
    const e = s.opts.env as Record<string, string>
    expect(Object.entries(e).filter(([k]) => k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH')).toEqual([['NoDefaultCurrentDirectoryInExePath', '1']])
    expect(e.Path).toBe('C:\\Windows;D:/tools;"C:\\Program Files\\nodejs"')
    s.child.emit('close', 0)
    await p
    // POSIX: the same PATH rule.
    const posix = fakeDeps('linux')
    const q = createCodexBackgroundOperations({ platform: 'linux', runDeps: () => posix.deps }).run(input({ executable: '/usr/bin/codex', cwd: '/home/me/proj', env: { PATH: '.:bin:/usr/bin::/opt/x', CODEX_HOME: '/r' } }))
    expect((posix.spawned[0].opts.env as Record<string, string>).PATH).toBe('/usr/bin:/opt/x')
    posix.spawned[0].child.emit('close', 0)
    await q
  })

  it('a callback that throws never breaks the run', async () => {
    const { deps, spawned } = fakeDeps()
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ onText: () => { throw new Error('boom') }, onDiagnostic: () => { throw new Error('boom') } }))
    spawned[0].child.stdout.emit('data', fixture('0.155.1', 'exec-json.jsonl'))
    spawned[0].child.stderr.emit('data', 'warn\n')
    spawned[0].child.emit('close', 0)
    expect((await p).ok).toBe(true)
  })

  it('a non-zero exit fails with the event error, redacted; else the stderr tail', async () => {
    const { deps, spawned } = fakeDeps()
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    spawned[0].child.stdout.emit('data', JSON.stringify({ type: 'turn.failed', error: { message: 'quota for sk-proj-' + 'Q'.repeat(40) } }) + '\n')
    spawned[0].child.emit('close', 1)
    const r = await p
    expect(r).toMatchObject({ ok: false, code: 'failed' })
    expect(r.ok ? '' : r.message).toMatch(/^Codex exited with code 1: quota for /)
    expect(r.ok ? '' : r.message).not.toContain('Q'.repeat(40))
    const two = fakeDeps()
    const q = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => two.deps }).run(input())
    two.spawned[0].child.stderr.emit('data', 'Not inside a trusted directory\n')
    two.spawned[0].child.emit('close', 1)
    expect(await q).toMatchObject({ ok: false, code: 'failed', message: 'Codex exited with code 1: Not inside a trusted directory.' })
  })

  it('a stop takes the whole tree below codex and says cancelled', async () => {
    const { deps, spawned, scopes } = fakeDeps()
    const ac = new AbortController()
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ signal: ac.signal }))
    expect(spawned).toHaveLength(1)
    ac.abort()
    expect(await p).toMatchObject({ ok: false, code: 'cancelled' })
    expect(scopes).toEqual(['tree'])
  })

  // [host] PR 4 review C-2: a Stop in the settle window after codex exited
  // on its own read as cancelled, for a run that had finished.
  it('a Stop that comes after codex has exited on its own (the settle window) keeps the run\'s own result: completed on 0, failed with its reason otherwise', async () => {
    vi.useFakeTimers()
    try {
      const { deps, spawned, scopes } = fakeDeps()
      const ac = new AbortController()
      const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ signal: ac.signal }))
      spawned[0].child.stdout.emit('data', fixture('0.155.1', 'exec-json.jsonl'))
      spawned[0].child.emit('exit', 0)
      ac.abort()
      await vi.advanceTimersByTimeAsync(0)
      const r = await p
      expect(r.ok).toBe(true)
      expect(r).not.toHaveProperty('code')
      // Nothing was killed by pid: the root had exited.
      expect(scopes).toEqual([])
      const two = fakeDeps()
      const ac2 = new AbortController()
      const q = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => two.deps }).run(input({ signal: ac2.signal }))
      two.spawned[0].child.stderr.emit('data', 'Not inside a trusted directory\n')
      two.spawned[0].child.emit('exit', 1)
      ac2.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(await q).toMatchObject({ ok: false, code: 'failed', message: 'Codex exited with code 1: Not inside a trusted directory.' })
    } finally { vi.useRealTimers() }
  })

  // [host] PR 4 review C-5: exit 0 after a failed turn with no reply left no
  // trace. The status still follows the exit code (Claude parity).
  it('exit 0 after a failed turn with no reply: completed, with the reason kept in the output, redacted; a reply, or no error, adds nothing', async () => {
    const { deps, spawned } = fakeDeps()
    const said: string[] = []
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ onDiagnostic: (t: string) => said.push(t) }))
    spawned[0].child.stderr.emit('data', 'warn: retrying')
    spawned[0].child.stdout.emit('data', JSON.stringify({ type: 'turn.failed', error: { message: 'quota for sk-proj-' + 'Q'.repeat(40) } }) + '\n')
    spawned[0].child.emit('close', 0)
    expect(await p).toEqual({ ok: true })
    expect(said).toHaveLength(2)
    expect(said[0]).toBe('warn: retrying')
    expect(said[1]).toMatch(/^\nCodex reported an error and gave no reply: quota for .*\n$/)
    expect(said[1]).not.toContain('Q'.repeat(40))
    const replied = fakeDeps()
    const told: string[] = []
    const q = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => replied.deps }).run(input({ onDiagnostic: (t: string) => told.push(t) }))
    replied.spawned[0].child.stdout.emit('data', JSON.stringify({ type: 'error', message: 'reconnecting' }) + '\n' + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }) + '\n')
    replied.spawned[0].child.emit('close', 0)
    expect(await q).toEqual({ ok: true })
    expect(told).toEqual([])
    const clean = fakeDeps()
    const none: string[] = []
    const c = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => clean.deps }).run(input({ onDiagnostic: (t: string) => none.push(t) }))
    clean.spawned[0].child.emit('close', 0)
    expect(await c).toEqual({ ok: true })
    expect(none).toEqual([])
  })

  it('settles soon after codex exits while something it started holds the pipes', async () => {
    vi.useFakeTimers()
    try {
      const { deps, spawned } = fakeDeps()
      const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input())
      spawned[0].child.stdout.emit('data', fixture('0.155.1', 'exec-json.jsonl'))
      spawned[0].child.emit('exit', 0)
      await vi.advanceTimersByTimeAsync(CODEX_EXEC_EXIT_SETTLE_MS + 10)
      expect((await p).ok).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('a project on a network path is refused on the npm .cmd route, before anything starts; allowed directly', async () => {
    const shim = fakeDeps()
    const r = await createCodexBackgroundOperations({ platform: 'win32', runDeps: () => shim.deps }).run(input({ executable: 'C:\\npm\\codex.cmd', cwd: '\\\\server\\share\\proj' }))
    expect(r).toMatchObject({ ok: false, code: 'not-started' })
    expect(r.ok ? '' : r.message).toMatch(/network path/)
    expect(shim.spawned).toHaveLength(0)
    const direct = fakeDeps()
    const q = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => direct.deps }).run(input({ cwd: '\\\\server\\share\\proj' }))
    expect(direct.spawned[0].opts.cwd).toBe('\\\\server\\share\\proj')
    direct.spawned[0].child.emit('close', 0)
    await q
  })

  it('a project that is not a full path, a refused model or no task starts nothing', async () => {
    for (const over of [{ cwd: 'proj' }, { cwd: '\\proj' }, { cwd: '' }, { cwd: '\\\\?\\C:\\proj' }, { model: 'bad model' }, { effort: 'max&x' }, { prompt: undefined }, { executable: 'codex' }]) {
      const { deps, spawned } = fakeDeps()
      const r = await createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input(over))
      expect(r, JSON.stringify(over)).toMatchObject({ ok: false, code: 'not-started' })
      expect(spawned).toHaveLength(0)
    }
    const posix = fakeDeps('linux')
    const r = await createCodexBackgroundOperations({ platform: 'linux', runDeps: () => posix.deps }).run(input({ executable: '/usr/bin/codex', cwd: 'rel/proj' }))
    expect(r).toMatchObject({ ok: false, code: 'not-started' })
  })
})
