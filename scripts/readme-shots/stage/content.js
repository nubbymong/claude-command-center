// README staging — the FICTIONAL workspace the screenshots show.
//
// Everything in here is invented: the company (Larkspur, an e-commerce
// platform), the people, the e-mails, the projects, the conversations. Nothing
// is copied from a real session. It is the single source for the seed
// (seed.js — files on disk), the fake CLI (fake-claude.js — what the terminal
// shows) and the transcript builder (build-transcripts-db.py — the Logs view).
//
// Plain CommonJS with no dependencies; it runs on the VM under stock node.

'use strict'

const DAY = 86400000
const HOUR = 3600000
const MIN = 60000

// ── People ─────────────────────────────────────────────────────────────────
// Profile ids match /^[a-z0-9][a-z0-9-]*$/ (account-profiles.ts). Names are left
// empty on purpose so every surface shows the e-mail, like the reference shots.
const ACCOUNTS = [
  { key: 'alex', id: 'profile-alex-7f3a1c', name: '', email: 'alex@example.dev', colourKey: 'indigo', primary: true,
    buckets: { session: 41, weekly: 63, model: 22 }, sessionResetsInMin: 143, weeklyResetsInDays: 4.6 },
  { key: 'sam', id: 'profile-sam-2b9e4d', name: '', email: 'sam.rivera@example.io', colourKey: 'rose', primary: false,
    buckets: { session: 12, weekly: 20, model: 34 }, sessionResetsInMin: 221, weeklyResetsInDays: 4.6 },
  { key: 'jordan', id: 'profile-jordan-c51e08', name: '', email: 'jordan@example.co', colourKey: 'orchid', primary: false,
    buckets: { session: 4, weekly: 55, model: 91 }, sessionResetsInMin: 288, weeklyResetsInDays: 4.6 },
]

// ── Workspace: sections → groups → configs ─────────────────────────────────
// Sections and groups are separate files (config-sections.json / config-groups.json).
const SECTIONS = [
  { id: 'sec-platform', name: 'Platform' },
  { id: 'sec-web', name: 'Website' },
  { id: 'sec-data', name: 'Data' },
]
const GROUPS = [
  { id: 'grp-core', name: 'Core services', collapsed: false, sectionId: 'sec-platform' },
]

// Colours are Catppuccin Mocha; identityColorKey is the app's own key set.
const CONFIGS = [
  { id: 'cfg-api', label: 'api-gateway', workingDirectory: 'C:\\dev\\platform\\api-gateway', color: '#89b4fa', identityColorKey: 'slate-blue',
    sessionType: 'local', provider: 'claude', groupId: 'grp-core', profileKey: 'sam',
    claudeOptions: { model: 'fable', effortLevel: 'high', permissionMode: 'acceptEdits', loggingEnabled: true, agentIds: [] } },
  { id: 'cfg-auth', label: 'auth-service', workingDirectory: 'C:\\dev\\platform\\auth-service', color: '#b4befe', identityColorKey: 'lavender',
    sessionType: 'local', provider: 'claude', groupId: 'grp-core', profileKey: 'sam',
    claudeOptions: { model: 'opus', effortLevel: 'high', permissionMode: 'acceptEdits', loggingEnabled: true, agentIds: [] } },
  { id: 'cfg-infra', label: 'infra', workingDirectory: 'C:\\dev\\platform\\infra', color: '#94e2d5', identityColorKey: 'periwinkle',
    sessionType: 'local', provider: 'claude', shellOnly: true, sectionId: 'sec-platform',
    terminalOptions: { command: '', args: '', elevated: false } },
  { id: 'cfg-store', label: 'storefront', workingDirectory: 'C:\\dev\\web\\storefront', color: '#cba6f7', identityColorKey: 'mauve',
    sessionType: 'local', provider: 'claude', pinned: true, sectionId: 'sec-web', profileKey: 'alex',
    claudeOptions: { model: 'fable', effortLevel: 'max', permissionMode: 'acceptEdits', loggingEnabled: true, agentIds: [] } },
  { id: 'cfg-docs', label: 'docs-site', workingDirectory: 'C:\\dev\\web\\docs-site', color: '#f5c2e7', identityColorKey: 'pink',
    sessionType: 'local', provider: 'codex', sectionId: 'sec-web', profileKey: 'sam',
    codexOptions: { model: 'gpt-5.5', reasoningEffort: 'high', permissionsPreset: 'standard' } },
  { id: 'cfg-pipe', label: 'pipeline', workingDirectory: 'C:\\dev\\data\\pipeline', color: '#a6e3a1', identityColorKey: 'violet',
    sessionType: 'local', provider: 'claude', sectionId: 'sec-data', profileKey: 'jordan',
    claudeOptions: { model: 'opus', effortLevel: 'max', permissionMode: 'acceptEdits', loggingEnabled: true, agentIds: [] } },
  { id: 'cfg-wh', label: 'warehouse', workingDirectory: '/home/deploy/warehouse', color: '#fab387', identityColorKey: 'plum',
    sessionType: 'ssh', provider: 'claude', sectionId: 'sec-data', profileKey: 'jordan',
    sshConfig: { host: 'build-box.internal', port: 22, username: 'deploy', remotePath: '/home/deploy/warehouse', hasPassword: false, detachable: true, remoteOs: 'auto', postCommand: '', dockerContainer: '' },
    claudeOptions: { model: 'opus', effortLevel: 'high', permissionMode: 'acceptEdits', loggingEnabled: true, agentIds: [] } },
  // loose (no section, no group) — the divider row sits above these
  { id: 'cfg-notes', label: 'notes', workingDirectory: 'C:\\dev\\notes', color: '#f9e2af', identityColorKey: 'indigo',
    sessionType: 'local', provider: 'claude', profileKey: 'alex',
    claudeOptions: { model: 'sonnet', effortLevel: 'medium', permissionMode: 'acceptEdits', loggingEnabled: true, agentIds: [] } },
  { id: 'cfg-scratch', label: 'scratch', workingDirectory: 'C:\\dev', color: '#a6adc8', identityColorKey: 'rose',
    sessionType: 'local', provider: 'claude', shellOnly: true,
    terminalOptions: { command: '', args: '', elevated: false } },
]

