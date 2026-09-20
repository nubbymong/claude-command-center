// WP1 renderer provider core: public entry point. Provider-neutral only.
export type {
  RendererProviderDescriptor, SetupStepDescriptor, SetupStepKind, AuthMethodDescriptor, RendererAuthMethod,
  ProviderCopy, ProviderActionContext, ProviderActionKind, ProviderActionRequest,
} from './descriptor'
export { defaultProviderActions } from './descriptor'
export {
  registerRendererProvider, getRendererProvider, tryGetRendererProvider, listRendererProviders,
  _resetRendererProviderRegistryForTest,
} from './registry'
