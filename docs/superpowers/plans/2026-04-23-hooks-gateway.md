# HTTP Hooks Gateway — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the MVP of the HTTP Hooks Gateway: a localhost HTTP server in the Electron main process that receives Claude Code hook events, stores them in per-session ring buffers, streams them to the renderer, and surfaces them as a Live Activity footer in the GitHub sidebar. Gated behind a Settings master toggle.

**Architecture:** `node:http` server bound to `127.0.0.1:19334` (retries on conflict). Session-scoped UUID secrets validated via `X-CCC-Hook-Token` header. Events flow: Claude Code → POST → loopback check → token check → parse → redact → ring buffer (main-side, 200 events/session) → IPC `hooks:event` (single channel, sid in payload) → Zustand `hooksStore` → `<LiveActivityFooter />`. Per-session settings file (`~/.claude/settings-<sid>.json`) gets a `hooks` block injected on session spawn and rewritten clean on close.

**Tech Stack:** TypeScript · Node 20 `http` module · Electron 33 · React 18 · Zustand 5 · Tailwind v4 (Catppuccin Mocha) · Vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-04-22-http-hooks-gateway-design.md` — authoritative for contracts, threat model, and failure mitigations. Re-read each section's relevant slice before starting the matching task.

**Scope callout:** MVP injects 5 of 9 hook kinds (`PreToolUse`, `PostToolUse`, `Notification`, `SessionStart`, `Stop`). The `HookEventKind` type declares all 9 so the parser is forward-compatible. MVP response shape is `{}` empty JSON object (not empty body) — do NOT change this to empty body or a `{ decision: ... }` shape; future auto-approve PRs extend it additively.

---

## File structure

### New files

| Path | Responsibility |
|------|----------------|
| `src/shared/hook-types.ts` | `HookEventKind` union, `HookEvent` interface, shared across main + renderer |
| `src/main/hooks/hooks-types.ts` | Main-side-only types (`SessionSecret`, `RingBufferEntry`, `GatewayStatus`) |
| `src/main/hooks/hook-payload-redactor.ts` | Redactor for hook payloads (wider regex vocabulary than GitHub token redactor) |
| `src/main/hooks/hooks-gateway.ts` | HTTP server, ring buffers, secret map, IPC emit — the core |
| `src/main/hooks/session-hooks-writer.ts` | Inject/remove the `hooks` block in per-session settings files |
| `src/main/hooks/boot-cleanup.ts` | Scan `~/.claude/settings-*.json` for stale hook entries from prior runs |
| `src/main/ipc/hooks-handlers.ts` | IPC handlers for toggle, get-buffer |
| `src/renderer/stores/hooksStore.ts` | Zustand store — receives IPC, keeps per-session event refs |
| `src/renderer/components/github/sections/LiveActivityFooter.tsx` | Collapsed footer + expanded event list UI |
| `tests/unit/hooks/hooks-gateway.test.ts` | Gateway unit tests |
| `tests/unit/hooks/session-hooks-writer.test.ts` | Writer idempotency + cleanup tests |
| `tests/unit/hooks/hook-payload-redactor.test.ts` | Redactor regex coverage |
| `tests/unit/stores/hooksStore.test.ts` | Store reducer tests |
| `tests/integration/hooks/synthetic.test.ts` | End-to-end with a mock renderer IPC listener |
| `tests/integration/hooks/real-claude.test.ts` | Spawn `claude --print` with real settings file; assert events flow |

### Modified files

| Path | Change |
|------|--------|
| `src/shared/ipc-channels.ts` | Add `HOOKS_TOGGLE`, `HOOKS_GET_BUFFER`, `HOOKS_EVENT`, `HOOKS_SESSION_ENDED`, `HOOKS_DROPPED`, `HOOKS_STATUS` |
| `src/shared/types.ts` (or wherever `AppConfig` lives) | Add `hooksEnabled: boolean`, `hooksPort?: number` |
| `src/main/config-manager.ts` | Default `hooksEnabled: true`, `hooksPort: 19334` |
| `src/main/index.ts` | Instantiate `HooksGateway` on app ready; stop on will-quit |
| `src/main/pty-manager.ts` | Call `sessionHooksWriter.inject` after settings-file write; call `.remove` on session close |
| `src/main/preload.ts` (or equivalent preload bridge) | Expose `window.electronAPI.hooks.*` |
| `src/renderer/components/github/GitHubPanel.tsx` | Render `<LiveActivityFooter />` pinned to bottom |
| `src/renderer/components/SettingsPage.tsx` | Master toggle + two sub-toggles + port change input |

---

## Task sequence and dependencies

Tasks are grouped; within a group tasks depend on the previous one. Groups:

- **Group A (types + config)** — tasks 1–4. No runtime code; can be reviewed fast.
- **Group B (main-side gateway)** — tasks 5–10. Server works end-to-end with mocked IPC.
- **Group C (main-side integration)** — tasks 11–14. Wires pty-manager + boot cleanup.
- **Group D (renderer)** — tasks 15–19. Depends on preload from C.
- **Group E (integration tests)** — tasks 20–21. Depends on the full pipeline.
- **Group F (manual smoke + PR)** — task 22.

Commit after every task unless noted. Run `npm run typecheck` + `npx vitest run` before every commit; both must be green.

---

## Task 0: Branch + scaffolding

**Files:** none (git only)

- [ ] **Step 1: Create branch from `fix/first-launch-modal-queue` tip**

```bash
git checkout fix/first-launch-modal-queue
git pull --ff-only
git checkout -b feat/hooks-gateway
mkdir -p src/main/hooks src/renderer/stores tests/unit/hooks tests/integration/hooks
```

- [ ] **Step 2: Sanity-check baseline**

```bash
npm run typecheck
npx vitest run
```

Both must pass before adding new code. Resolve any baseline failures first (they're not this PR's problem but will mask your regressions).

- [ ] **Step 3: No commit yet** — nothing to commit.

---

## Task 1: Shared hook types

**Files:**
- Create: `src/shared/hook-types.ts`

- [ ] **Step 1: Write the file**

```ts
// src/shared/hook-types.ts
// Shared types for the HTTP Hooks Gateway. Imported by both main and
// renderer — keep this file free of Node- or DOM-specific imports.

export type HookEventKind =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'SessionStart'
  | 'Stop'
  | 'PreCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'StopFailure'

export interface HookEvent {
  sessionId: string
  event: HookEventKind
  toolName?: string
  summary?: string
  payload: Record<string, unknown>
  ts: number
}

export interface HooksGatewayStatus {
  enabled: boolean
  listening: boolean
  port: number | null
  error?: string
}

export interface HooksToggleRequest {
  enabled: boolean
}

export interface HooksGetBufferRequest {
  sessionId: string
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS (file only declares types).

- [ ] **Step 3: Commit**

```bash
git add src/shared/hook-types.ts
git commit -m "feat(hooks): add shared HookEvent types"
```

---

## Task 2: Main-side types

**Files:**
- Create: `src/main/hooks/hooks-types.ts`

- [ ] **Step 1: Write the file**

```ts
// src/main/hooks/hooks-types.ts
// Main-process-only types for the hooks gateway. Not exported to the
// renderer — only HookEvent crosses the IPC boundary.

import type { HookEvent } from '../../shared/hook-types'

export interface SessionSecretRecord {
  sessionId: string
  secret: string
  createdAt: number
}

export interface RingBufferEntry extends HookEvent {
  // Identical shape for now. Kept as a distinct type so a future
  // server-side-only field (e.g. raw size before redaction) can be added
  // without breaking the shared HookEvent contract.
}

export const RING_BUFFER_CAP = 200
export const DEFAULT_HOOKS_PORT = 19334
export const PORT_RETRY_COUNT = 5
export const PORT_RETRY_OFFSET_MAX = 100
export const REQUEST_BUDGET_MS = 200
```

- [ ] **Step 2: Commit**

```bash
git add src/main/hooks/hooks-types.ts
git commit -m "feat(hooks): add main-side hook types + constants"
```

---

## Task 3: Hook payload redactor

**Files:**
- Create: `src/main/hooks/hook-payload-redactor.ts`
- Create: `tests/unit/hooks/hook-payload-redactor.test.ts`

Spec §Schemas calls out specific vocabularies. Keep this file narrow: regex list + `redact()` that walks an unknown-shaped object. **Never redact at the JSON-string level** — `JSON.stringify`→regex→`JSON.parse` risks corrupting binary/base64 fields. Walk the object and replace in leaf strings.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/hooks/hook-payload-redactor.test.ts
import { describe, it, expect } from 'vitest'
import { redactHookPayload } from '../../../src/main/hooks/hook-payload-redactor'

describe('redactHookPayload', () => {
  it('redacts Anthropic-style sk- tokens', () => {
    const out = redactHookPayload({ msg: 'key=sk-abc1234567890abcdef1234567890abcdef12345' })
    expect(out.msg).toContain('[REDACTED]')
    expect(out.msg).not.toContain('sk-abc')
  })

  it('redacts Slack xoxb tokens', () => {
    const out = redactHookPayload({ env: 'SLACK=xoxb-1234-5678-abcdef' })
    expect(out.env).toContain('[REDACTED]')
  })

  it('redacts AWS access keys', () => {
    const out = redactHookPayload({ s: 'AKIAIOSFODNN7EXAMPLE' })
    expect(out.s).toBe('[REDACTED]')
  })

  it('redacts PEM private key blocks', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nmumble\n-----END OPENSSH PRIVATE KEY-----'
    const out = redactHookPayload({ k: key })
    expect(out.k).toContain('[REDACTED]')
    expect(out.k).not.toContain('mumble')
  })

  it('redacts password/token assignments', () => {
    const out = redactHookPayload({ line: 'API_KEY=hunter2-real-value-here' })
    expect(out.line).toContain('[REDACTED]')
  })

  it('walks nested objects and arrays', () => {
    const out = redactHookPayload({
      tools: [{ args: { apiKey: 'sk-ant-abcdefghij0123456789abcdefghij0123456789' } }],
    })
    const leaf = (out as any).tools[0].args.apiKey as string
    expect(leaf).toContain('[REDACTED]')
  })

  it('does not throw on circular references', () => {
    const a: any = { name: 'root' }
    a.self = a
    expect(() => redactHookPayload(a)).not.toThrow()
  })

  it('preserves non-string leaves', () => {
    const out = redactHookPayload({ n: 42, b: true, nil: null, arr: [1, 2] })
    expect(out).toEqual({ n: 42, b: true, nil: null, arr: [1, 2] })
  })
})
```

```bash
npx vitest run tests/unit/hooks/hook-payload-redactor.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 2: Implement**