// ── Live sessions restored at boot (session-state.json) ────────────────────
// Ids are the app's 24-hex shape; the fake CLI keys its scenario off resumeUuid.
const SESSIONS = [
  { id: 'a4f0c2d19e7b6358a1c0d2e4', configKey: 'cfg-store', label: 'storefront', customName: 'promo codes', accountKey: 'alex',
    provider: 'claude', model: 'fable', effort: 'max', scenario: 'promo', resumeUuid: '6d3f2a41-8c9e-4b17-9f52-0a1b2c3d4e5f',
    status: { model: 'Fable 5', modelId: 'claude-fable-5', ctxPct: 61, ctxWindow: 1000000, inTok: 608412, outTok: 41219, cost: 14.82, durMs: 2 * HOUR + 7 * MIN, added: 412, removed: 96 } },
  { id: 'b7e1d3f40a8c2957b3d1e5f6', configKey: 'cfg-api', label: 'api-gateway', accountKey: 'sam',
    provider: 'claude', model: 'fable', effort: 'high', scenario: 'ratelimit', resumeUuid: '2b8e4c17-5f3a-4d92-a6c1-7e0d9f2b3a45',
    status: { model: 'Fable 5', modelId: 'claude-fable-5', ctxPct: 34, ctxWindow: 1000000, inTok: 338905, outTok: 22876, cost: 8.11, durMs: 1 * HOUR + 22 * MIN, added: 188, removed: 41 } },
  { id: 'c9a2e4b51f0d3a68c4e2f6a7', configKey: 'cfg-pipe', label: 'pipeline', accountKey: 'jordan',
    provider: 'claude', model: 'opus', effort: 'max', scenario: 'dedupe', resumeUuid: '9f1c7e23-0a4b-4c58-b2d7-3e6f8a1c9d02',
    status: { model: 'Opus 4.8', modelId: 'claude-opus-4-8', ctxPct: 78, ctxWindow: 200000, inTok: 156311, outTok: 18402, cost: 5.63, durMs: 3 * HOUR + 41 * MIN, added: 731, removed: 264 } },
  { id: 'd1b3f5a62e0c4b79d5f3a7b8', configKey: 'cfg-docs', label: 'docs-site', accountKey: 'sam',
    provider: 'codex', model: 'gpt-5.5', scenario: 'codex' },
  { id: 'e2c4a6b73f1d5c80e6a4b8c9', configKey: 'cfg-infra', label: 'infra', accountKey: 'alex', shellOnly: true },
]
const ACTIVE_SESSION_ID = SESSIONS[0].id

