import { ipcMain, app } from 'electron'
import { resolveClaudeForPty } from '../pty-manager'
import { spawnClaudeHeadless } from '../claude-headless'
import { parseClaudeVersion } from '../sentinel/sentinel-version'
import { ensureHelpWorkspace } from '../help-workspace'
import { getResourcesDirectory } from './setup-handlers'

export function registerCliHandlers(): void {
  ipcMain.handle('cli:check', async () => {
    const { execFile } = require('child_process')
    const { promisify } = require('util')
    const execFileAsync = promisify(execFile)
    try {
      if (process.platform === 'win32') {
        const opts = { encoding: 'utf-8' as const, timeout: 5000, windowsHide: true }
        try {
          await execFileAsync('where', ['claude.exe'], opts)
          return true
        } catch { /* try .cmd */ }
        await execFileAsync('where', ['claude.cmd'], opts)
        return true
      } else {
        const shell = process.env.SHELL || '/bin/zsh'
        await execFileAsync(shell, ['-l', '-c', 'which claude'], { encoding: 'utf-8', timeout: 5000 })
        return true
      }
    } catch {
      return false
    }
  })

  ipcMain.handle('cli:path', async () => {
    try {
      return resolveClaudeForPty()?.cmd ?? null
    } catch {
      return null
    }
  })

  ipcMain.handle('cli:version', async () => {
    try {
      const res = await spawnClaudeHeadless(['--version'], 10000)
      return parseClaudeVersion(res.stdout) ?? parseClaudeVersion(res.stderr) ?? null
    } catch {
      return null
    }
  })

  ipcMain.handle('help:workspace', async () => {
    try {
      return ensureHelpWorkspace(getResourcesDirectory(), { appVersion: app.getVersion() })
    } catch {
      return null
    }
  })
}
