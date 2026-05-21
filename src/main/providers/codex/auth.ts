import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'
import { resolveCodexBinary } from './spawn'

/**
 * P7.7.7: Quote a single argument for cmd.exe consumption.
 *
 * Node's `child_process.spawn(cmd, args, { shell: true })` on Windows joins
 * args with single spaces and runs them through `cmd.exe /d /s /c`. cmd.exe
 * then re-tokenises that string, so any arg containing whitespace or shell
 * metacharacters gets split mid-arg. Codex CLI takes the first whitespace-
 * separated token after `exec` as a subcommand, which crashes the prompt arg
 * with "unrecognized subcommand 'the'" (and similar) for any multi-word
 * prompt.
 *
 * Wrap the arg in double quotes when it contains anything cmd.exe would
 * tokenise on, and escape embedded double quotes by doubling them per the
 * Windows shell convention.
 */
function quoteForCmdShell(s: string): string {
  if (s.length === 0) return '""'
  if (!/[\s"&|<>^()%!]/.test(s)) return s
  return `"${s.replace(/"/g, '""')}"`
}

export interface CodexAuthStatus {
  installed: boolean
  version: string | null
  authMode: 'chatgpt' | 'api-key' | 'none'
  planType?: string
  accountId?: string
  hasOpenAiApiKeyEnv: boolean
}

export function getCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex')
}

export function parseChatgptPlanFromJwt(idToken: string): { planType?: string; accountId?: string } {
  try {
    const parts = idToken.split('.')
    if (parts.length < 2) return {}
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
    return { planType: payload.chatgpt_plan_type, accountId: payload.account_id }
  } catch {
    return {}
  }
}

export async function readCodexAuthStatus(codexHome?: string): Promise<CodexAuthStatus> {
  const home = codexHome ?? getCodexHome()
  const authPath = join(home, 'auth.json')
  const hasOpenAiApiKeyEnv = !!process.env.OPENAI_API_KEY

  let installed = false
  let version: string | null = null
  try {
    const result = await runCodexProcess(['--version'], 5000)
    if (result.code === 0) {
      const m = /^codex.*?(\d+\.\d+\.\d+)/.exec(result.stdout)
      version = m ? m[1] : null
      installed = true
    }
  } catch { /* not installed */ }

  if (!installed) return { installed: false, version: null, authMode: 'none', hasOpenAiApiKeyEnv }
  if (!existsSync(authPath)) return { installed, version, authMode: 'none', hasOpenAiApiKeyEnv }

  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
    if (auth.auth_mode === 'chatgpt' && auth.tokens?.id_token) {
      const { planType, accountId } = parseChatgptPlanFromJwt(auth.tokens.id_token)
      return { installed, version, authMode: 'chatgpt', planType, accountId, hasOpenAiApiKeyEnv }
    }
    if (auth.auth_mode === 'api-key') {
      return { installed, version, authMode: 'api-key', hasOpenAiApiKeyEnv }
    }
  } catch { /* fall through */ }

  return { installed, version, authMode: 'none', hasOpenAiApiKeyEnv }
}

export function runCodexProcess(
  args: string[],
  timeoutMs: number,
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // On win32, .cmd/.bat shims require shell:true (cmd.exe) to be invoked.
    // On other platforms, spawn without a shell to avoid injection risk.
    const resolved = resolveCodexBinary()
    const cmd = resolved?.cmd ?? 'codex'
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
    // P7.7.7: pre-quote args + the cmd path under shell mode because Node
    // joins them with raw spaces; cmd.exe would otherwise re-tokenise on
    // every whitespace inside a multi-word prompt arg.
    const spawnCmd = useShell ? quoteForCmdShell(cmd) : cmd
    const spawnArgs = useShell ? args.map(quoteForCmdShell) : args
    const proc = spawn(spawnCmd, spawnArgs, { shell: useShell })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    if (stdin != null && proc.stdin.writable) {
      proc.stdin.write(stdin)
      proc.stdin.end()
    }
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
    proc.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout, stderr }) })
  })
}

/** Streaming variant of runCodexProcess: emits each stdout LINE as it arrives,
 *  and resolves when the process exits. Does NOT buffer stdout in memory --
 *  callers (codex-review-mcp-tool) consume lines incrementally to extract
 *  token_count events without holding the full --json stream in RAM. */