// ── Scripted conversations ─────────────────────────────────────────────────
// One scenario per project. `turns` drive BOTH the fake terminal (in order,
// with typing) and the transcript JSONL / Logs rows (same order, timestamps
// spread). Item kinds:
//   { user }                          a prompt
//   { text }                          an assistant paragraph (markdown-ish)
//   { tool, input, result[], diff? }  a tool call with its result lines;
//                                     diff rows are ['ctx'|'add'|'del', lineNo, text]
//   { done: '2m 14s' }                the "✻ Baked for …" turn-complete line
//   { spinner }                       leave the CLI thinking (terminal only)
const SCENARIOS = {
  promo: {
    project: 'storefront', cwd: 'C:\\dev\\web\\storefront', title: 'promo code entry',
    turns: [
      { user: 'Add a promo code field to the checkout summary. Validate it against /api/promo, show the discount as its own line, and cover it with tests.' },
      { text: "I'll look at the checkout summary and the existing promo endpoint first." },
      { tool: 'Read', input: { file_path: 'src/checkout/Summary.tsx' }, result: ['Read 184 lines'] },
      { tool: 'Read', input: { file_path: 'src/api/promo.ts' }, result: ['Read 62 lines'] },
      { tool: 'Grep', input: { pattern: 'applyPromo|promoCode', path: 'src' }, result: ['Found 7 matches in 4 files'] },
      { text: 'The endpoint already returns `{ code, percentOff, expiresAt }` — the UI just never calls it. Plan: a `PromoField` under the line items, a `usePromo` hook that debounces validation, and a discount row that only renders once a code is accepted.' },
      { tool: 'Write', input: { file_path: 'src/checkout/PromoField.tsx' }, result: ['Wrote 71 lines to src/checkout/PromoField.tsx'] },
      { tool: 'Write', input: { file_path: 'src/hooks/usePromo.ts' }, result: ['Wrote 48 lines to src/hooks/usePromo.ts'] },
      { tool: 'Update', input: { file_path: 'src/checkout/Summary.tsx' }, result: ['Updated src/checkout/Summary.tsx with 18 additions and 2 removals'],
        diff: [
          ['ctx', 41, "import { LineItem } from './LineItem'"],
          ['add', 42, "import { PromoField } from './PromoField'"],
          ['add', 43, "import { usePromo } from '../hooks/usePromo'"],
          ['ctx', 44, ''],
          ['gap'],
          ['ctx', 87, '      <TotalRow label="Subtotal" amount={subtotal} />'],
          ['del', 88, '      <TotalRow label="Total" amount={total} />'],
          ['add', 88, '      <PromoField value={promo.code} onApply={promo.apply} error={promo.error} />'],
          ['add', 89, '      {promo.applied && ('],
          ['add', 90, '        <TotalRow label={`Promo ${promo.code}`} amount={-promo.discount} tone="success" />'],
          ['add', 91, '      )}'],
          ['add', 92, '      <TotalRow label="Total" amount={total - promo.discount} />'],
        ] },
      { tool: 'Write', input: { file_path: 'src/checkout/__tests__/PromoField.test.tsx' }, result: ['Wrote 96 lines to src/checkout/__tests__/PromoField.test.tsx'] },
      { tool: 'Bash', input: { command: 'npm test -- checkout', description: 'Run the checkout test suites' },
        result: ['PASS src/checkout/__tests__/Summary.test.tsx', 'PASS src/checkout/__tests__/PromoField.test.tsx', 'Tests: 23 passed, 23 total', 'Time:  4.81 s'] },
      { text: 'Done. Promo codes validate on blur with a 300 ms debounce, an invalid code shows an inline error under the field, and the discount line only appears once the API accepts the code. 23 tests pass, 5 of them new.', done: '2m 14s' },
      { user: 'Nice. Now make the discount row animate in, and give expired codes their own message.' },
      { text: "I'll add a short height/opacity transition on the discount row and branch the error copy on the `expiresAt` the API already returns." },
      { tool: 'Update', input: { file_path: 'src/hooks/usePromo.ts' }, result: ['Updated src/hooks/usePromo.ts with 9 additions and 1 removal'] },
      { tool: 'Update', input: { file_path: 'src/checkout/Summary.tsx' }, result: ['Updated src/checkout/Summary.tsx with 6 additions and 1 removal'] },
      { tool: 'Bash', input: { command: 'npm test -- checkout', description: 'Re-run the checkout suites' },
        result: ['PASS src/checkout/__tests__/Summary.test.tsx', 'PASS src/checkout/__tests__/PromoField.test.tsx', 'Tests: 25 passed, 25 total', 'Time:  4.97 s'] },
      { text: 'Both in. The row slides in over 180 ms and respects `prefers-reduced-motion`; an expired code now reads "This code expired on 12 Aug" instead of the generic message. Want me to render the three field placements on the canvas so you can pick one?', done: '1m 02s' },
      { user: 'Yes — show me the options on the canvas' },
      { spinner: 'Sketching' },
    ],
  },
  ratelimit: {
    project: 'api-gateway', cwd: 'C:\\dev\\platform\\api-gateway', title: 'per-tenant rate limiting',
    turns: [
      { user: 'Add per-tenant rate limiting to the gateway: 600 req/min by default, overridable per tenant from the config table, with the usual RateLimit headers.' },
      { text: "Let me see how requests are keyed today and where tenant config is loaded." },
      { tool: 'Read', input: { file_path: 'src/plugins/tenant.ts' }, result: ['Read 118 lines'] },
      { tool: 'Read', input: { file_path: 'src/config/tenants.ts' }, result: ['Read 74 lines'] },
      { tool: 'Grep', input: { pattern: 'onRequest|preHandler', path: 'src/plugins' }, result: ['Found 12 matches in 6 files'] },
      { text: 'Tenant id is resolved in an `onRequest` hook, so a sliding-window limiter can sit right after it. I will keep counters in the existing Redis client and fall open (log, do not block) if Redis is unavailable — a gateway that 503s on a cache blip is worse than one that briefly over-admits.' },
      { tool: 'Write', input: { file_path: 'src/plugins/rate-limit.ts' }, result: ['Wrote 132 lines to src/plugins/rate-limit.ts'] },
      { tool: 'Update', input: { file_path: 'src/app.ts' }, result: ['Updated src/app.ts with 4 additions'] },
      { tool: 'Write', input: { file_path: 'test/rate-limit.test.ts' }, result: ['Wrote 141 lines to test/rate-limit.test.ts'] },
      { tool: 'Bash', input: { command: 'npm run test:unit -- rate-limit', description: 'Run the limiter tests' },
        result: ['✓ admits under the limit (11 ms)', '✓ rejects with 429 and Retry-After (9 ms)', '✓ per-tenant override wins (7 ms)', '✓ falls open when redis is down (14 ms)', '4 passing (312 ms)'] },
      { text: 'Limiter is in: `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` on every response, `Retry-After` on 429s, per-tenant overrides read from the config table with a 60 s cache. Four tests cover admit, reject, override and the fall-open path.', done: '3m 40s' },
      { user: 'Add a metric for rejections per tenant and wire it into the dashboard' },
      { spinner: 'Wiring' },
    ],
  },
  dedupe: {
    project: 'pipeline', cwd: 'C:\\dev\\data\\pipeline', title: 'dedupe events in ingest',
    turns: [
      { user: 'The nightly ingest double-counts events when a producer retries. Dedupe on (source, event_id) inside the ingest step without slowing it down.' },
      { text: "I'll trace an event through ingest and see where a retry can land twice." },
      { tool: 'Read', input: { file_path: 'pipeline/ingest/step.py' }, result: ['Read 211 lines'] },
      { tool: 'Read', input: { file_path: 'pipeline/ingest/sink.py' }, result: ['Read 96 lines'] },
      { tool: 'Bash', input: { command: 'python -m pipeline.tools.sample --date 2026-08-17 --limit 5', description: 'Sample five raw events from yesterday' },
        result: ['{"source":"pos","event_id":"e-88121","ts":"2026-08-17T02:14:09Z"}', '{"source":"pos","event_id":"e-88121","ts":"2026-08-17T02:14:11Z"}', '… +3 lines'] },
      { text: 'Confirmed: the retry carries the same `event_id`, two seconds later. A bloom filter per batch catches the intra-batch case cheaply, and a `(source, event_id)` unique index on the staging table catches cross-batch retries with `ON CONFLICT DO NOTHING`.' },
      { tool: 'Update', input: { file_path: 'pipeline/ingest/step.py' }, result: ['Updated pipeline/ingest/step.py with 27 additions and 6 removals'] },
      { tool: 'Write', input: { file_path: 'migrations/0042_staging_dedupe.sql' }, result: ['Wrote 9 lines to migrations/0042_staging_dedupe.sql'] },
      { tool: 'Bash', input: { command: 'pytest tests/ingest -q', description: 'Run the ingest tests' }, result: ['.................... 20 passed in 6.42s'] },
      { tool: 'Bash', input: { command: 'python -m pipeline.bench ingest --events 200000', description: 'Benchmark the ingest step' }, result: ['before: 41.8 s   after: 43.1 s   (+3.1%)'] },
      { text: 'Duplicates gone at a 3% cost on the benchmark, all of it the bloom-filter check. Cross-batch retries are absorbed by the new unique index. Migration 0042 is additive and safe to run online.', done: '4m 55s' },
      { user: 'Backfill the last 30 days and give me the before/after counts per source' },
      { spinner: 'Backfilling' },
    ],
  },
  auth: {
    project: 'auth-service', cwd: 'C:\\dev\\platform\\auth-service', title: 'refresh-token rotation',
    turns: [
      { user: 'Rotate refresh tokens on every use and revoke the whole family if an old one is replayed.' },
      { text: 'Reading the token store and the refresh handler.' },
      { tool: 'Read', input: { file_path: 'src/tokens/store.ts' }, result: ['Read 143 lines'] },
      { tool: 'Read', input: { file_path: 'src/routes/refresh.ts' }, result: ['Read 58 lines'] },
      { text: 'Each refresh will mint a new token in the same family and mark the old one used. A used token presented again revokes the family and returns 401 with `token_reused`.' },
      { tool: 'Update', input: { file_path: 'src/tokens/store.ts' }, result: ['Updated src/tokens/store.ts with 31 additions and 4 removals'] },
      { tool: 'Update', input: { file_path: 'src/routes/refresh.ts' }, result: ['Updated src/routes/refresh.ts with 12 additions and 3 removals'] },
      { tool: 'Bash', input: { command: 'npm test -- tokens', description: 'Run the token tests' }, result: ['Tests: 31 passed, 31 total'] },
      { text: 'Rotation and family revocation are in, with tests for the replay path and for concurrent refreshes racing on the same token.', done: '2m 51s' },
    ],
  },
  notes: {
    project: 'notes', cwd: 'C:\\dev\\notes', title: 'weekly summary',
    turns: [
      { user: 'Summarise this week\'s notes into a short update for the team channel.' },
      { tool: 'Glob', input: { pattern: '2026-08-1*.md' }, result: ['Found 5 files'] },
      { tool: 'Read', input: { file_path: '2026-08-17.md' }, result: ['Read 41 lines'] },
      { text: 'Three themes this week: promo codes shipped to staging, the gateway limiter is in review, and ingest dedupe is benchmarked. Draft below — trimmed to five lines.' },
      { done: '38s' },
    ],
  },
}

