import { randomId } from '../../shared/id'

/** Renderer-side opaque id. Thin alias over the shared generator so the ~20
 *  existing call sites keep their import; see src/shared/id.ts for why this is
 *  not Math.random (#151). */
export function generateId(): string {
  return randomId()
}