```ts
// src/main/hooks/hook-payload-redactor.ts
// Redacts secrets from Claude Code hook payloads before the payload is
// stored in the ring buffer or emitted over IPC.
//
// Raw hook payloads can contain file contents, env values, diffs, API
// keys, and private keys. DevTools on the renderer can inspect IPC
// messages, so this redaction is non-negotiable per the design spec
// (§Schemas, §Security).

// All quantifiers are bounded ({n,M}) to defeat ReDoS on adversarial
// inputs. 512 chars is well over any legitimate token length.
const PATTERNS: Array<[RegExp, string]> = [
  // Anthropic / OpenAI / many providers use `sk-` prefixed keys
  [/sk-[A-Za-z0-9_\-]{32,512}/g, '[REDACTED]'],
  // Slack bot/user tokens
  [/xox[bpsar]-[A-Za-z0-9-]{10,256}/g, '[REDACTED]'],
  // AWS access key IDs (fixed length)
  [/AKIA[A-Z0-9]{16}/g, '[REDACTED]'],
  // GitHub PATs + OAuth tokens (covered elsewhere for logs, re-included here
  // so a hook payload containing one doesn't leak via IPC)
  [/gh[pousr]_[A-Za-z0-9]{30,256}/g, '[REDACTED]'],
  // PEM-wrapped private keys — cap the body at 16KB. Genuine keys are 1–4KB.
  [/-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP) PRIVATE KEY-----[\s\S]{0,16384}?-----END (?:OPENSSH|RSA|EC|DSA|PGP) PRIVATE KEY-----/g, '[REDACTED]'],
  // password/secret/token/api_key assignments — catch `FOO_TOKEN=abc123`
  // style. Keep the key visible; replace the value only. {3,512} bound
  // catches short real values while preventing unbounded backtracking.
  [/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)(["']?)[^\s"'&]{3,512}\2/gi, '$1[REDACTED]'],
]

function redactString(s: string): string {
  let out = s
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement)
  return out
}

export function redactHookPayload<T>(payload: T): T {
  const seen = new WeakSet<object>()

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactString(value)
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value as object)) return value
    seen.add(value as object)
    if (Array.isArray(value)) return value.map(walk)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v)
    }
    return out
  }

  return walk(payload) as T
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run tests/unit/hooks/hook-payload-redactor.test.ts
```

Expected: all 8 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/hooks/hook-payload-redactor.ts tests/unit/hooks/hook-payload-redactor.test.ts
git commit -m "feat(hooks): redact secrets from hook payloads"
```

---

## Task 4: IPC channel constants + preload bridge

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/main/preload.ts` (or wherever `window.electronAPI` is built — grep first)

- [ ] **Step 1: Add channels to the `IPC` object**

Append to `src/shared/ipc-channels.ts` just before the closing `} as const`:

```ts
  // Hooks gateway
  HOOKS_TOGGLE: 'hooks:toggle',
  HOOKS_GET_BUFFER: 'hooks:getBuffer',
  HOOKS_GET_STATUS: 'hooks:getStatus',
  HOOKS_EVENT: 'hooks:event',               // main → renderer broadcast
  HOOKS_SESSION_ENDED: 'hooks:sessionEnded', // main → renderer broadcast
  HOOKS_DROPPED: 'hooks:dropped',            // main → renderer broadcast, one-shot per session
  HOOKS_STATUS: 'hooks:status',              // main → renderer broadcast (enable/disable/error)
```

- [ ] **Step 2: Add bridge surface in preload**

Find the current preload (`grep -rn "contextBridge.exposeInMainWorld" src/`). Add under `electronAPI`:

```ts
hooks: {
  toggle: (enabled: boolean) =>
    ipcRenderer.invoke(IPC.HOOKS_TOGGLE, { enabled }),
  getBuffer: (sessionId: string) =>
    ipcRenderer.invoke(IPC.HOOKS_GET_BUFFER, { sessionId }),
  getStatus: () => ipcRenderer.invoke(IPC.HOOKS_GET_STATUS),
  onEvent: (cb: (e: HookEvent) => void) => {
    const handler = (_: unknown, e: HookEvent) => cb(e)
    ipcRenderer.on(IPC.HOOKS_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC.HOOKS_EVENT, handler)
  },
  onSessionEnded: (cb: (sid: string) => void) => {
    const handler = (_: unknown, sid: string) => cb(sid)
    ipcRenderer.on(IPC.HOOKS_SESSION_ENDED, handler)
    return () => ipcRenderer.removeListener(IPC.HOOKS_SESSION_ENDED, handler)
  },
  onDropped: (cb: (p: { sessionId: string }) => void) => {
    const handler = (_: unknown, p: { sessionId: string }) => cb(p)
    ipcRenderer.on(IPC.HOOKS_DROPPED, handler)
    return () => ipcRenderer.removeListener(IPC.HOOKS_DROPPED, handler)
  },
  onStatus: (cb: (s: HooksGatewayStatus) => void) => {
    const handler = (_: unknown, s: HooksGatewayStatus) => cb(s)
    ipcRenderer.on(IPC.HOOKS_STATUS, handler)
    return () => ipcRenderer.removeListener(IPC.HOOKS_STATUS, handler)
  },
},
```

Also add the type declaration to whichever `d.ts` declares `window.electronAPI`. Match the existing style.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/preload.ts [d.ts file]
git commit -m "feat(hooks): add IPC channels and preload bridge"
```

---

## Task 5: HooksGateway — core server (bind, loopback check, stop)

**Files:**
- Create: `src/main/hooks/hooks-gateway.ts`
- Create: `tests/unit/hooks/hooks-gateway.test.ts`

Write the *shell* of the gateway in this task: server binds on start, closes on stop, rejects non-loopback requests. Token check, parsing, ring buffer come in tasks 6–7.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/hooks/hooks-gateway.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { HooksGateway } from '../../../src/main/hooks/hooks-gateway'

describe('HooksGateway.start/stop', () => {
  let gw: HooksGateway | null = null
  afterEach(async () => { await gw?.stop() })

  it('binds on default port 19334 when free', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 }) // 0 = ephemeral for tests
    const status = await gw.start()
    expect(status.listening).toBe(true)
    expect(status.port).toBeGreaterThan(0)
  })

  it('stops cleanly', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    await gw.stop()
    expect(gw.status().listening).toBe(false)
  })

  it('rejects requests not from 127.0.0.1', async () => {
    // Simulate by passing a mocked Request with a non-loopback remoteAddress
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    const port = gw.status().port!
    // Build a POST via http.request() binding to 127.0.0.1 — spec-compliant
    // path is well-covered; for the NON-loopback path we rely on the unit
    // test of the handler via the public _handleRequestForTest helper.
    const result = await gw._handleRequestForTest({
      remoteAddress: '192.168.1.10',
      url: '/hook/abc',
      headers: {},
      body: '{}',
    })
    expect(result.status).toBe(403)
  })
})
```

```bash
npx vitest run tests/unit/hooks/hooks-gateway.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 2: Implement the core**

```ts
// src/main/hooks/hooks-gateway.ts
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_HOOKS_PORT,
  PORT_RETRY_COUNT,
  PORT_RETRY_OFFSET_MAX,
} from './hooks-types'
import type { HookEvent, HooksGatewayStatus } from '../../shared/hook-types'

export interface HooksGatewayOptions {
  defaultPort?: number
  emit: (channel: string, payload: unknown) => void
}

interface HandleArgs {
  remoteAddress: string | undefined
  url: string | undefined
  headers: Record<string, string | string[] | undefined>
  body: string
}

interface HandleResult {
  status: number
  body: string
}

export class HooksGateway {
  private server: http.Server | null = null
  private _status: HooksGatewayStatus = { enabled: true, listening: false, port: null }
  private defaultPort: number
  private emit: HooksGatewayOptions['emit']

  // Session secret map — main-side single source of truth.
  private secrets = new Map<string, string>()

  constructor(opts: HooksGatewayOptions) {
    this.defaultPort = opts.defaultPort ?? DEFAULT_HOOKS_PORT
    this.emit = opts.emit
  }

  status(): HooksGatewayStatus {
    return { ...this._status }
  }

  async start(): Promise<HooksGatewayStatus> {
    if (this.server) return this.status()
    const port = await this.bindWithRetry(this.defaultPort)
    if (port === null) {
      this._status = {
        enabled: false,
        listening: false,
        port: null,
        error: `bind-failed after ${PORT_RETRY_COUNT} attempts`,
      }
      return this.status()
    }
    this._status = { enabled: true, listening: true, port }
    return this.status()
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const s = this.server
    this.server = null
    await new Promise<void>((resolve) => s.close(() => resolve()))
    this._status = { ...this._status, listening: false, port: null }
    // Clear ALL per-session state so a subsequent start() (e.g. via the
    // port-change restart in Task 17) doesn't carry stale buffers/latches
    // from the previous run. secrets.clear() on its own would leak them.
    this.secrets.clear()
    this.buffers.clear()
    this.overflowLatched.clear()
  }