// ── Codex session (a stand-in TUI only — content never captured up close) ──
const CODEX = {
  project: 'docs-site', cwd: 'C:\\dev\\web\\docs-site', model: 'gpt-5.5',
  lines: [
    'Regenerate the API reference pages from the OpenAPI spec and fix the broken anchors.',
    '• Reading openapi/gateway.yaml',
    '• Rewriting docs/reference/*.mdx (14 files)',
    '• Running `npm run build` — 0 warnings',
  ],
}

// ── History for Logs / Tokenomics: sessions over the past weeks ────────────
// Each entry becomes one transcript file (JSONL) + one run in transcripts.db.
// daysAgo/hour place it; scenario supplies the content; turns caps how far the
// script runs so sessions differ in length. Assistant usage is generated.
function history() {
  const rows = []
  const plan = [
    // configKey, accountKey, scenario, model, days ago (fractional), turns cap
    ['cfg-store', 'alex', 'promo', 'claude-fable-5', 0.9, 99],
    ['cfg-store', 'alex', 'promo', 'claude-fable-5', 2.4, 12],
    ['cfg-store', 'alex', 'promo', 'claude-opus-4-8', 6.1, 9],
    ['cfg-store', 'alex', 'promo', 'claude-fable-5', 9.7, 17],
    ['cfg-store', 'alex', 'promo', 'claude-opus-4-8', 15.2, 12],
    ['cfg-store', 'alex', 'promo', 'claude-opus-4-8', 22.5, 17],
    ['cfg-store', 'alex', 'promo', 'claude-sonnet-4-6', 31.3, 9],
    ['cfg-api', 'sam', 'ratelimit', 'claude-fable-5', 1.2, 99],
    ['cfg-api', 'sam', 'ratelimit', 'claude-fable-5', 4.6, 8],
    ['cfg-api', 'sam', 'ratelimit', 'claude-opus-4-8', 11.8, 11],
    ['cfg-api', 'sam', 'ratelimit', 'claude-opus-4-8', 18.3, 12],
    ['cfg-api', 'sam', 'ratelimit', 'claude-opus-4-8', 27.9, 8],
    ['cfg-auth', 'sam', 'auth', 'claude-opus-4-8', 3.3, 99],
    ['cfg-auth', 'sam', 'auth', 'claude-opus-4-8', 13.4, 6],
    ['cfg-auth', 'sam', 'auth', 'claude-sonnet-4-6', 25.1, 9],
    ['cfg-pipe', 'jordan', 'dedupe', 'claude-opus-4-8', 1.6, 99],
    ['cfg-pipe', 'jordan', 'dedupe', 'claude-opus-4-8', 5.2, 10],
    ['cfg-pipe', 'jordan', 'dedupe', 'claude-fable-5', 8.8, 12],
    ['cfg-pipe', 'jordan', 'dedupe', 'claude-opus-4-8', 16.9, 7],
    ['cfg-pipe', 'jordan', 'dedupe', 'claude-opus-4-8', 21.4, 12],
    ['cfg-pipe', 'jordan', 'dedupe', 'claude-opus-4-8', 29.6, 10],
    ['cfg-notes', 'alex', 'notes', 'claude-sonnet-4-6', 2.1, 99],
    ['cfg-notes', 'alex', 'notes', 'claude-sonnet-4-6', 9.0, 99],
    ['cfg-notes', 'alex', 'notes', 'claude-sonnet-4-6', 16.0, 99],
    ['cfg-notes', 'alex', 'notes', 'claude-sonnet-4-6', 23.0, 99],
    ['cfg-notes', 'alex', 'notes', 'claude-sonnet-4-6', 30.0, 99],
  ]
  let n = 0
  for (const [configKey, accountKey, scenario, model, daysAgo, cap] of plan) {
    n++
    rows.push({ configKey, accountKey, scenario, model, daysAgo, cap, uuid: histUuid(n) })
  }
  return rows
}

// Deterministic, valid-looking UUIDs for history transcripts.
function histUuid(n) {
  const h = (n * 2654435761 % 4294967296).toString(16).padStart(8, '0')
  return `${h}-4a1b-4c2d-8e3f-${String(n).padStart(12, '0')}`
}

// ── Codex rollouts (tokenomics only) ───────────────────────────────────────
const CODEX_HISTORY = [
  { daysAgo: 0.6, turns: 14, model: 'gpt-5.5', cwd: 'C:\\dev\\web\\docs-site' },
  { daysAgo: 3.8, turns: 9, model: 'gpt-5.5', cwd: 'C:\\dev\\web\\docs-site' },
  { daysAgo: 7.4, turns: 22, model: 'gpt-5.3-codex', cwd: 'C:\\dev\\web\\docs-site' },
  { daysAgo: 12.9, turns: 11, model: 'gpt-5.5', cwd: 'C:\\dev\\web\\docs-site' },
  { daysAgo: 19.2, turns: 16, model: 'gpt-5.5', cwd: 'C:\\dev\\web\\docs-site' },
  { daysAgo: 26.7, turns: 8, model: 'gpt-5.3-codex', cwd: 'C:\\dev\\web\\docs-site' },
]

