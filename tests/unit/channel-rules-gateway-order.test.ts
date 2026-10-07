// P3.16a (N6): the rules engine hears the Hooks gateway whichever of the two
// starts first. src/main/index.ts starts the rules engine (startRulesEngine)
// before it sets the gateway (setGateway), and a gateway set later replaces the
// one before it. The engine binds through onGateway (src/main/hooks/index.ts),
// which hands it the gateway when one is set and each gateway set after it, so
// the built-in Attention Pulse sees the turn (UserPromptSubmit to Stop) and the
// Notification idle_prompt of a Claude session, and the turn under a Codex
// session's idle mark. This file runs that startup order against the real hooks
// module; only the config read, the channel bus and the rules store's save are
// stand-ins.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookEvent } from '../../src/shared/hook-types'
import type { HooksGatewayLike } from '../../src/main/hooks/index'

const h = vi.hoisted(() => ({ saved: [] as Array<Record<string, any>> }))
vi.mock('../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../src/main/channel-bus', () => ({ send: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../src/main/channel-rules-store', async (importActual) => {
  const actual = await importActual<typeof import('../../src/main/channel-rules-store')>()
  return {
    ...actual,
    // The built-in rules as shipped (the Attention Pulse among them), unchanged.
    loadRules: () => actual.BUILTIN_RULES.map((r) => ({ ...r })),
    saveRule: (r: Record<string, any>) => { h.saved.push(r) },
  }
})

const { setGateway, onGateway } = await import('../../src/main/hooks/index')
const { emitInternal } = await import('../../src/main/internal-events')
const { startRulesEngine } = await import('../../src/main/channel-rules')

/** A gateway as the rules engine uses it: subscribe, and the events it delivers. */
function fakeGateway() {
  const subs = new Set<(e: HookEvent) => void>()
  return {
    subscribe(cb: (e: HookEvent) => void): () => void {
      subs.add(cb)
      return () => { subs.delete(cb) }
    },
    emit(sessionId: string, event: string, ts: number, payload: Record<string, unknown> = {}): void {
      for (const cb of [...subs]) cb({ sessionId, event, payload: { hook_event_name: event, ...payload }, ts })
    },
    subscribers(): number { return subs.size },
  }
}
type FakeGateway = ReturnType<typeof fakeGateway>
const asGateway = (g: FakeGateway) => g as unknown as HooksGatewayLike

/** A turn the gateway saw: the prompt at `from` s, its Stop at `to` s. */
const turn = (g: FakeGateway, sid: string, from: number, to: number) => {
  g.emit(sid, 'UserPromptSubmit', from * 1000)
  g.emit(sid, 'Stop', to * 1000)
}
const claudeIdle = (g: FakeGateway, sid: string, ts: number) =>
  g.emit(sid, 'Notification', ts, { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
const codexIdle = (sid: string) => emitInternal('attention:idle-prompt', { sessionId: sid })

// The startup order of src/main/index.ts: the rules engine first, the gateway after it.
startRulesEngine()
const gwA = fakeGateway()
setGateway(asGateway(gwA))

describe('the rules engine started before the Hooks gateway is set, as the app starts them (P3.16a, N6)', () => {
  beforeEach(() => { h.saved = [] })

  it('the engine holds one subscription on the gateway set after it', () => {
    expect(gwA.subscribers()).toBe(1)
  })

  it('a Claude turn of 150 s, then its Notification idle_prompt: the built-in Attention Pulse fires', () => {
    turn(gwA, 'claude-1', 0, 150)
    claudeIdle(gwA, 'claude-1', 210_000)
    expect(h.saved.map((r) => r.id)).toEqual(['attention-pulse'])
    expect(h.saved[0].fireCount).toBe(1)
  })

  it('a Codex turn of 150 s, then its idle mark: the built-in Attention Pulse fires', () => {
    turn(gwA, 'codex-1', 1000, 1150)
    codexIdle('codex-1')
    expect(h.saved.map((r) => r.id)).toEqual(['attention-pulse'])
  })

  it('a turn of 30 s fires for neither', () => {
    turn(gwA, 'claude-2', 0, 30)
    claudeIdle(gwA, 'claude-2', 90_000)
    turn(gwA, 'codex-2', 0, 30)
    codexIdle('codex-2')
    expect(h.saved).toEqual([])
  })

  it('a gateway set later is the one heard, and the one before it is not', () => {
    const gwB = fakeGateway()
    setGateway(asGateway(gwB))
    expect(gwB.subscribers()).toBe(1)
    expect(gwA.subscribers()).toBe(0)

    turn(gwA, 'claude-old', 0, 150)
    claudeIdle(gwA, 'claude-old', 210_000)
    expect(h.saved).toEqual([])

    turn(gwB, 'claude-new', 0, 150)
    claudeIdle(gwB, 'claude-new', 210_000)
    turn(gwB, 'codex-new', 0, 150)
    codexIdle('codex-new')
    expect(h.saved.map((r) => r.id)).toEqual(['attention-pulse', 'attention-pulse'])
  })
})

describe('onGateway: a consumer is handed each gateway as it is set (P3.16a, N6)', () => {
  it('hands a gateway already set at once, then each one set after it, dropping the earlier subscription', () => {
    const one = fakeGateway()
    const two = fakeGateway()
    setGateway(asGateway(one))
    const seen: unknown[] = []
    const unbind = onGateway((gw) => { seen.push(gw); return gw.subscribe(() => {}) })
    expect(seen).toEqual([one])
    expect(one.subscribers()).toBe(2) // the rules engine's and this one's

    setGateway(asGateway(two))
    expect(seen).toEqual([one, two])
    expect(one.subscribers()).toBe(0)
    expect(two.subscribers()).toBe(2)

    unbind()
    expect(two.subscribers()).toBe(1) // the rules engine's alone
    setGateway(asGateway(one))
    expect(seen).toEqual([one, two])
  })

  it('a cleared gateway drops the subscription and hands nothing', () => {
    const one = fakeGateway()
    setGateway(asGateway(one))
    const seen: unknown[] = []
    const unbind = onGateway((gw) => { seen.push(gw); return gw.subscribe(() => {}) })
    // @ts-expect-error the gateway cleared, as before the app sets one
    setGateway(null)
    expect(one.subscribers()).toBe(0)
    expect(seen).toEqual([one])
    unbind()
  })
})

describe('the rules engine binds to the gateway through onGateway (P3.16a, N6)', () => {
  it('src/main/channel-rules.ts reads the gateway through onGateway, never a one-time getGateway', () => {
    const src = readFileSync(join(__dirname, '../../src/main/channel-rules.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(src).toMatch(/\bonGateway\(/)
    expect(src).not.toMatch(/\bgetGateway\b/)
  })
})
