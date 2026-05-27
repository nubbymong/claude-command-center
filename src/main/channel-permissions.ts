// Minimal stub -- fleshed out in P7. Lets P5 IPC handlers wire respondPermission now.
export function respondPermission(_p: { requestId: string; decision: 'allow' | 'deny' | 'allow-once' }): { ok: boolean } { return { ok: true } }
export function startPermissionTray(): void { /* implemented in P7 */ }