// ── Memory notes (~/.claude/projects/<slug>/memory/*.md) ───────────────────
// [name, type, description, body, ageDays]
const MEMORY = {
  storefront: [
    ['feedback-run-checkout-suite-before-claiming-done', 'feedback', 'Always run the full checkout suite before saying a change is done — a passing PromoField test alone hid a Summary regression once.', 'Run `npm test -- checkout` (both suites), not the single file. **Why:** the totals row is shared state. **How to apply:** quote the pass count in the summary.', 1],
    ['project-promo-codes-scope', 'project', 'Promo codes: validate on blur, 300 ms debounce, discount row only after the API accepts; expired codes get a dated message.', 'Shipped 2026-08-18 to staging. Open: pick the field placement (A inline / B link / C modal) on the canvas.', 1],
    ['project-checkout-totals-are-derived', 'project', 'Never store a total; Summary derives it from line items minus discount at render time.', 'Storing totals caused the double-discount bug in June. Derive, do not persist.', 4],
    ['reference-design-tokens', 'reference', 'Colour and spacing tokens live in `src/theme/tokens.css`; success tone is `--tone-success`.', 'Use tokens, never hex, in components. Tone names: neutral, success, warning, danger.', 9],
    ['feedback-no-inline-styles', 'feedback', 'Owner rejects inline style props in JSX — use the token classes.', '**Why:** the theme switch reads classes. **How to apply:** `className="tone-success"`, not `style={{color}}`.', 12],
    ['project-cart-persistence', 'project', 'Cart persists to localStorage under `larkspur.cart.v2`; v1 keys are migrated on read and deleted.', 'Migration lives in `src/cart/migrate.ts`; keep it until Q4.', 18],
    ['user-prefers-tests-colocated', 'user', 'Alex keeps tests next to components in `__tests__` folders, not a top-level tests dir.', 'Mirror the component path.', 22],
    ['reference-promo-api-contract', 'reference', '`GET /api/promo/:code` returns `{code, percentOff, expiresAt}`; 404 for unknown, 410 for expired.', 'The 410 is what drives the "expired on …" message.', 2],
    ['project-a11y-audit-actions', 'project', 'Outstanding a11y actions from the July audit: focus ring on Apply, live region for the discount row.', 'Live region done 2026-08-18; focus ring open.', 5],
    ['feedback-keep-summary-short', 'feedback', 'End-of-task summaries: three sentences max, numbers first.', '**Why:** they are read in the sidebar preview.', 27],
    ['project-image-cdn-cutover', 'project', 'Product images moved to the CDN on 2026-07-30; old `/static/img` paths 301 for 90 days.', 'Remove the redirect map after 2026-10-28.', 20],
    ['reference-storybook-url', 'reference', 'Storybook for the storefront is served from the docs-site under /storybook.', 'Rebuild with `npm run storybook:build`.', 35],
    ['project-perf-budget', 'project', 'LCP budget on the product page is 1.8 s on the mid-tier profile; the hero image is the usual offender.', 'Check `npm run perf` before merging anything on the product page.', 41],
    ['feedback-prefer-small-prs', 'feedback', 'Split UI and hook changes into separate commits so the diff reads top-down.', '**Why:** review happens on the phone.', 48],
  ],
  'api-gateway': [
    ['project-rate-limiter-design', 'project', 'Sliding-window limiter in Redis, 600 req/min default, per-tenant override cached 60 s, falls OPEN when Redis is unavailable.', 'Headers: RateLimit-Limit/Remaining/Reset, Retry-After on 429. Metric per tenant is next.', 1],
    ['feedback-fail-open-on-cache', 'feedback', 'The gateway must never 503 because a cache is down — degrade, log, carry on.', '**Why:** an outage in May was self-inflicted this way.', 1],
    ['reference-tenant-config-table', 'reference', 'Tenant overrides live in `tenant_config` (Postgres); read through `src/config/tenants.ts`, never directly.', 'Cache TTL 60 s.', 3],
    ['project-openapi-is-source-of-truth', 'project', 'Route schemas are generated from `openapi/gateway.yaml`; hand-written schemas are rejected in review.', 'Regenerate with `npm run gen:routes`.', 8],
    ['user-sam-reviews-headers-first', 'user', 'Sam reads response headers before bodies when reviewing — call out any header change explicitly.', '', 10],
    ['project-request-id-propagation', 'project', '`x-request-id` is minted at the edge and must be forwarded to every upstream call.', 'The `upstream()` helper does it; do not hand-roll fetch.', 15],
    ['reference-redis-client', 'reference', 'One Redis client per process, from `src/lib/redis.ts`; it reconnects with jittered backoff.', 'Do not `new Redis()` elsewhere.', 19],
    ['project-graceful-shutdown', 'project', 'SIGTERM drains in-flight requests for up to 20 s before exit.', 'Health endpoint flips to 503 immediately so the balancer stops routing.', 26],
    ['feedback-log-at-boundary', 'feedback', 'Log once, at the boundary, with the request id — not inside helpers.', '**Why:** duplicate lines make the dashboards lie.', 33],
    ['project-canary-rollout', 'project', 'Gateway deploys go 5% → 50% → 100% with a 10-minute soak between steps.', 'Rollback is a single `deploy rollback gateway`.', 40],
  ],
  pipeline: [
    ['project-ingest-dedupe', 'project', 'Ingest dedupes on (source, event_id): per-batch bloom filter plus a unique index on staging with ON CONFLICT DO NOTHING.', 'Benchmark cost +3%. Migration 0042. Backfill of the last 30 days pending.', 1],
    ['reference-nightly-schedule', 'reference', 'Nightly ingest runs at 02:00 UTC from the scheduler; retries up to 3× with 10-minute gaps.', 'Retries are why duplicates appeared.', 2],
    ['feedback-benchmark-every-ingest-change', 'feedback', 'Any change to the ingest step ships with a before/after benchmark line.', '**Why:** the nightly window is fixed.', 6],
    ['project-warehouse-partitions', 'project', 'Fact tables are partitioned by day; queries must include the partition key.', 'The linter in `tools/sqlcheck.py` enforces it.', 11],
    ['user-jordan-wants-counts', 'user', 'Jordan wants row counts before/after for every data fix, per source.', '', 14],
    ['reference-event-schema', 'reference', 'Raw events are `{source, event_id, ts, payload}`; `payload` is opaque JSON.', 'Schema doc in `docs/events.md`.', 21],
    ['project-late-arriving-events', 'project', 'Events up to 48 h late are accepted into their original partition; later than that go to `late_events`.', '', 29],
    ['project-dbt-models-naming', 'project', 'dbt models: `stg_` staging, `int_` intermediate, `fct_`/`dim_` marts.', '', 37],
  ],
  'auth-service': [
    ['project-refresh-token-rotation', 'project', 'Refresh tokens rotate on every use; a replayed token revokes the whole family and returns 401 `token_reused`.', 'Tests cover replay and concurrent refresh.', 3],
    ['reference-jwt-claims', 'reference', 'Access tokens carry `sub`, `tenant`, `scope`, 15-minute expiry.', '', 9],
    ['feedback-never-log-tokens', 'feedback', 'Token values never reach logs — not even truncated.', '**Why:** compliance. **How to apply:** log the token id (`jti`) only.', 13],
    ['project-password-policy', 'project', 'Minimum 12 chars, breached-password check via the k-anonymity API, no composition rules.', '', 24],
    ['project-session-list-endpoint', 'project', '`GET /me/sessions` lists active families with device hints; `DELETE` revokes one.', '', 31],
  ],
  'docs-site': [
    ['project-docs-from-openapi', 'project', 'API reference pages are generated from `openapi/gateway.yaml`; hand edits get overwritten.', 'Regenerate with `npm run gen:reference`.', 1],
    ['reference-astro-config', 'reference', 'Docs are Astro + Starlight; the sidebar is `astro.config.mjs`.', '', 7],
    ['feedback-code-samples-must-run', 'feedback', 'Every code sample in the docs is executed in CI; do not paste pseudo-code.', '', 16],
    ['project-versioned-docs', 'project', 'Docs are versioned per gateway major; the switcher reads `versions.json`.', '', 28],
  ],
  notes: [
    ['user-weekly-update-format', 'user', 'Weekly team update: five lines max, one per theme, links at the end.', '', 2],
    ['reference-team-channel', 'reference', 'Updates go to #larkspur-eng on Mondays before 10:00.', '', 9],
    ['project-q3-themes', 'project', 'Q3 themes: promo codes, gateway hardening, ingest correctness.', '', 44],
  ],
  infra: [
    ['reference-terraform-workspaces', 'reference', 'One workspace per environment: dev, staging, prod. `terraform workspace select` before anything.', '', 5],
    ['feedback-plan-before-apply', 'feedback', 'Always paste the plan summary before applying — even for a tag change.', '', 12],
    ['project-cost-alerts', 'project', 'Budget alerts fire at 80% and 100% of the monthly cap to #larkspur-infra.', '', 30],
  ],
}

