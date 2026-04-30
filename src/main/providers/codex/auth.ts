import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'

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
    // TODO P2.8: Windows resolves codex.cmd via PATHEXT but spawn() with shell:false won't run .cmd shims.
    //            P2.8's resolveCodexBinary uses `where codex.{exe,cmd}` to find the absolute path.
    //            For now, runCodexProcess relies on a real `codex.exe` or POSIX `codex` on PATH.
    const proc = spawn('codex', args, { shell: false })
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
  // codex login (no flags) prints a URL to stdout, opens the browser, and waits for OAuth to land.
  // We capture the URL early then wait up to 5 minutes for the process to exit (browser auth completes).
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