  registerSession(sessionId: string): string {
    const secret = randomUUID()
    this.secrets.set(sessionId, secret)
    return secret
  }

  unregisterSession(sessionId: string): void {
    this.secrets.delete(sessionId)
  }

  private async bindWithRetry(startPort: number): Promise<number | null> {
    for (let i = 0; i < PORT_RETRY_COUNT; i++) {
      const candidate =
        i === 0
          ? startPort
          : startPort + Math.floor(Math.random() * PORT_RETRY_OFFSET_MAX) + 1
      try {
        const port = await this.bindOnce(candidate)
        return port
      } catch {
        // try next
      }
    }
    return null
  }

  private bindOnce(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleHttp(req, res).catch(() => {
          try {
            res.statusCode = 500
            res.end('{}')
          } catch { /* socket may be dead */ }
        })
      })
      srv.once('error', (err) => reject(err))
      srv.listen(port, '127.0.0.1', () => {
        const addr = srv.address()
        this.server = srv
        srv.removeAllListeners('error')
        srv.on('error', () => { /* swallowed: ENOTFOUND etc don't crash app */ })
        resolve(typeof addr === 'object' && addr ? addr.port : port)
      })
    })
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks).toString('utf-8')
    const result = await this._handleRequestForTest({
      remoteAddress: req.socket.remoteAddress,
      url: req.url,
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
    })
    res.statusCode = result.status
    res.setHeader('content-type', 'application/json')
    res.end(result.body)
  }

  /**
   * Public for unit tests only. Real HTTP path calls this indirectly.
   * Named with _test suffix so it doesn't look like intended public API.
   */
  async _handleRequestForTest(args: HandleArgs): Promise<HandleResult> {
    // Loopback belt-and-braces. If bind regresses or the test runner
    // gave us a different socket, fail hard.
    if (args.remoteAddress !== '127.0.0.1' && args.remoteAddress !== '::1' && args.remoteAddress !== '::ffff:127.0.0.1') {
      return { status: 403, body: '{}' }
    }
    if (!this._status.enabled) return { status: 503, body: '{}' }

    // Task 6 extends this method with sid + token + parse + emit. For now,
    // any valid-shape loopback POST returns 200 {} so end-to-end smoke works.
    return { status: 200, body: '{}' }
  }
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run tests/unit/hooks/hooks-gateway.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/hooks/hooks-gateway.ts tests/unit/hooks/hooks-gateway.test.ts
git commit -m "feat(hooks): add gateway server shell with loopback check"
```

---

## Task 6: HooksGateway — session secret validation + URL parse

Extend `_handleRequestForTest` to validate `POST /hook/<sid>` with matching `X-CCC-Hook-Token` header, reject mismatches with 404 (NOT 401 — 404 tells an attacker nothing about whether the sid exists).

**Files:**
- Modify: `src/main/hooks/hooks-gateway.ts`
- Modify: `tests/unit/hooks/hooks-gateway.test.ts`

- [ ] **Step 1: Write failing tests**

Append to the existing describe:

```ts
describe('HooksGateway.request validation', () => {
  let gw: HooksGateway | null = null
  afterEach(async () => { await gw?.stop() })

  it('404s on unknown sid', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    const r = await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/no-such-session',
      headers: { 'x-ccc-hook-token': 'anything' },
      body: '{"event":"PreToolUse"}',
    })
    expect(r.status).toBe(404)
  })

  it('404s on wrong token for known sid', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    gw.registerSession('sid-a')
    const r = await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': 'wrong' },
      body: '{"event":"PreToolUse"}',
    })
    expect(r.status).toBe(404)
  })

  it('accepts valid sid+token, responds {}', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    const r = await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: '{"event":"PreToolUse","toolName":"Read"}',
    })
    expect(r.status).toBe(200)
    expect(r.body).toBe('{}')
  })

  it('400s on unparseable body', async () => {
    gw = new HooksGateway({ emit: vi.fn(), defaultPort: 0 })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    const r = await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: 'not-json',
    })
    expect(r.status).toBe(400)
  })
})
```

- [ ] **Step 2: Extend the handler**

Replace the `_handleRequestForTest` body:

```ts
async _handleRequestForTest(args: HandleArgs): Promise<HandleResult> {
  if (!isLoopback(args.remoteAddress)) return { status: 403, body: '{}' }
  if (!this._status.enabled) return { status: 503, body: '{}' }

  const sid = parseSidFromUrl(args.url)
  if (!sid) return { status: 404, body: '{}' }
  const expected = this.secrets.get(sid)
  if (!expected) return { status: 404, body: '{}' }

  const token = headerValue(args.headers, 'x-ccc-hook-token')
  if (token !== expected) return { status: 404, body: '{}' }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(args.body) as Record<string, unknown>
  } catch {
    return { status: 400, body: '{}' }
  }

  // Delegate parse + ring-buffer + emit to Task 7.
  this.ingest(sid, parsed)
  return { status: 200, body: '{}' }
}

// stubbed for this task; real impl in Task 7
private ingest(_sid: string, _parsed: Record<string, unknown>): void {
  /* filled in next task */
}
```

Add helpers at module scope:

```ts
function isLoopback(a: string | undefined): boolean {
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

function parseSidFromUrl(url: string | undefined): string | null {
  if (!url) return null
  // URL arrives as "/hook/<sid>" — possibly with query leftovers if a
  // stale settings file still carried ?t=...
  const m = /^\/hook\/([A-Za-z0-9_\-]+)(?:[/?].*)?$/.exec(url)
  return m ? m[1] : null
}

function headerValue(
  h: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = h[name.toLowerCase()]
  if (Array.isArray(raw)) return raw[0]
  return raw
}
```

- [ ] **Step 3: Run tests** — 4 new tests plus existing 3 should all pass.

```bash
npx vitest run tests/unit/hooks/hooks-gateway.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/main/hooks/hooks-gateway.ts tests/unit/hooks/hooks-gateway.test.ts
git commit -m "feat(hooks): validate sid + token on incoming requests"
```

---

## Task 7: HooksGateway — event normalisation, ring buffer, IPC emit

**Files:**
- Modify: `src/main/hooks/hooks-gateway.ts`
- Modify: `tests/unit/hooks/hooks-gateway.test.ts`

Design constraints from the spec:
- Ring buffer main-side, cap **200 per session**, FIFO drop on overflow
- Emit `hooks:event` **once** per event with the full normalised payload (sid embedded). Do NOT emit separate channels per session.
- First overflow per session also emits `hooks:dropped` ONCE (latch so a session that keeps overflowing doesn't spam the renderer)
- Redactor runs BEFORE buffer push + emit

- [ ] **Step 1: Write failing tests**

```ts
describe('HooksGateway.ingest', () => {
  let gw: HooksGateway | null = null
  let emitted: Array<{ channel: string; payload: unknown }>
  afterEach(async () => { await gw?.stop() })

  it('normalises event and emits hooks:event', async () => {
    emitted = []
    gw = new HooksGateway({
      emit: (c, p) => emitted.push({ channel: c, payload: p }),
      defaultPort: 0,
    })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: JSON.stringify({ event: 'PreToolUse', tool_name: 'Read', payload: { file: 'pkg.json' } }),
    })
    const ev = emitted.find((e) => e.channel === 'hooks:event')
    expect(ev).toBeDefined()
    expect((ev!.payload as any).sessionId).toBe('sid-a')
    expect((ev!.payload as any).event).toBe('PreToolUse')
    expect((ev!.payload as any).toolName).toBe('Read')
  })

  it('redacts secrets in payload before emit', async () => {
    emitted = []
    gw = new HooksGateway({
      emit: (c, p) => emitted.push({ channel: c, payload: p }),
      defaultPort: 0,
    })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: JSON.stringify({
        event: 'PostToolUse',
        tool_name: 'Bash',
        payload: { cmd: 'curl -H "Authorization: sk-ant-abcdefghij0123456789abcdefghij0123456789"' },
      }),
    })
    const ev = emitted.find((e) => e.channel === 'hooks:event')!
    const cmd = (ev.payload as any).payload.cmd as string
    expect(cmd).toContain('[REDACTED]')
    expect(cmd).not.toContain('sk-ant-abc')
  })

  it('caps buffer at 200 per session and emits dropped once', async () => {
    emitted = []
    gw = new HooksGateway({
      emit: (c, p) => emitted.push({ channel: c, payload: p }),
      defaultPort: 0,
    })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    for (let i = 0; i < 250; i++) {
      await gw._handleRequestForTest({
        remoteAddress: '127.0.0.1',
        url: '/hook/sid-a',
        headers: { 'x-ccc-hook-token': secret },
        body: JSON.stringify({ event: 'PreToolUse', tool_name: 'Read', payload: { i } }),
      })
    }
    expect(gw.getBuffer('sid-a').length).toBe(200)
    const dropped = emitted.filter((e) => e.channel === 'hooks:dropped')
    expect(dropped.length).toBe(1)
  })

  it('unknown event kind still emits (forward-compat)', async () => {
    emitted = []
    gw = new HooksGateway({
      emit: (c, p) => emitted.push({ channel: c, payload: p }),
      defaultPort: 0,
    })
    await gw.start()
    const secret = gw.registerSession('sid-a')
    await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/sid-a',
      headers: { 'x-ccc-hook-token': secret },
      body: JSON.stringify({ event: 'SomeFutureEvent', payload: {} }),
    })
    const ev = emitted.find((e) => e.channel === 'hooks:event')
    expect(ev).toBeDefined()
    expect((ev!.payload as any).event).toBe('SomeFutureEvent')
  })
})
```

- [ ] **Step 2: Implement**

Add imports at the top of `hooks-gateway.ts` (if not already present):

```ts
import { RING_BUFFER_CAP, type RingBufferEntry } from './hooks-types'
import { redactHookPayload } from './hook-payload-redactor'
```

Add fields:

```ts
private buffers = new Map<string, RingBufferEntry[]>()
private overflowLatched = new Set<string>()
```

Implement the methods:

```ts
getBuffer(sessionId: string): RingBufferEntry[] {
  return [...(this.buffers.get(sessionId) ?? [])]
}