// Padding notes: realistic titles used to bring counts up without inventing
// bodies for each — the drawer only ever opens a hand-written one.
const PAD_TITLES = [
  ['project', 'flaky-test-quarantine', 'Quarantined flaky tests and the ticket tracking each.'],
  ['reference', 'ci-pipeline-stages', 'CI stages: lint → unit → build → e2e → publish; e2e is required on main only.'],
  ['feedback', 'commit-message-format', 'Conventional commits, imperative mood, scope in parentheses.'],
  ['project', 'dependency-upgrade-cadence', 'Minor upgrades weekly via the bot; majors get their own PR and a changelog note.'],
  ['reference', 'oncall-runbook-location', 'Runbooks live in docs/runbooks; the index is RUNBOOKS.md.'],
  ['project', 'feature-flags-inventory', 'Active flags and their owners; stale flags are removed after 30 days at 100%.'],
  ['feedback', 'ask-before-schema-changes', 'Any migration that drops or renames a column is confirmed with the owner first.'],
  ['reference', 'local-dev-ports', 'Local ports: 3000 web, 4000 gateway, 5432 postgres, 6379 redis.'],
  ['project', 'error-budget-policy', 'When the monthly error budget is spent, feature work pauses for reliability fixes.'],
  ['user', 'timezone-and-hours', 'Team spans UTC and UTC+1; avoid deploys after 16:00 UTC.'],
]

