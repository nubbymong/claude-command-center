import type { SessionProvider } from './types'

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