private ingest(sid: string, parsed: Record<string, unknown>): void {
  const event = typeof parsed.event === 'string' ? parsed.event : 'Unknown'
  const toolName =
    typeof parsed.tool_name === 'string'
      ? parsed.tool_name
      : typeof parsed.toolName === 'string'
        ? (parsed.toolName as string)
        : undefined
  const rawPayload =
    parsed.payload && typeof parsed.payload === 'object'
      ? (parsed.payload as Record<string, unknown>)
      : (parsed as Record<string, unknown>)
  let redacted: Record<string, unknown>
  try {
    redacted = redactHookPayload(rawPayload)
  } catch {
    redacted = { error: 'redaction-failed' }
  }
  const entry: RingBufferEntry = {
    sessionId: sid,
    event: event as HookEvent['event'],
    toolName,
    summary: buildSummary(event, toolName, redacted),
    payload: redacted,
    ts: Date.now(),
  }
  const buf = this.buffers.get(sid) ?? []
  buf.push(entry)
  if (buf.length > RING_BUFFER_CAP) {
    buf.splice(0, buf.length - RING_BUFFER_CAP)
    if (!this.overflowLatched.has(sid)) {
      this.overflowLatched.add(sid)
      this.emit('hooks:dropped', { sessionId: sid })
    }
  }
  this.buffers.set(sid, buf)
  try {
    this.emit('hooks:event', entry)
  } catch {
    // webContents destroyed — drop silently (spec §Error handling)
  }
}

function buildSummary(event: string, toolName: string | undefined, payload: Record<string, unknown>): string {
  if (toolName) {
    const file = typeof payload.file_path === 'string' ? payload.file_path
      : typeof payload.filePath === 'string' ? payload.filePath
      : undefined
    return file ? `${toolName} ${file}` : toolName
  }
  return event
}
```

Also add `unregisterSession` side-effect to clear that session's buffer + latch:

```ts
unregisterSession(sessionId: string): void {
  this.secrets.delete(sessionId)
  this.buffers.delete(sessionId)
  this.overflowLatched.delete(sessionId)
  try {
    this.emit('hooks:sessionEnded', sessionId)
  } catch { /* destroyed window */ }
}
```

(Imports already added at Step 2.)

- [ ] **Step 3: Run tests** — all tests in file pass.

- [ ] **Step 4: Commit**

```bash
git add src/main/hooks/hooks-gateway.ts tests/unit/hooks/hooks-gateway.test.ts
git commit -m "feat(hooks): normalise + redact + ring-buffer + IPC emit"
```

---

## Task 8: Session hooks writer

**Files:**
- Create: `src/main/hooks/session-hooks-writer.ts`
- Create: `tests/unit/hooks/session-hooks-writer.test.ts`

Per spec §Session spawn + §Disable story:
- `inject(sid, settingsPath, port, secret)` — reads the settings file if it exists, **rewrites** only the `hooks` key (other keys preserved), writes back atomically (temp + rename)
- `remove(sid, settingsPath)` — reads file, deletes `hooks` key, writes back. No-op if file missing or key absent.
- Writing uses `{ type: "http", url, headers: { "X-CCC-Hook-Token": "<secret>" } }`. If headers aren't supported by Claude Code's http hook handler, fall back to query (document the fallback in the code comment for future auditor clarity, but default to header).

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { injectHooks, removeHooks, MVP_EVENTS } from '../../../src/main/hooks/session-hooks-writer'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-writer-test-'))
}

describe('session-hooks-writer', () => {
  let dir = ''
  let file = ''
  beforeEach(() => { dir = tmp(); file = path.join(dir, 'settings-sid-a.json') })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('injects hooks for all MVP events', () => {
    injectHooks({ sessionId: 'sid-a', settingsPath: file, port: 19334, secret: 'abc123' })
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
    for (const kind of MVP_EVENTS) {
      expect(Array.isArray(settings.hooks[kind])).toBe(true)
      expect(settings.hooks[kind][0].type).toBe('http')
      expect(settings.hooks[kind][0].url).toBe('http://localhost:19334/hook/sid-a')
      expect(settings.hooks[kind][0].headers['X-CCC-Hook-Token']).toBe('abc123')
    }
  })

  it('preserves other keys in the settings file', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'x' }, model: 'opus' }))
    injectHooks({ sessionId: 'sid-a', settingsPath: file, port: 19334, secret: 'abc' })
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(settings.statusLine.command).toBe('x')
    expect(settings.model).toBe('opus')
    expect(settings.hooks).toBeDefined()
  })

  it('inject is idempotent - repeated calls do not duplicate entries', () => {
    injectHooks({ sessionId: 'sid-a', settingsPath: file, port: 19334, secret: 'abc' })
    injectHooks({ sessionId: 'sid-a', settingsPath: file, port: 19334, secret: 'def' })
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
    // new secret replaces old; only one entry per event
    expect(settings.hooks.PreToolUse.length).toBe(1)
    expect(settings.hooks.PreToolUse[0].headers['X-CCC-Hook-Token']).toBe('def')
  })

  it('remove strips only the hooks key', () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: 'keep' }))
    injectHooks({ sessionId: 'sid-a', settingsPath: file, port: 19334, secret: 'abc' })
    removeHooks({ settingsPath: file })
    const settings = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(settings.statusLine).toBe('keep')
    expect(settings.hooks).toBeUndefined()
  })

  it('remove on missing file is a no-op', () => {
    expect(() => removeHooks({ settingsPath: path.join(dir, 'nope.json') })).not.toThrow()
  })
})
```

- [ ] **Step 2: Implement**

```ts
// src/main/hooks/session-hooks-writer.ts
import fs from 'node:fs'
import path from 'node:path'
import type { HookEventKind } from '../../shared/hook-types'

// Spec §Data flow/Session spawn: MVP injects these five. Adding more is
// a one-line change once the renderer consumes them.
export const MVP_EVENTS: HookEventKind[] = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'SessionStart',
  'Stop',
]

export interface InjectArgs {
  sessionId: string
  settingsPath: string
  port: number
  secret: string
}

export interface RemoveArgs {
  settingsPath: string
}

// NOTE: this writer is NOT diff-aware. It rewrites the entire `hooks` key
// on every inject. If a user hand-edits hooks in the per-session settings
// file, their edits are lost on the next spawn. Per-session settings files
// are ours to manage — document the contract in the release notes.

export function injectHooks(a: InjectArgs): void {
  const settings = readJsonSafe(a.settingsPath)
  const endpoint = `http://localhost:${a.port}/hook/${a.sessionId}`
  const headers = { 'X-CCC-Hook-Token': a.secret }
  const hooks: Record<string, unknown[]> = {}
  for (const kind of MVP_EVENTS) {
    hooks[kind] = [{ type: 'http', url: endpoint, headers }]
  }
  settings.hooks = hooks
  writeJson(a.settingsPath, settings)
}

export function removeHooks(a: RemoveArgs): void {
  if (!fs.existsSync(a.settingsPath)) return
  const settings = readJsonSafe(a.settingsPath)
  if (!('hooks' in settings)) return
  delete settings.hooks
  writeJson(a.settingsPath, settings)
}

function readJsonSafe(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

// NOT atomic on win32. fs.renameSync() fails with EPERM/EEXIST when the
// destination exists and is held open by another process — Claude Code is
// reading this file while we rewrite it. Atomicity isn't critical: Claude
// Code re-reads settings only on /reload, so a partial read during rewrite
// is vanishingly unlikely. Direct writeFileSync is the right tradeoff.
function writeJson(file: string, data: unknown): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}
```

- [ ] **Step 3: Run tests** — all 5 pass.

- [ ] **Step 4: Commit**

```bash
git add src/main/hooks/session-hooks-writer.ts tests/unit/hooks/session-hooks-writer.test.ts
git commit -m "feat(hooks): inject/remove hook config in per-session settings"
```

---

## Task 9: Boot-time cleanup

**Files:**
- Create: `src/main/hooks/boot-cleanup.ts`

Scans `~/.claude/settings-*.json` on boot and removes stale hook entries from sessions that aren't currently active. Called during `HooksGateway.start()` after bind, before any session is registered.

- [ ] **Step 1: Implementation**

```ts
// src/main/hooks/boot-cleanup.ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { removeHooks } from './session-hooks-writer'

// Non-greedy before `.json` so `settings-foo.json.bak` doesn't match.
const SID_FROM_FILENAME = /^settings-([^.]+)\.json$/

