import type { TkConfigDim } from './tk-types'

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

const JUNK_PATTERNS = [
  /[\\/]system32([\\/]|$)/i,
  /[\\/]syswow64([\\/]|$)/i,
  /[\\/]windows([\\/]|$)/i,
  /[\\/]temp([\\/]|$)/i,
  /[\\/]tmp([\\/]|$)/i,
  /hookprobe/i,
]

export function isJunkCwd(cwd: string): boolean {
  if (!cwd) return true
  return JUNK_PATTERNS.some((re) => re.test(cwd))
}

export function findConfigForCwd(cwd: string, configs: TkConfigDim[]): TkConfigDim | null {
  if (!cwd || configs.length === 0) return null
  const c = norm(cwd)
  let best: TkConfigDim | null = null
  let bestLen = -1
  for (const cfg of configs) {
    if (!cfg.workingDirectory) continue
    const w = norm(cfg.workingDirectory)
    if ((c === w || c.startsWith(w + '/')) && w.length > bestLen) {
      best = cfg
      bestLen = w.length
    }
  }
  return best
}
