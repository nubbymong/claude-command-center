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
