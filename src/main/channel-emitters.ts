// src/main/channel-emitters.ts
// Thin typed wrappers that emit internal events at each send-point. Each
// function is try-wrapped at the call site so a channels emit can never
// break the host operation.
import { emitInternal, type InternalEventMap } from './internal-events'

export const emitPrMerged = (p: InternalEventMap['pr:merged']): void =>
  emitInternal('pr:merged', p)

export const emitCiFailed = (p: InternalEventMap['ci:failed']): void =>
  emitInternal('ci:failed', p)

export const emitCodexReviewComplete = (p: InternalEventMap['codex-review:complete']): void =>
  emitInternal('codex-review:complete', p)

export const emitTokenomicsAnomaly = (p: InternalEventMap['tokenomics:anomaly']): void =>
  emitInternal('tokenomics:anomaly', p)

export const emitMemoryAdded = (p: InternalEventMap['memory:added']): void =>
  emitInternal('memory:added', p)
