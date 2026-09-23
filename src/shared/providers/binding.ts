// WP1.42: a session binding is rejected by SHAPE before any lookup, lease or
// spawn. The canonical relationship (account -> realm/identity) is verified
// against the registry by the launch handoff; this pure check catches a
// mismatched or user-controlled id first.
import { isOpaqueId, isProviderId } from './ids'
import type { SessionBinding } from './model'

export interface BindingShapeResult {
  ok: boolean
  problems: string[]
}

export function validateSessionBindingShape(value: unknown): BindingShapeResult {
  const problems: string[] = []
  if (!value || typeof value !== 'object') return { ok: false, problems: ['binding is not an object'] }
  const b = value as Partial<SessionBinding>
  if (!isProviderId(b.providerId)) problems.push('providerId is not a known provider')
  if (!isOpaqueId(b.providerAccountId, 'account')) problems.push('providerAccountId is not an account id')
  if (!isOpaqueId(b.authRealmId, 'realm')) problems.push('authRealmId is not a realm id')
  if (!isOpaqueId(b.identityId, 'identity')) problems.push('identityId is not an identity id')
  for (const k of Object.keys(b)) if (!['providerId', 'providerAccountId', 'authRealmId', 'identityId'].includes(k)) problems.push(`unexpected field ${k}`)
  return { ok: problems.length === 0, problems }
}