export function cleanupStaleHookEntries(activeSessionIds: ReadonlySet<string>): number {
  const dir = path.join(os.homedir(), '.claude')
  if (!fs.existsSync(dir)) return 0
  const files = fs.readdirSync(dir)
  let cleaned = 0
  for (const name of files) {
    const m = SID_FROM_FILENAME.exec(name)
    if (!m) continue
    const sid = m[1]
    if (activeSessionIds.has(sid)) continue
    const full = path.join(dir, name)
    try {
      const raw = fs.readFileSync(full, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (!parsed.hooks) continue
      const s = JSON.stringify(parsed.hooks)
      if (!s.includes('/hook/')) continue
      removeHooks({ settingsPath: full })
      cleaned++
    } catch { /* skip unreadable */ }
  }
  return cleaned
}
```

- [ ] **Step 2: Write test inline in boot-cleanup.test.ts**

```ts
// tests/unit/hooks/boot-cleanup.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { cleanupStaleHookEntries } from '../../../src/main/hooks/boot-cleanup'

describe('cleanupStaleHookEntries', () => {
  let origHome = ''
  let fakeHome = ''
  beforeEach(() => {
    origHome = os.homedir()
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-bootclean-'))
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true })
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome)
  })
  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('removes hooks from stale sid files', () => {
    const f = path.join(fakeHome, '.claude', 'settings-dead-sid.json')
    fs.writeFileSync(f, JSON.stringify({ hooks: { PreToolUse: [{ type: 'http', url: 'http://localhost:19334/hook/dead-sid' }] } }))
    const n = cleanupStaleHookEntries(new Set<string>())
    expect(n).toBe(1)
    const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'))
    expect(parsed.hooks).toBeUndefined()
  })

  it('leaves active sid files alone', () => {
    const f = path.join(fakeHome, '.claude', 'settings-live-sid.json')
    fs.writeFileSync(f, JSON.stringify({ hooks: { PreToolUse: [{ type: 'http', url: 'http://localhost:19334/hook/live-sid' }] } }))
    const n = cleanupStaleHookEntries(new Set(['live-sid']))
    expect(n).toBe(0)
    const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'))
    expect(parsed.hooks).toBeDefined()
  })

  it('ignores settings files with no hooks block', () => {
    const f = path.join(fakeHome, '.claude', 'settings-other.json')
    fs.writeFileSync(f, JSON.stringify({ statusLine: 'x' }))
    expect(cleanupStaleHookEntries(new Set())).toBe(0)
  })
})
```

- [ ] **Step 3: Run tests** — 3 pass.

- [ ] **Step 4: Commit**

```bash
git add src/main/hooks/boot-cleanup.ts tests/unit/hooks/boot-cleanup.test.ts
git commit -m "feat(hooks): boot-time cleanup of stale hook entries"
```

---

## Task 10: Config schema + default

**Files:**
- Modify: whichever file declares `AppConfig` (grep `hooksEnabled\|enabledByDefault` to find — likely `src/shared/types.ts` or `src/main/config-manager.ts`)

- [ ] **Step 1: Add fields**

```ts
// AppConfig additions
hooksEnabled?: boolean   // default true
hooksPort?: number       // default 19334
```

- [ ] **Step 2: Defaults in config-manager**

Where `getConfig()` or equivalent builds the default config object, add:

```ts
hooksEnabled: existing.hooksEnabled ?? true,
hooksPort: existing.hooksPort ?? 19334,
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add <files>
git commit -m "feat(hooks): add hooksEnabled + hooksPort to config"
```

---

## Task 11: IPC handlers (toggle, getBuffer, getStatus)

**Files:**
- Create: `src/main/ipc/hooks-handlers.ts`
- Modify: `src/main/ipc/index.ts` (or wherever handlers register — grep `ipcMain.handle` to find)

- [ ] **Step 1: Implement**

```ts
// src/main/ipc/hooks-handlers.ts
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { HooksGateway } from '../hooks/hooks-gateway'
import type { HooksToggleRequest, HooksGetBufferRequest } from '../../shared/hook-types'

// persistPatch is called with a partial-config patch. It's the caller's
// responsibility to merge with current config and pass to the
// `(key, data)` two-arg `saveConfigDebounced` (see repo memory —
// zero-arg variant is a known foot-gun).
export function registerHooksHandlers(
  gateway: HooksGateway,
  persistPatch: (patch: Record<string, unknown>) => void,
) {
  ipcMain.handle(IPC.HOOKS_TOGGLE, async (_, req: HooksToggleRequest) => {
    if (req.enabled) {
      const status = await gateway.start()
      persistPatch({ hooksEnabled: true })
      return status
    } else {
      await gateway.stop()
      persistPatch({ hooksEnabled: false })
      return gateway.status()
    }
  })

  ipcMain.handle(IPC.HOOKS_GET_BUFFER, async (_, req: HooksGetBufferRequest) => {
    return gateway.getBuffer(req.sessionId)
  })

  ipcMain.handle(IPC.HOOKS_GET_STATUS, async () => gateway.status())
}
```

- [ ] **Step 2: Register in main entry**

In `src/main/index.ts` (or wherever the `BrowserWindow` is created):

```ts
import { HooksGateway } from './hooks/hooks-gateway'
import { registerHooksHandlers } from './ipc/hooks-handlers'
import { cleanupStaleHookEntries } from './hooks/boot-cleanup'

const gateway = new HooksGateway({
  defaultPort: config.hooksPort ?? 19334,
  emit: (channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send(channel, payload) } catch { /* destroyed */ }
    }
  },
})

app.whenReady().then(async () => {
  if (config.hooksEnabled !== false) {
    cleanupStaleHookEntries(new Set())
    await gateway.start()
  }
  registerHooksHandlers(gateway, (patch) => {
    // saveConfigDebounced takes (key, data) — two args, per repo memory.
    Object.assign(config, patch)
    saveConfigDebounced('appConfig', config)
  })
})

app.on('will-quit', async () => {
  await gateway.stop()
})
```

Export `gateway` from a module (or place it in an existing shared-state module) so pty-manager can import it.

- [ ] **Step 3: Typecheck + smoke**

```bash
npm run typecheck
npm run dev
# verify: no crash on launch. DevTools console: `window.electronAPI.hooks.getStatus()` returns { listening: true, port: 19334 }
```

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/hooks-handlers.ts src/main/index.ts
git commit -m "feat(hooks): register IPC handlers + start gateway on boot"
```

---

## Task 12: Wire pty-manager — inject on spawn, remove on close

**Files:**
- Modify: `src/main/pty-manager.ts`

Find the spot where the local-session per-session settings file is written (around line 200 per the existing grep). Right after it's written successfully, register the session with the gateway, generate a secret, and inject hooks.

SSH sessions are **in scope for this PR** per spec §Data flow/Session spawn ("Zero extra work on the remote side. Already validated for vision MCP."). Two changes to the SSH path:

- **Add `-R 19334:localhost:19334` to the SSH command** if the gateway is listening. Grep the existing ssh-flag construction (`-R` already used for vision MCP, model after it). Use the actual bound port from `gw.status().port` — don't hardcode 19334, because the retry logic may have picked a different port.
- **Extend the remote settings-file setup script** to include the `hooks` block alongside the existing statusline. The generated script is a single-lined semicolon-joined bash string (see memory note — no comments in the script). Generate the hooks JSON main-side, base64-encode, inline into the script, decode on the remote, write into `~/.claude/settings-<sid>.json`. Mirror the existing statusline pattern exactly.

Treat this as a required part of the task, not a bonus. Local-only would miss the SSH use case the spec explicitly covers.

Be defensive with the SSH script extension: it's single-lined, any syntax bug breaks the whole Claude Code spawn. Before committing, smoke test against Asustor with `npm run dev` and a real SSH session.

- [ ] **Step 1: Extend local spawn**

Around the local settings-file write block, after `fs.writeFileSync`:

```ts
import { injectHooks, removeHooks } from './hooks/session-hooks-writer'
import { getGateway } from './hooks' // create a small barrel that exports the singleton

// after settingsPath is written:
const gw = getGateway()
if (gw && gw.status().enabled && gw.status().listening && gw.status().port) {
  const secret = gw.registerSession(sessionId)
  injectHooks({
    sessionId,
    settingsPath,
    port: gw.status().port!,
    secret,
  })
}
```

- [ ] **Step 2: Extend SSH spawn**

Find the SSH ssh command construction. Add `-R 19334:localhost:19334` IF gateway is listening. Remote settings file is written inside the setup script; extend that script to include the `hooks` block. Grep the script template and match the existing single-line semicolon-joined pattern. Generate the hooks JSON in the main process, base64-encode it, inline it into the script alongside the statusline. (Exact code depends on the current template — read the section around line 200 and extend analogously to the existing statusline write. Keep the secret generation main-side; pass it into the template.)

Don't over-engineer. If the SSH script template is fiddly and risks breaking the already-debugged statusline pipeline, punt SSH hooks to a follow-up and document in the PR description. Spec §Non-goals explicitly allows partial coverage.

**Regex safety:** do NOT touch the prompt/password regex in pty-manager while adding SSH hooks. If the hooks-block addition to the setup script accidentally triggers either regex, the ssh flow breaks. Test by grepping the final generated script for tokens the regex might match (e.g. `Password:`, `❯`).

- [ ] **Step 3: Extend cleanup**

Where the PTY process exits / session cleanup runs:

```ts
const gw = getGateway()
if (gw) {
  gw.unregisterSession(sessionId)
  removeHooks({ settingsPath })
}
```

- [ ] **Step 4: Add `src/main/hooks/index.ts`** as a barrel:

```ts
// src/main/hooks/index.ts
import { HooksGateway } from './hooks-gateway'

let singleton: HooksGateway | null = null
export function setGateway(gw: HooksGateway) { singleton = gw }
export function getGateway(): HooksGateway | null { return singleton }
export { HooksGateway }
```

Call `setGateway(gateway)` in `src/main/index.ts` right after constructing it.

- [ ] **Step 5: Typecheck + smoke**

```bash
npm run typecheck
npm run dev
# open a local session, run one Claude Code prompt, check DevTools:
# window.electronAPI.hooks.getBuffer('<sid>') returns array of events
```

- [ ] **Step 6: Commit**

```bash
git add src/main/pty-manager.ts src/main/hooks/index.ts src/main/index.ts
git commit -m "feat(hooks): inject + clean up session hooks via pty-manager"
```

---

## Task 13: hooksStore (Zustand)

**Files:**
- Create: `src/renderer/stores/hooksStore.ts`
- Create: `tests/unit/stores/hooksStore.test.ts`

Store responsibilities:
- Keep a Map<sid, HookEvent[]> (appended as events arrive)
- Paused flag (UI stops appending; store still accumulates — spec §Expanded state)
- Filter (set of HookEventKinds to show)
- On mount of a session footer, call `window.electronAPI.hooks.getBuffer(sid)` to rehydrate (spec §Event received step 3)
- Clear session on `hooks:sessionEnded`
- `lastDropped` per session for the "older events dropped" badge

