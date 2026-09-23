// WP1 main composition root (design 7.2): the ONLY main-process module that
// imports and registers the concrete provider packages. Adding a provider is
// one import and one entry in PACKAGE_FACTORIES below, never an edit to
// Claude or Codex code. Compile-time registration is deliberate for 2.1.1;
// no dynamic plugin loading.
import type { ProviderId } from '../../shared/providers'
import { PROVIDER_IDS } from '../../shared/providers'
import type { ProviderPackageFactory } from './core'
import { registerProviderPackage, listProviderPackages, tryGetProviderPackage } from './core'
import { createClaudePackage } from './claude'
import { createCodexPackage } from './codex'

/** Keyed by `ProviderId`, so a provider added to the union but not composed
 *  here is a compile error rather than one that silently never registers. */
const PACKAGE_FACTORIES: Readonly<Record<ProviderId, ProviderPackageFactory>> = {
  claude: createClaudePackage,
  codex: createCodexPackage,
}

/** Idempotent against the registry itself (no separate flag that could desync
 *  from a test reset): boot calls it once; a second call is a no-op. Driven
 *  by PROVIDER_IDS rather than a hand-written pair, so it cannot skip a
 *  provider because two others happen to be registered already. */
export function composeProviders(): void {
  for (const id of PROVIDER_IDS) if (!tryGetProviderPackage(id)) registerProviderPackage(PACKAGE_FACTORIES[id]())
}

export function composedProviderIds(): readonly string[] {
  return listProviderPackages().map((p) => p.id)
}