// ── Insights (report.html + kpis.json for the primary account) ─────────────
const INSIGHTS = {
  runId: '2026-08-18-071233-014411',
  timestamp: Date.parse('2026-08-18T07:12:33Z'),
  accountKey: 'alex',
  html: `<!doctype html><html><head><meta charset="utf-8"><title>Claude Code Insights</title></head><body>
<h1>Claude Code Insights</h1>
<p class="subtitle">1,912 messages across 128 sessions (211 total) | 2026-07-20 to 2026-08-18</p>
<section class="at-a-glance"><h2>At a glance</h2>
<div class="glance-section">What's working: you run Claude Code as a disciplined delivery pipeline — a task goes in with acceptance criteria, Claude reads before it writes, runs the affected suites, and reports numbers. Your habit of asking for a before/after measurement on anything performance-adjacent (the ingest benchmark, the LCP budget) keeps regressions from slipping in unnoticed, and the canvas review loop for UI placement decisions cut a whole round of screenshot-and-describe back-and-forth.</div>
</section>
<section class="narrative"><h2>Narrative</h2>
<p>Most sessions follow the same shape: a one-paragraph ask, a short read of the code involved, a plan stated in two or three sentences, then edits and a test run. The plan-before-edit step is where you intervene most, and it pays off — sessions with an explicit plan finished in fewer turns and were far less likely to need a follow-up correction.</p>
<p>The friction that remains is mostly environmental: a suite that is slow to start, a Redis that is not running locally, a migration that needed a manual step. When those hit, you tend to fix the environment yourself and re-prompt rather than let Claude flail, which is the right call.</p>
</section>
<section class="big-wins">
<div class="big-win"><div class="big-win-title">Tests before claims</div><div class="big-win-desc">Every completed task this period ended with a real test run and a quoted pass count. Zero "it should work" endings — a change from June, when a third of sessions closed without a run.</div></div>
<div class="big-win"><div class="big-win-title">Measured performance changes</div><div class="big-win-desc">The dedupe work and the CDN cutover both shipped with before/after numbers in the transcript. You asked for the benchmark; Claude produced it unprompted the second time.</div></div>
<div class="big-win"><div class="big-win-title">Visual decisions on the canvas</div><div class="big-win-desc">Three UI placement questions were settled by rendering options to the canvas and annotating, instead of describing layouts in prose. Each closed in one review round.</div></div>
</section>
<section class="friction">
<div class="friction-category"><div class="friction-title">Local services not running</div><div class="friction-desc">Six sessions stalled on a Redis or Postgres that was not up. A pre-flight check in the config's post-command would remove this entirely.</div></div>
<div class="friction-category"><div class="friction-title">Long test cold-starts</div><div class="friction-desc">The gateway's unit suite takes 40 s to boot; you often re-ran a single file to save time, then had to run the full suite anyway.</div></div>
<div class="friction-category"><div class="friction-title">Re-explaining conventions</div><div class="friction-desc">Test placement and the no-inline-style rule were restated in four sessions before they were saved as memory. Both are now remembered.</div></div>
</section>
<section class="features">
<div class="feature-card"><div class="feature-title">Memory</div><div class="feature-oneliner">Persistent notes Claude reads at the start of every session.</div><div class="feature-why">Your conventions are stable and specific — exactly what memory is for. The two rules you kept re-explaining are the ones that should have been saved first.</div></div>
<div class="feature-card"><div class="feature-title">Agent Canvas</div><div class="feature-oneliner">Render mockups and annotate them in place.</div><div class="feature-why">You already use it for placement decisions; try it for the a11y audit — a marked-up screenshot beats a bullet list of element ids.</div></div>
<div class="feature-card"><div class="feature-title">Post-command hooks</div><div class="feature-oneliner">Run a check every time a session starts.</div><div class="feature-why">A ten-line script that pings Redis and Postgres would have saved six sessions this month.</div></div>
</section>
<section class="patterns">
<div class="pattern-card"><div class="pattern-title">Read → plan → edit → test</div><div class="pattern-summary">Your dominant session shape, and your most successful one.</div><div class="pattern-detail">Sessions that skipped the plan step needed a correction turn 2.4× as often.</div></div>
<div class="pattern-card"><div class="pattern-title">Numbers in every summary</div><div class="pattern-summary">Pass counts, line counts, benchmark deltas.</div><div class="pattern-detail">You ask for them; Claude now offers them. Keep it.</div></div>
</section>
<section class="horizon"><div class="horizon-card"><div class="horizon-title">Next month</div><div class="horizon-possible">With the environment pre-flight in place and conventions in memory, the remaining friction is test speed. A watch-mode runner for the gateway suite is the single highest-leverage change available.</div></div></section>
</body></html>`,
  kpis: {
    period: { start: '2026-07-20', end: '2026-08-18', days: 30 },
    summary: {
      improvements: [
        'Sessions ending with a real test run went from 66% to 100% — every completed task this period quoted a pass count.',
        'Correction turns per session fell from 1.9 to 0.7 as the read → plan → edit → test shape became the default.',
        'Three UI placement decisions closed in a single canvas review round each, versus two to three prose rounds in July.',
        'Memory now covers test placement and the no-inline-style rule; neither was re-explained after 2026-08-06.',
      ],
      regressions: [
        'Six sessions stalled on a local Redis or Postgres that was not running (up from two).',
        'Median time-to-first-edit rose from 48 s to 71 s, almost entirely the gateway suite\'s 40 s cold start.',
        'Two sessions were abandoned mid-migration and resumed the next day without a handoff note.',
      ],
      suggestions: [
        'Add a post-command to the gateway and pipeline configs that checks Redis/Postgres before Claude starts.',
        'Run the gateway unit suite in watch mode during a session; reserve the full cold run for the final check.',
        'Ask for a resume prompt before stepping away from any session that touched a migration.',
      ],
    },
    kpis: {
      Volume: {
        sessions: { value: 128, label: 'Sessions', format: 'number', goodDirection: 'up' },
        messages: { value: 1912, label: 'Messages', format: 'number', goodDirection: 'neutral' },
        toolCalls: { value: 4380, label: 'Tool calls', format: 'number', goodDirection: 'neutral' },
      },
      Outcomes: {
        successRate: { value: 0.87, label: 'Mostly or Fully Achieved Rate', format: 'percent', goodDirection: 'up' },
        testedRate: { value: 1.0, label: 'Ended with a test run', format: 'percent', goodDirection: 'up' },
      },
      Friction: {
        retryRate: { value: 0.09, label: 'Retry Rate', format: 'percent', goodDirection: 'down' },
        envStalls: { value: 6, label: 'Environment stalls', format: 'number', goodDirection: 'down' },
        medianFirstEdit: { value: 71, label: 'Median time to first edit (s)', format: 'duration', goodDirection: 'down' },
      },
    },
    lists: {
      tools: [{ name: 'Read', count: 1412 }, { name: 'Edit', count: 903 }, { name: 'Bash', count: 871 }, { name: 'Grep', count: 512 }, { name: 'Write', count: 388 }],
      languages: [{ name: 'TypeScript', count: 96 }, { name: 'Python', count: 24 }, { name: 'SQL', count: 8 }],
    },
  },
}

// ── Canvas: the promo-field placement mock + a submitted review ────────────
const CANVAS = {
  canvasId: '9f1c4a2b7d3e5068a1b2c3d4',
  sessionKey: SESSIONS[0].id,
  title: 'Promo field placement',
  reviews: {
    // R1 was submitted against v2; the agent addressed a1 (rendered v3), a2 and a3 remain open.
    submittedAt: '09:52',
    notes: [
      { id: 'a1', scope: 'element', uxId: 'option-a-apply', label: 'button "Apply"', note: 'On A the Apply button sits outside the field — put it inside, right-aligned, like the search box.', state: 'addressed', bbox: { x: 88, y: 402, width: 84, height: 36 } },
      { id: 'a2', scope: 'element', uxId: 'option-b-link', label: 'link "Have a promo code?"', note: 'B hides the field behind a link — fine, but the link should look like a link, not a button.', state: 'open', bbox: { x: 560, y: 356, width: 190, height: 24 } },
      { id: 'a3', scope: 'general', note: 'Leaning towards B with A\'s inline validation. Show me B expanded with an invalid code as v4.', state: 'open' },
    ],
  },
}