- [ ] **Step 1: Tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useHooksStore } from '../../../src/renderer/stores/hooksStore'

describe('hooksStore', () => {
  beforeEach(() => {
    useHooksStore.setState({
      eventsBySession: new Map(),
      paused: false,
      filter: null,
      droppedBySession: new Map(),
    })
  })

  it('appends events to the right session', () => {
    useHooksStore.getState().ingest({ sessionId: 'a', event: 'PreToolUse', payload: {}, ts: 1 } as any)
    useHooksStore.getState().ingest({ sessionId: 'b', event: 'PostToolUse', payload: {}, ts: 2 } as any)
    expect(useHooksStore.getState().eventsBySession.get('a')?.length).toBe(1)
    expect(useHooksStore.getState().eventsBySession.get('b')?.length).toBe(1)
  })

  it('caps renderer-side at 200', () => {
    for (let i = 0; i < 300; i++) {
      useHooksStore.getState().ingest({ sessionId: 'a', event: 'PreToolUse', payload: {}, ts: i } as any)
    }
    expect(useHooksStore.getState().eventsBySession.get('a')?.length).toBe(200)
  })

  it('rehydrate replaces list entirely', () => {
    useHooksStore.getState().ingest({ sessionId: 'a', event: 'PreToolUse', payload: {}, ts: 1 } as any)
    useHooksStore.getState().rehydrate('a', [
      { sessionId: 'a', event: 'PostToolUse', payload: {}, ts: 0 } as any,
    ])
    const list = useHooksStore.getState().eventsBySession.get('a')!
    expect(list.length).toBe(1)
    expect(list[0].event).toBe('PostToolUse')
  })

  it('clear removes a session', () => {
    useHooksStore.getState().ingest({ sessionId: 'a', event: 'PreToolUse', payload: {}, ts: 1 } as any)
    useHooksStore.getState().clearSession('a')
    expect(useHooksStore.getState().eventsBySession.has('a')).toBe(false)
  })

  it('markDropped sets latch', () => {
    useHooksStore.getState().markDropped('a')
    expect(useHooksStore.getState().droppedBySession.get('a')).toBe(true)
  })
})
```

- [ ] **Step 2: Implement**

```ts
// src/renderer/stores/hooksStore.ts
import { create } from 'zustand'
import type { HookEvent, HookEventKind } from '../../shared/hook-types'

const MAX_PER_SESSION = 200

interface State {
  eventsBySession: Map<string, HookEvent[]>
  droppedBySession: Map<string, boolean>
  paused: boolean
  filter: Set<HookEventKind> | null
  ingest: (e: HookEvent) => void
  rehydrate: (sid: string, events: HookEvent[]) => void
  clearSession: (sid: string) => void
  markDropped: (sid: string) => void
  setPaused: (p: boolean) => void
  setFilter: (f: Set<HookEventKind> | null) => void
}

export const useHooksStore = create<State>((set, get) => ({
  eventsBySession: new Map(),
  droppedBySession: new Map(),
  paused: false,
  filter: null,
  ingest: (e) => {
    set((s) => {
      const next = new Map(s.eventsBySession)
      const list = next.get(e.sessionId) ?? []
      const appended = [...list, e]
      if (appended.length > MAX_PER_SESSION) {
        appended.splice(0, appended.length - MAX_PER_SESSION)
      }
      next.set(e.sessionId, appended)
      return { eventsBySession: next }
    })
  },
  rehydrate: (sid, events) => {
    set((s) => {
      const next = new Map(s.eventsBySession)
      next.set(sid, events.slice(-MAX_PER_SESSION))
      return { eventsBySession: next }
    })
  },
  clearSession: (sid) => {
    set((s) => {
      const next = new Map(s.eventsBySession)
      next.delete(sid)
      const d = new Map(s.droppedBySession)
      d.delete(sid)
      return { eventsBySession: next, droppedBySession: d }
    })
  },
  markDropped: (sid) => {
    set((s) => {
      const d = new Map(s.droppedBySession)
      d.set(sid, true)
      return { droppedBySession: d }
    })
  },
  setPaused: (p) => set({ paused: p }),
  setFilter: (f) => set({ filter: f }),
}))
```

- [ ] **Step 3: Wire IPC listeners once at app mount**

In `src/renderer/main.tsx` (or equivalent root), before rendering the app:

```ts
import { useHooksStore } from './stores/hooksStore'

// Ingest unconditionally. `paused` is a UI-side-only filter per spec
// §Expanded state ("Pause stops new events being added to the UI list,
// store keeps collecting"). Do NOT gate ingestion on paused — that
// would drop events and break the "resume to see what happened"
// contract.
window.electronAPI.hooks.onEvent((e) => {
  useHooksStore.getState().ingest(e)
})
window.electronAPI.hooks.onSessionEnded((sid) => {
  useHooksStore.getState().clearSession(sid)
})
window.electronAPI.hooks.onDropped((p) => {
  useHooksStore.getState().markDropped(p.sessionId)
})
```

- [ ] **Step 4: Run tests** + commit.

```bash
npx vitest run tests/unit/stores/hooksStore.test.ts
git add src/renderer/stores/hooksStore.ts tests/unit/stores/hooksStore.test.ts src/renderer/main.tsx
git commit -m "feat(hooks): renderer store + IPC listeners"
```

---

## Task 14: LiveActivityFooter — collapsed state

**Files:**
- Create: `src/renderer/components/github/sections/LiveActivityFooter.tsx`

Per spec §Collapsed state: thin row, "▶ Live Activity", pulse dot when a new event arrives, "N events · 5s ago" counter. Click expands.

- [ ] **Step 1: Implementation**

```tsx
// src/renderer/components/github/sections/LiveActivityFooter.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useHooksStore } from '../../../stores/hooksStore'
import type { HookEvent, HookEventKind } from '../../../../shared/hook-types'

interface Props { sessionId: string }

// Hoisted above the component so the selector in useHooksStore can
// return a stable reference when a session has no events yet (avoids
// re-renders caused by `?? []` creating a new array identity each
// render). Keep immutable.
const EMPTY: HookEvent[] = []

export default function LiveActivityFooter({ sessionId }: Props) {
  const events = useHooksStore((s) => s.eventsBySession.get(sessionId) ?? EMPTY)
  const dropped = useHooksStore((s) => s.droppedBySession.get(sessionId) ?? false)
  const paused = useHooksStore((s) => s.paused)
  const filter = useHooksStore((s) => s.filter)
  const setPaused = useHooksStore((s) => s.setPaused)
  const setFilter = useHooksStore((s) => s.setFilter)
  const [expanded, setExpanded] = useState(false)
  const [pulseKey, setPulseKey] = useState(0)
  const lastLenRef = useRef(events.length)
  const [now, setNow] = useState(Date.now())

  // Rehydrate on mount so HMR reloads or re-enters preserve history
  useEffect(() => {
    let cancelled = false
    window.electronAPI.hooks.getBuffer(sessionId).then((buf: HookEvent[]) => {
      if (cancelled) return
      useHooksStore.getState().rehydrate(sessionId, buf)
    })
    return () => { cancelled = true }
  }, [sessionId])

  // Pulse dot when event count grows
  useEffect(() => {
    if (events.length > lastLenRef.current) setPulseKey((k) => k + 1)
    lastLenRef.current = events.length
  }, [events.length])

  // "5s ago" tick
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const visible = useMemo(() => {
    if (!filter) return events
    return events.filter((e) => filter.has(e.event as HookEventKind))
  }, [events, filter])

  const latest = events[events.length - 1]
  const agoLabel = latest ? relativeTime(now - latest.ts) : '—'

  return (
    <div className="border-t border-surface0 bg-mantle text-xs">
      <button
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-surface0 transition-colors duration-150"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label="Toggle Live Activity"
      >
        <span className="flex items-center gap-2">
          <span className="text-overlay1">{expanded ? '▼' : '▶'}</span>
          <span className="text-text">Live Activity</span>
          {events.length > 0 && (
            // One-shot 300ms flash on each new event. Tailwind's
            // `animate-pulse` is infinite — not what the spec asks for
            // ("blinks when a new event arrives"). Custom keyframe
            // `hooks-pulse` lives in src/renderer/styles.css. Forcing a
            // remount via `key={pulseKey}` restarts the animation.
            <span
              key={pulseKey}
              className="w-1.5 h-1.5 rounded-full bg-green [animation:hooks-pulse_300ms_ease-out]"
              aria-hidden="true"
            />
          )}
        </span>
        <span className="text-overlay1 tabular-nums">
          {events.length} event{events.length === 1 ? '' : 's'} · {agoLabel}
        </span>
      </button>
      {expanded && (
        <ExpandedList
          events={visible}
          dropped={dropped}
          paused={paused}
          setPaused={setPaused}
          filter={filter}
          setFilter={setFilter}
        />
      )}
    </div>
  )
}

function relativeTime(ms: number): string {
  if (ms < 1500) return 'just now'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}

