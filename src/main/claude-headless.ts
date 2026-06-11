// claude-headless.ts — Reusable headless `claude` process spawner.
// Used by insights-runner and the Sentinel AI analysis runner.
import { spawn } from 'child_process'
import { logInfo, logError } from './debug-logger'
import { withProfileHome } from './pty-manager'

/**
 * Spawn `claude` as a headless child process (shell:true so both claude.exe and
 * claude.cmd are found on PATH).  Returns stdout/stderr and the exit code.
 *
 * @param args        CLI arguments passed to `claude`
 * @param timeoutMs   Kill and resolve with code 1 after this many ms (default 10 min)
 * @param stdinData   Optional data to pipe into stdin
 * @param home        Per-account fake HOME injected via withProfileHome; null = default
 */
export function spawnClaudeHeadless(
  args: string[],
  timeoutMs = 600000,
  stdinData?: string,
  home: string | null = null
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    logInfo(`[claude-headless] Spawning: claude ${args.join(' ')}${stdinData ? ' (with stdin)' : ''}${home ? ' (account home)' : ''}`)

    const proc = spawn('claude', args, {
      shell: true,
      windowsHide: true,
      env: withProfileHome({ ...process.env } as Record<string, string>, home)
    })

    // Pipe prompt via stdin if provided
    if (stdinData && proc.stdin) {
      proc.stdin.write(stdinData)
      proc.stdin.end()
    }

    let stdout = ''
    let stderr = ''
    let resolved = false

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        logError(`[claude-headless] Timed out after ${timeoutMs / 1000}s`)
        proc.kill()
        resolve({ code: 1, stdout, stderr: stderr + '\nTimed out after ' + (timeoutMs / 1000) + 's' })
      }
    }, timeoutMs)

    proc.stdout?.on('data', (data) => { stdout += data.toString() })
    proc.stderr?.on('data', (data) => { stderr += data.toString() })

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        logError('[claude-headless] Spawn error:', err.message)
        resolve({ code: 1, stdout, stderr: stderr + '\n' + err.message })
      }
    })

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        logInfo(`[claude-headless] Process exited with code ${code}`)
        resolve({ code: code ?? 1, stdout, stderr })
      }
    })
  })
}
