import type { SessionProvider } from './types'
import { ClaudeProvider } from './claude'

const registry = new Map<'claude' | 'codex', SessionProvider>()

export function registerProvider(provider: SessionProvider): void {
  registry.set(provider.id, provider)
}

export function getProvider(id: 'claude' | 'codex'): SessionProvider {
  const p = registry.get(id)
  if (!p) throw new Error(`SessionProvider "${id}" not registered`)
  return p
}

export function tryGetProvider(id: 'claude' | 'codex'): SessionProvider | null {
  return registry.get(id) ?? null
}

// Auto-register built-in providers on module load
registerProvider(new ClaudeProvider())