// ExpandedList defined in Task 15
function ExpandedList(_: unknown): JSX.Element { return <div /> }
```

Leave `ExpandedList` as a stub for now; Task 15 fills it in.

- [ ] **Step 2: Add the keyframe to `src/renderer/styles.css`**

Find the `@theme` block. Outside it (keyframes don't live in `@theme`), append:

```css
@keyframes hooks-pulse {
  0%   { transform: scale(1);   opacity: 1; }
  50%  { transform: scale(1.8); opacity: 1; }
  100% { transform: scale(1);   opacity: 0.55; }
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/renderer/components/github/sections/LiveActivityFooter.tsx src/renderer/styles.css
git commit -m "feat(hooks): live-activity footer collapsed shell"
```

---

## Task 15: LiveActivityFooter — expanded list + filter + pause

**Files:**
- Modify: `src/renderer/components/github/sections/LiveActivityFooter.tsx`

- [ ] **Step 1: Replace the `ExpandedList` stub**

```tsx
interface ExpandedProps {
  events: HookEvent[]
  dropped: boolean
  paused: boolean
  setPaused: (p: boolean) => void
  filter: Set<HookEventKind> | null
  setFilter: (f: Set<HookEventKind> | null) => void
}

const KIND_LABEL: Record<HookEventKind, string> = {
  PreToolUse: 'Tool',
  PostToolUse: 'Tool',
  Notification: 'Notif',
  SessionStart: 'Start',
  Stop: 'Stop',
  PreCompact: 'Compact',
  SubagentStart: 'Task',
  SubagentStop: 'Task',
  StopFailure: 'Fail',
}

const KIND_COLOR: Record<HookEventKind, string> = {
  PreToolUse: 'text-blue',
  PostToolUse: 'text-blue',
  Notification: 'text-yellow',
  SessionStart: 'text-overlay1',
  Stop: 'text-overlay1',
  PreCompact: 'text-peach',
  SubagentStart: 'text-mauve',
  SubagentStop: 'text-mauve',
  StopFailure: 'text-red',
}

function ExpandedList({ events, dropped, paused, setPaused, filter, setFilter }: ExpandedProps) {
  const visibleSlice = events.slice(-20).reverse()

  const toggleKind = (k: HookEventKind) => {
    if (!filter) {
      // Start: exclude k from view
      const next = new Set<HookEventKind>(Object.keys(KIND_LABEL) as HookEventKind[])
      next.delete(k)
      setFilter(next)
      return
    }
    const next = new Set(filter)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    if (next.size === Object.keys(KIND_LABEL).length) setFilter(null)
    else setFilter(next)
  }

  return (
    <div className="bg-base px-3 py-2 space-y-2 max-h-[240px] overflow-y-auto transition-all duration-200">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1 flex-wrap">
          {(Object.keys(KIND_LABEL) as HookEventKind[]).map((k) => {
            const active = filter === null || filter.has(k)
            return (
              <button
                key={k}
                onClick={() => toggleKind(k)}
                className={`px-1.5 py-0.5 rounded text-[10px] border border-surface0 transition-colors duration-150 ${
                  active ? 'bg-surface0 text-text' : 'bg-transparent text-overlay0'
                }`}
                aria-pressed={active}
              >
                {KIND_LABEL[k]}
              </button>
            )
          })}
        </div>
        <button
          onClick={() => setPaused(!paused)}
          className="px-2 py-0.5 rounded text-[10px] bg-surface0 text-text hover:bg-surface1 transition-colors duration-150"
          aria-pressed={paused}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      {dropped && (
        <div className="text-[10px] text-overlay0 italic">
          Older events dropped (ring buffer full)
        </div>
      )}

      {visibleSlice.length === 0 && (
        <div className="text-overlay1 italic text-xs">No events yet</div>
      )}

      <ul className="space-y-0.5 font-mono text-[11px]">
        {visibleSlice.map((e, i) => (
          <li key={`${e.ts}-${i}`} className="flex gap-2 items-baseline">
            <span className="text-overlay0 tabular-nums">{formatClock(e.ts)}</span>
            <span className={`${KIND_COLOR[e.event as HookEventKind] ?? 'text-overlay1'} w-14`}>
              {KIND_LABEL[e.event as HookEventKind] ?? e.event}
            </span>
            <span className="text-text truncate">{e.summary ?? e.toolName ?? ''}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function formatClock(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString(undefined, { hour12: false })
}
```

- [ ] **Step 2: Typecheck** — no lint errors from unused.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/github/sections/LiveActivityFooter.tsx
git commit -m "feat(hooks): live-activity expanded view with filter + pause"
```

---

## Task 16: Wire footer into GitHubPanel

**Files:**
- Modify: `src/renderer/components/github/GitHubPanel.tsx`

- [ ] **Step 1: Render at bottom, behind master toggle**

Read the current `GitHubPanel.tsx`. Find the final closing of the panel's main column. Add above the closing tag:

```tsx
{config?.hooksEnabled !== false && currentSessionId && (
  <LiveActivityFooter sessionId={currentSessionId} />
)}
```

Import from the stores — find `hooksEnabled` through `useAppConfigStore` or wherever AppConfig is read. Don't add a new store for this — plug into the existing config store.

- [ ] **Step 2: Smoke test in dev**

```bash
npm run dev
```

Verify: footer renders at the bottom, collapsed default, clicks expand, filter + pause work.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/github/GitHubPanel.tsx
git commit -m "feat(hooks): mount LiveActivityFooter in GitHubPanel"
```

---

## Task 17: Settings page toggle + sub-toggles + port change

**Files:**
- Modify: `src/renderer/components/SettingsPage.tsx` (or wherever the GitHub tab's Features section lives — grep for `enabledByDefault` + Features UI)

Spec §Settings · GitHub tab defines the exact UI shape. Implement it literally.

- [ ] **Step 1: Add the section**

Above the existing Features section in the GitHub tab:

```tsx
<section className="space-y-3">
  <div className="flex items-center justify-between">
    <div>
      <h3 className="text-sm font-semibold text-text">HTTP Hooks Gateway</h3>
      <p className="text-xs text-subtext0 mt-1 max-w-md">
        Receives tool-call, permission, and lifecycle events from Claude Code
        sessions. Powers the Live Activity feed. No telemetry — listener is
        127.0.0.1 only; reverse-tunnelled into SSH sessions you start.
      </p>
    </div>
    <Toggle
      checked={config.hooksEnabled !== false}
      onChange={async (v) => {
        await window.electronAPI.hooks.toggle(v)
        saveConfig('appConfig', { ...config, hooksEnabled: v })
      }}
    />
  </div>

  <div className="text-[11px] text-overlay1">
    Listening on 127.0.0.1:{status?.port ?? '—'}
    <button
      className="ml-2 text-blue underline"
      onClick={() => setEditingPort(true)}
      type="button"
    >
      change port
    </button>
  </div>

  {editingPort && (
    <PortEditor
      initial={config.hooksPort ?? 19334}
      onCancel={() => setEditingPort(false)}
      onSave={async (p) => {
        saveConfig('appConfig', { ...config, hooksPort: p })
        // restart gateway by toggling off/on
        await window.electronAPI.hooks.toggle(false)
        await window.electronAPI.hooks.toggle(true)
        setEditingPort(false)
      }}
    />
  )}

  <div className="pl-4 space-y-1 text-xs">
    <label className="flex items-center gap-2">
      <input type="checkbox" checked readOnly disabled />
      <span>Live Activity feed <span className="text-overlay1">· show recent events in sidebar</span></span>
    </label>
    <label className="flex items-center gap-2 opacity-60">
      <input type="checkbox" checked={false} disabled />
      <span>Desktop notifications <span className="text-overlay1">· on permission requests and stop failures (coming soon)</span></span>
    </label>
  </div>
</section>
```

Use existing `<Toggle>` if one exists — grep for it. If not, a styled checkbox is fine.

- [ ] **Step 2: Add status subscription**

```ts
const [status, setStatus] = useState<HooksGatewayStatus | null>(null)
useEffect(() => {
  window.electronAPI.hooks.getStatus().then(setStatus)
  return window.electronAPI.hooks.onStatus(setStatus)
}, [])
```

- [ ] **Step 3: `PortEditor` component** — tiny local component, integer input with Cancel/Save.

- [ ] **Step 4: Emit status on enable/disable**

In `hooks-handlers.ts` → extend the toggle handler to broadcast status after start/stop:

```ts
const status = await gateway.start()  // or stop()
for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.HOOKS_STATUS, status)
return status
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/SettingsPage.tsx src/main/ipc/hooks-handlers.ts
git commit -m "feat(hooks): settings UI for master toggle + port change"
```

---

## Task 18: Integration test A — synthetic path

**Files:**
- Create: `tests/integration/hooks/synthetic.test.ts`

Drives a real `HooksGateway` through a real socket (bound to an ephemeral port). Uses `http.request` to POST, asserts the `emit` spy fires.

- [ ] **Step 1: Write**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'node:http'
import { HooksGateway } from '../../../src/main/hooks/hooks-gateway'

function post(port: number, sid: string, token: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: `/hook/${sid}`,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          'x-ccc-hook-token': token,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
      },
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

describe('integration: synthetic hooks path', () => {
  let gw: HooksGateway | null = null
  afterEach(async () => { await gw?.stop() })

  it('POST on bound port delivers to emit()', async () => {
    const emit = vi.fn()
    gw = new HooksGateway({ emit, defaultPort: 0 })
    await gw.start()
    const port = gw.status().port!
    const secret = gw.registerSession('sid-x')

    const res = await post(port, 'sid-x', secret, { event: 'PreToolUse', tool_name: 'Read', payload: { file: 'pkg.json' } })
    expect(res.status).toBe(200)
    expect(res.body).toBe('{}')

    const calls = emit.mock.calls.filter(([c]) => c === 'hooks:event')
    expect(calls.length).toBe(1)
    expect(calls[0][1].sessionId).toBe('sid-x')
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
npx vitest run tests/integration/hooks/synthetic.test.ts
git add tests/integration/hooks/synthetic.test.ts
git commit -m "test(hooks): synthetic integration of POST path"
```

---

## Task 19: Integration test B — real Claude Code

**Files:**
- Create: `tests/integration/hooks/real-claude.test.ts`

Spawns `claude --print` with a real settings file generated by `injectHooks`. Only runs if `claude` is on PATH. Skipped otherwise (so CI without Claude Code installed doesn't break).

- [ ] **Step 1: Write**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HooksGateway } from '../../../src/main/hooks/hooks-gateway'
import { injectHooks } from '../../../src/main/hooks/session-hooks-writer'

function claudeOnPath(): string | null {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(which, ['claude'], { encoding: 'utf-8' })
    return out.split('\n')[0].trim()
  } catch { return null }
}

// Confirm --settings is supported by this claude build. The flag was
// added relatively recently; older installs will silently ignore it and
// the test will fail with zero events (false negative).
function supportsSettingsFlag(claude: string): boolean {
  try {
    const help = execFileSync(claude, ['--help'], { encoding: 'utf-8' })
    return /--settings/.test(help)
  } catch { return false }
}

describe('integration: real Claude Code', () => {
  const claude = claudeOnPath()
  const canRun = claude !== null && supportsSettingsFlag(claude)
  const maybeIt = canRun ? it : it.skip

  let gw: HooksGateway | null = null
  let tmpDir = ''
  afterEach(async () => {
    await gw?.stop()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  maybeIt('PreToolUse + PostToolUse arrive when Claude uses Read tool', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-real-'))
    const settingsFile = path.join(tmpDir, 'settings-real-test.json')
    const events: Array<{ channel: string; payload: any }> = []
    gw = new HooksGateway({
      emit: (c, p) => events.push({ channel: c, payload: p }),
      defaultPort: 0,
    })
    await gw.start()
    const secret = gw.registerSession('real-test')
    injectHooks({
      sessionId: 'real-test',
      settingsPath: settingsFile,
      port: gw.status().port!,
      secret,
    })

    // Forcing a tool call: ask Claude to read package.json and stop.
    const child = spawn(
      claude!,
      ['--print', '--settings', settingsFile, 'Use the Read tool to read package.json. Then stop.'],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    )

    // 60s, not 30: cold-cache `claude --print` with a tool round-trip
    // regularly takes 20-40s on a freshly-opened project.
    const done = new Promise<void>((resolve) => child.on('close', () => resolve()))
    await Promise.race([done, new Promise<void>((r) => setTimeout(r, 60_000))])
    child.kill('SIGKILL')

    const pre = events.filter((e) => e.channel === 'hooks:event' && e.payload.event === 'PreToolUse')
    const post = events.filter((e) => e.channel === 'hooks:event' && e.payload.event === 'PostToolUse')
    expect(pre.length).toBeGreaterThan(0)
    expect(post.length).toBeGreaterThan(0)
  }, 65_000)
})
```

- [ ] **Step 2: Run** — passes if Claude is installed, skips otherwise.

```bash
npx vitest run tests/integration/hooks/real-claude.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add tests/integration/hooks/real-claude.test.ts
git commit -m "test(hooks): real-claude integration via --print"
```

---

## Task 20: Full test suite + typecheck

- [ ] **Step 1: Run everything**

```bash
npm run typecheck
npx vitest run
```

- [ ] **Step 2: Fix any regression in the 487 pre-existing tests**. Do not merge if any fail.

- [ ] **Step 3: Commit only if you had to touch pre-existing files**

```bash
git add <files>
git commit -m "chore(hooks): fix incidental breakage from hooks integration"
```

---

## Task 21: Manual smoke (Windows installer)

- [ ] **Step 1: Rebuild installer**

```bash
npm run package:win
```

- [ ] **Step 2: Install, run the manual smoke test from spec §Testing/Manual**

1. Start a local session, verify Live Activity footer appears + pulses on any Claude activity.
2. Start an SSH session to Asustor, verify events flow through the reverse tunnel. (If SSH was punted in Task 12, document this in the PR description and mark the SSH cases as a follow-up.)
3. Flip master toggle off — footer disappears, activity stops.
4. Flip back on, start a NEW session, verify events resume.
5. Kill app mid-session, restart — old sid's settings file cleaned on boot.

- [ ] **Step 3: Record findings in a scratch file** — `docs/superpowers/scratch/hooks-manual-smoke.md` (gitignored) — so the reviewer agent has evidence.

---

## Task 22: Independent review + PR

- [ ] **Step 1: Dispatch the `superpowers:code-reviewer` agent**

Brief the reviewer on:
- The spec file path (`docs/superpowers/specs/2026-04-22-http-hooks-gateway-design.md`)
- The plan file path (this file)
- The commits on `feat/hooks-gateway`
- Concerns to focus on: (1) spec compliance, (2) secret handling (no logs, no disk), (3) redactor coverage, (4) IPC race on session-ended vs in-flight event, (5) ring-buffer cap enforced main-side AND renderer-side, (6) loopback check belt-and-braces, (7) port retry disable-banner surface

- [ ] **Step 2: Address every blocker + should-fix**. Re-review if changes material.

- [ ] **Step 3: Open the PR against `fix/first-launch-modal-queue`** (so it stacks — this is important because PR #22 hasn't merged yet and shares this branch's history)

```bash
git push -u origin feat/hooks-gateway
gh pr create --base fix/first-launch-modal-queue --title "feat(hooks): HTTP hooks gateway MVP + Live Activity footer" --body "$(cat <<'EOF'
## Summary
- Implements HTTP Hooks Gateway MVP per docs/superpowers/specs/2026-04-22-http-hooks-gateway-design.md
- Adds Live Activity footer to the GitHub sidebar
- Master toggle in Settings · GitHub tab; port change affordance with retry logic
- Per-session UUID secrets in X-CCC-Hook-Token header; never logged or persisted
- 200-event ring buffer per session, main-side single source of truth
- Redactor extended beyond GitHub tokens to cover sk-*, xox*-, AKIA*, PEM blocks, password/token assignments

## Test plan
- [x] npm run typecheck clean
- [x] npx vitest run green (incl. new unit + integration tests)
- [x] Real-Claude integration test (skips locally when claude not on PATH)
- [x] Manual smoke on Windows installer (see docs/superpowers/scratch/hooks-manual-smoke.md)
- [ ] Mac validation gate (blocks hooks-dependent downstream PR, not this one)

## Not in scope
- Desktop notifications sub-toggle (stubbed UI, no wiring)
- Auto-approve rules
- Worktrees dashboard
- SSH remote injection [if punted in Task 12 — delete this bullet if done]

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Gotchas + style reminders

- **Catppuccin Mocha palette only.** base #1e1e2e · mantle #181825 · surface0 #313244 · surface1 #45475a · text #cdd6f4 · overlay0 #6c7086 · overlay1 #7f849c · blue #89b4fa · green #a6e3a1 · red #f38ba8 · yellow #f9e2af · mauve #cba6f7 · peach #fab387. No ad-hoc hex.
- **No `\u{...}` Unicode escapes in JSX.** `esbuild` (via electron-vite) can't transform them. Use SVGs or `String.fromCodePoint()`. Harmless in `.ts` string literals.
- **No default exports** except React components that are the sole export of their file.
- **Animations 150–300ms** CSS transitions for every UI mutation per user preference.
- **saveConfigDebounced(key, data)** — not zero args. Double-check every call site.
- **Zustand selectors:** `useStore((s) => s.action)`, never destructure the whole store (causes re-render cascades).
- **Em dashes** forbidden in public-facing strings (obvious AI tell). Use ` - ` or rephrase.
- **One sentence per user update** during execution. Don't narrate.

## Self-review pass (after plan is written)

1. **Spec coverage** — every §section of the spec has at least one task:
   - §User experience → Tasks 14, 15, 17
   - §Architecture → Tasks 5, 6, 7
   - §Components table → Tasks 1, 2, 3, 5, 8, 11, 13, 14
   - §Data flow/Session spawn → Task 12
   - §Data flow/Event received → Tasks 6, 7
   - §Data flow/Session close → Task 7 (unregisterSession) + Task 12 (cleanup)
   - §Data flow/Master toggle → Task 11
   - §Boot-time cleanup → Task 9
   - §Schemas → Task 1 (HookEvent) + Task 3 (redactor)
   - §Settings file injection shape → Task 8
   - §Disable story → Tasks 11 + 9
   - §Error handling → Task 5 (bind fail) + Task 6 (parse fail) + Task 7 (ring-buffer full, IPC destroyed)
   - §Security → Tasks 5 (loopback), 6 (secret check), 3 (redactor)
   - §Testing/Unit → Tasks 3, 5, 6, 7, 8, 9, 13
   - §Testing/Integration → Tasks 18, 19
   - §Testing/Manual → Task 21
   - §Performance → implicit in Tasks 7, 13 (200 cap enforced both sides)
   - §Risks/Claude Code http hook → exercised by Task 19 (real-Claude test is the spike)
2. **Placeholder scan** — no `TBD` / `TODO` / "similar to Task N" / handwavy "add error handling". All code is concrete.
3. **Type consistency** — `HookEvent`, `HookEventKind`, `HooksGatewayStatus` names match across tasks. `injectHooks`/`removeHooks` names match. `registerSession`/`unregisterSession` names match.

4. **Review-round-1 fixes folded in (2026-04-23):**
   - Redactor regex quantifiers bounded `{n,M}` to defeat ReDoS (Task 3).
   - `stop()` now clears `buffers` and `overflowLatched` alongside `secrets` (Task 5).
   - Settings file writer switched from `renameSync` to plain `writeFileSync` — rename-over-open-file fails on win32 (Task 8).
   - Buggy `paused` early-return in IPC wiring deleted; only the correct ingest-unconditionally version remains (Task 13).
   - SSH hooks injection is explicitly in scope (not punted). Task 12 carries both `-R` tunnel and setup-script extension.
   - `saveConfig` callback renamed to `persistPatch`; main-side merge handles the two-arg `saveConfigDebounced(key, data)` contract correctly (Task 11).
   - `SID_FROM_FILENAME` regex tightened to `[^.]+` so `settings-foo.json.bak` doesn't match (Task 9).
   - `EMPTY` sentinel hoisted above the component (Task 14).
   - Pulse dot switched from infinite `animate-pulse` to a one-shot `hooks-pulse` keyframe per spec §Collapsed state (Task 14).
   - Real-Claude test timeout raised to 60s and gated on `--help | grep --settings` (Task 19).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-23-hooks-gateway.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
