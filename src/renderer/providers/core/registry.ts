// WP1 renderer provider core: the descriptor registry. Only the renderer
// composition root (`../index.ts`) registers descriptors; shared components
// look providers up here by id and never import a concrete descriptor module.
import type { ProviderId } from '../../../shared/providers'
import { PROVIDER_IDS, isProviderId } from '../../../shared/providers'
import type { RendererProviderDescriptor } from './descriptor'

const descriptors = new Map<ProviderId, RendererProviderDescriptor>()

export function registerRendererProvider(d: RendererProviderDescriptor): void {
  if (!isProviderId(d.id)) throw new Error(`registerRendererProvider: unknown provider id "${String(d.id)}"`)
  if (descriptors.has(d.id)) throw new Error(`registerRendererProvider(${d.id}): already registered`)
  if (!d.setupSteps.length) throw new Error(`registerRendererProvider(${d.id}): a descriptor must declare its setup steps`)
  descriptors.set(d.id, d)
}

export function getRendererProvider(id: ProviderId): RendererProviderDescriptor {
  const d = descriptors.get(id)
  if (!d) throw new Error(`RendererProviderDescriptor "${id}" not registered`)
  return d
}

export function tryGetRendererProvider(id: ProviderId): RendererProviderDescriptor | null {
  return descriptors.get(id) ?? null
}

export function listRendererProviders(): readonly RendererProviderDescriptor[] {
  return PROVIDER_IDS.map((id) => descriptors.get(id)).filter((d): d is RendererProviderDescriptor => !!d)
}

/** Test-only. */
export function _resetRendererProviderRegistryForTest(): void {
  descriptors.clear()
}
