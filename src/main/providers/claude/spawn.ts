import * as os from 'os'
import { execSync } from 'child_process'
import { resolveVersionBinary } from '../../legacy-version-manager'
import { logInfo } from '../../debug-logger'
import type { LegacyVersion } from '../../../shared/types'

export function resolveClaudeBinary(legacyVersion?: LegacyVersion): { cmd: string; args: string[] } {
  if (legacyVersion?.enabled && legacyVersion.version) {
    const legacyBin = resolveVersionBinary(legacyVersion.version)
    if (legacyBin) {
      logInfo(`[claude-provider] Using legacy Claude CLI v${legacyVersion.version}: ${legacyBin}`)
      return { cmd: legacyBin, args: [] }
    }
    logInfo(`[claude-provider] Legacy v${legacyVersion.version} binary not found, falling back to system claude`)
  }

  if (os.platform() !== 'win32') return { cmd: 'claude', args: [] }

  for (const bin of ['claude.exe', 'claude.cmd']) {
    try {
      const cmdPath = execSync(`where ${bin}`, { encoding: 'utf-8', timeout: 5000 })
        .trim().split('\n')[0].trim()
      return { cmd: cmdPath, args: [] }
    } catch { /* try next */ }
  }
  return { cmd: 'claude', args: [] }
}