export function runCodexStreaming(
  args: string[],
  opts: {
    timeoutMs: number
    onStdoutLine?: (line: string) => void
    cwd?: string
  },
): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const resolved = resolveCodexBinary()
    const cmd = resolved?.cmd ?? 'codex'
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
    // P7.7.7: pre-quote args + the cmd path under shell mode -- see
    // quoteForCmdShell docstring. macOS path is unaffected (useShell=false).
    const spawnCmd = useShell ? quoteForCmdShell(cmd) : cmd
    const spawnArgs = useShell ? args.map(quoteForCmdShell) : args
    // P7.7.8: `codex exec` reads stdin if it's piped and appends the content
    // as a `<stdin>` block to the prompt. Node's default stdio gives the
    // child a piped (open) stdin, so codex hangs forever waiting for EOF.
    // 'ignore' attaches stdin to /dev/null (or NUL on Windows), guaranteeing
    // immediate EOF -- codex falls back to argv prompt and proceeds.
    const proc = spawn(spawnCmd, spawnArgs, {
      shell: useShell,
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    let stdoutBuffer = ''
    let timedOut = false

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()
      let nl = stdoutBuffer.indexOf('\n')
      while (nl !== -1) {
        const line = stdoutBuffer.slice(0, nl)
        stdoutBuffer = stdoutBuffer.slice(nl + 1)
        if (line.length > 0 && opts.onStdoutLine) {
          try { opts.onStdoutLine(line) } catch { /* never let consumer errors kill the spawn */ }
        }
        nl = stdoutBuffer.indexOf('\n')
      }
    })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, opts.timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timer)
      // Flush any unterminated final line.
      if (stdoutBuffer.length > 0 && opts.onStdoutLine) {
        try { opts.onStdoutLine(stdoutBuffer) } catch { /* ignore */ }
      }
      resolve({ code: code ?? -1, stderr, timedOut })
    })
    proc.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stderr, timedOut })
    })
  })
}

export async function codexLoginWithApiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  const result = await runCodexProcess(['login', '--with-api-key'], 30_000, apiKey + '\n')
  if (result.code === 0) return { ok: true }
  return { ok: false, error: redactApiKey(result.stderr || result.stdout || 'Login failed', apiKey) }
}

function redactApiKey(text: string, key: string): string {
  if (!key) return text
  return text.split(key).join('***REDACTED***')
}

export async function codexLoginChatgpt(): Promise<{ ok: boolean; browserUrl?: string; error?: string }> {
  // codex login (no flags) prints a URL to stdout, opens the browser, and waits
  // for OAuth to land. The current implementation reads stdout only after the
  // subprocess exits, which means browserUrl is returned synchronously with the
  // final auth.json write -- not at the moment Codex prints the URL. Streaming
  // stdout to surface the URL early is a v1.5.x polish item.
  const result = await runCodexProcess(['login'], 5 * 60 * 1000)
  if (result.code === 0) {
    const m = /(https?:\/\/[^\s]+)/.exec(result.stdout)
    return { ok: true, browserUrl: m ? m[1] : undefined }
  }
  return { ok: false, error: result.stderr.trim() || result.stdout.trim() || 'Login failed' }
}

export async function codexLoginDeviceAuth(): Promise<{ ok: boolean; deviceCode?: string; error?: string }> {
  // codex login --device-auth prints a device code to stdout for the user to enter on a separate device.
  const result = await runCodexProcess(['login', '--device-auth'], 5 * 60 * 1000)
  if (result.code === 0) {
    // Heuristic: pull out something that looks like a code (alphanumeric, 6-12 chars)
    const m = /\b([A-Z0-9]{6,12})\b/.exec(result.stdout)
    return { ok: true, deviceCode: m ? m[1] : undefined }
  }
  return { ok: false, error: result.stderr.trim() || result.stdout.trim() || 'Device login failed' }
}

export async function codexLogout(): Promise<{ ok: boolean }> {
  const result = await runCodexProcess(['logout'], 10_000)
  return { ok: result.code === 0 }
}

export async function codexTestConnection(): Promise<{ ok: boolean; message: string }> {
  const result = await runCodexProcess(['login', 'status'], 10_000)
  return {
    ok: result.code === 0,
    message: (result.stdout.trim() || result.stderr.trim() || 'No output'),
  }
}
