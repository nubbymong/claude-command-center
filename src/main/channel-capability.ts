// src/main/channel-capability.ts  (Tier-1-only stub; P8 replaces the body)
import type { ChannelPayload, ChannelEnvelopeMeta } from '../shared/channel-types'

// v1.5.10 P5: always Tier 1 until P8 wires real per-session capability state.
export function pickTransport(_sessionId: string): 'pty' | 'mcp' { return 'pty' }
export function formatTier2(_p: ChannelPayload, _m: ChannelEnvelopeMeta): string { return '' }
export async function sendTier2(_sessionId: string, _body: string): Promise<{ ok: boolean; reason?: string }> {
  return { ok: false, reason: 'tier-2-not-enabled' }
}

// Stubs for IPC handlers (P5.2). Fleshed out in P8.
export function getCapabilityDiagnostics() { return { descriptor: {}, handshakes: [], sessions: [], protocolRange: '0.0.0-0.0.0' } }
export function forceTier(_sessionId: string, _tier: 'auto' | 'tier-1' | 'tier-2') { return { ok: true } }
