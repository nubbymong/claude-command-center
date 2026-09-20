// WP1 renderer composition root (design 7.2): the ONLY renderer module that
// imports and registers the concrete renderer provider packages. Shared
// components look descriptors up through `./core`. The renderer entry
// imports `./compose-at-load` above `App` so composition precedes every
// module-level side effect in App's import graph.
import type { ProviderId } from '../../shared/providers'
import { PROVIDER_IDS } from '../../shared/providers'
import type { RendererProviderDescriptor } from './core'
import { registerRendererProvider, listRendererProviders, tryGetRendererProvider } from './core'
import { claudeDescriptor } from './claude'
import { codexDescriptor } from './codex'

/** Keyed by `ProviderId` for the same reason as the main root: a provider
 *  that is never composed would otherwise be invisible rather than a build
 *  failure. */
const DESCRIPTORS: Readonly<Record<ProviderId, RendererProviderDescriptor>> = {
  claude: claudeDescriptor,
  codex: codexDescriptor,
}

/** Idempotent against the registry itself; safe to call more than once. */
export function composeRendererProviders(): void {
  for (const id of PROVIDER_IDS) if (!tryGetRendererProvider(id)) registerRendererProvider(DESCRIPTORS[id])
}

export function composedRendererProviderIds(): readonly string[] {
  return listRendererProviders().map((d) => d.id)
}
