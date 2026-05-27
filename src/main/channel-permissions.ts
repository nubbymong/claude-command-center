// Minimal stub -- fleshed out in P7. Lets P5 IPC handlers wire respondPermission now.
// STUB (P7 replaces this) -- returns ok without actually replying to the hook
export function respondPermission(_p: { requestId: string; decision: 'allow' | 'deny' | 'allow-once' }): { ok: boolean } { return { ok: true } }
// STUB (P7 replaces this) -- no-op
export function startPermissionTray(): void { /* implemented in P7 */ }