function canvasHtml(version) {
  // v1: options A and B; v2: A, B, C; v3: A fixed (Apply inside the field).
  const applyInside = version >= 3
  const optionC = version >= 2
  const field = (id, inside) => inside
    ? `<div class="field inside" data-ux-id="${id}-field"><input value="SUMMER10" data-ux-id="${id}-input"><button data-ux-id="${id}-apply">Apply</button></div>`
    : `<div class="row" data-ux-id="${id}-field"><input value="SUMMER10" data-ux-id="${id}-input"><button class="outside" data-ux-id="${id}-apply">Apply</button></div>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>Promo field placement</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#11111b;color:#cdd6f4;font:15px/1.5 Inter,Segoe UI,system-ui,sans-serif;padding:36px 44px}
h1{font-size:22px;margin:0 0 6px;font-weight:600}
p.lead{color:#a6adc8;margin:0 0 28px;max-width:70ch}
.grid{display:grid;grid-template-columns:repeat(${optionC ? 3 : 2},1fr);gap:24px}
.opt{background:#181825;border:1px solid #313244;border-radius:12px;padding:18px}
.opt h2{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#7f849c;margin:0 0 14px}
.card{background:#1e1e2e;border:1px solid #313244;border-radius:10px;padding:16px}
.line{display:flex;justify-content:space-between;color:#a6adc8;padding:6px 0;border-bottom:1px solid #313244}
.line.total{color:#cdd6f4;font-weight:600;border:0;padding-top:12px}
.line.disc{color:#a6e3a1}
.row{display:flex;gap:8px;margin:12px 0}
.row input,.field input{flex:1;background:#11111b;border:1px solid #45475a;border-radius:8px;color:#cdd6f4;padding:9px 12px;font:inherit}
button{background:#cba6f7;color:#11111b;border:0;border-radius:8px;padding:9px 14px;font:inherit;font-weight:600}
button.outside{background:#313244;color:#cdd6f4}
.field.inside{display:flex;align-items:center;background:#11111b;border:1px solid #45475a;border-radius:8px;margin:12px 0;padding:3px 3px 3px 0}
.field.inside input{border:0;background:transparent}
.field.inside button{padding:7px 12px}
a.link{color:#89b4fa;text-decoration:underline;display:inline-block;margin:12px 0}
a.link.buttonish{background:#313244;color:#cdd6f4;text-decoration:none;padding:8px 12px;border-radius:8px}
.modal{margin:12px 0;border:1px dashed #585b70;border-radius:10px;padding:12px;color:#a6adc8;font-size:13px}
.err{color:#f38ba8;font-size:13px;margin-top:6px}
.note{margin-top:22px;color:#a6adc8;font-size:14px;max-width:80ch}
.pill{display:inline-block;background:#313244;border-radius:999px;padding:2px 10px;font-size:12px;color:#a6adc8;margin-left:8px}
</style></head><body>
<h1 data-ux-id="title">Promo field placement <span class="pill">v${version}</span></h1>
<p class="lead" data-ux-id="lead">Three ways to put promo-code entry into the checkout summary. Same hook, same validation; only the placement changes. Each column is the real Summary at 360px.</p>
<div class="grid">
<section class="opt" data-ux-id="option-a"><h2>A — inline field</h2><div class="card">
<div class="line"><span>Linen shirt × 1</span><span>£48.00</span></div>
<div class="line"><span>Canvas tote × 2</span><span>£36.00</span></div>
<div class="line"><span>Shipping</span><span>£4.50</span></div>
${field('option-a', applyInside)}
<div class="line disc" data-ux-id="option-a-discount"><span>Promo SUMMER10</span><span>−£8.40</span></div>
<div class="line total"><span>Total</span><span>£80.10</span></div>
</div></section>
<section class="opt" data-ux-id="option-b"><h2>B — behind a link</h2><div class="card">
<div class="line"><span>Linen shirt × 1</span><span>£48.00</span></div>
<div class="line"><span>Canvas tote × 2</span><span>£36.00</span></div>
<div class="line"><span>Shipping</span><span>£4.50</span></div>
<a class="link buttonish" href="#" data-ux-id="option-b-link">Have a promo code?</a>
<div class="line total"><span>Total</span><span>£88.50</span></div>
</div></section>
${optionC ? `<section class="opt" data-ux-id="option-c"><h2>C — modal</h2><div class="card">
<div class="line"><span>Linen shirt × 1</span><span>£48.00</span></div>
<div class="line"><span>Canvas tote × 2</span><span>£36.00</span></div>
<div class="line"><span>Shipping</span><span>£4.50</span></div>
<div class="modal" data-ux-id="option-c-modal">Opens a small dialog: code field, Apply, and the validation message. Keeps the summary short; costs a click.</div>
<div class="line total"><span>Total</span><span>£88.50</span></div>
</div></section>` : ''}
</div>
<p class="note" data-ux-id="note"><strong>Validation</strong> is identical in all three: on blur, 300 ms debounce, inline error under the field, and the discount row animates in once the API accepts the code. ${applyInside ? 'A now has the Apply button inside the field, right-aligned, per the review.' : ''}</p>
</body></html>`
}

// ── Statusline payload for a live session ──────────────────────────────────
// The shape the app's own statusline bridge writes to {ResourcesDir}/status/
// <sessionId>.json (StatuslineData, src/shared/types.ts). Shared by seed.js
// (pre-written so cards light up at once) and fake-claude.js (kept fresh).
function statusFor(session, nowMs, homeDir, drift) {
  const a = ACCOUNTS.find((x) => x.key === session.accountKey)
  const c = CONFIGS.find((x) => x.id === session.configKey)
  const st = session.status
  const d = drift || { seconds: 0, ctxPlus: 0 }
  const sessionReset = new Date(nowMs + a.sessionResetsInMin * MIN).toISOString()
  const weeklyReset = new Date(nowMs + a.weeklyResetsInDays * DAY).toISOString()
  const sev = (p, warn, danger) => (p >= danger ? 'danger' : p >= warn ? 'warning' : 'normal')
  const ctx = Math.min(99, st.ctxPct + d.ctxPlus)
  const slug = c.workingDirectory.replace(/[^A-Za-z0-9]/g, '-')
  return {
    sessionId: session.id,
    model: st.model, modelId: st.modelId, effortLevel: session.effort, fastMode: false,
    contextUsedPercent: ctx, contextRemainingPercent: 100 - ctx, contextWindowSize: st.ctxWindow,
    inputTokens: st.inTok + Math.round(d.seconds * 38), outputTokens: st.outTok + Math.round(d.seconds * 4),
    costUsd: Math.round((st.cost + d.seconds * 0.0011) * 100) / 100,
    totalDurationMs: st.durMs + d.seconds * 1000, linesAdded: st.added, linesRemoved: st.removed,
    accountEmail: a.email,
    rateLimitCurrent: a.buckets.session, rateLimitCurrentResets: sessionReset,
    rateLimitWeekly: a.buckets.weekly, rateLimitWeeklyResets: weeklyReset,
    usageBuckets: [
      { key: 'session:', label: '5h', group: 'session', percent: a.buckets.session, resetsAt: sessionReset, severity: sev(a.buckets.session, 70, 90) },
      { key: 'weekly_all:', label: 'Weekly', group: 'weekly', percent: a.buckets.weekly, resetsAt: weeklyReset, severity: sev(a.buckets.weekly, 60, 90) },
      { key: 'weekly_model:Fable', label: 'Fable', group: 'weekly', percent: a.buckets.model, resetsAt: weeklyReset, severity: sev(a.buckets.model, 60, 90) },
    ],
    transcriptPath: `${homeDir.replace(/\//g, '\\')}\\.claude\\projects\\${slug}\\${session.resumeUuid}.jsonl`,
    timestamp: nowMs,
  }
}

module.exports = {
  DAY, HOUR, MIN,
  ACCOUNTS, SECTIONS, GROUPS, CONFIGS, SESSIONS, ACTIVE_SESSION_ID,
  SCENARIOS, CODEX, history, CODEX_HISTORY, MEMORY, PAD_TITLES, INSIGHTS, CANVAS, canvasHtml, statusFor,
}
