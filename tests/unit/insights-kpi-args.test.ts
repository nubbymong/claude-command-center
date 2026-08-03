import { describe, it, expect } from 'vitest'
import { buildKpiSpawnArgs } from '../../src/main/insights-runner'

// Unit 3 W1: the headless KPI extraction is read-only (it reads one archived
// HTML report). It must NOT pass --dangerously-skip-permissions — `-p` already
// skips the workspace-trust dialog and --allowedTools Read pre-authorizes the
// only tool it needs (verified on the VM: an out-of-cwd absolute Read succeeds
// with no permission denials and no dangerous flag).
//
// #191 follow-up added the two context-suppression flags. A headless `claude -p`
// loads the account's whole mirrored global config — measured on a real profile:
// 10 MCP servers and 41 skills. A real 4-account run carried 192,852 context
// tokens per extraction against a ~31k payload, at $0.77 a call. Measured with an
// identical trivial prompt: 41,714 tokens of overhead with --strict-mcp-config,
// 14,395 with --tools Read as well.
describe('buildKpiSpawnArgs', () => {
  it('builds a read-only print-JSON invocation with context suppression', () => {
    expect(buildKpiSpawnArgs()).toEqual([
      '-p',
      '--strict-mcp-config',
      '--tools',
      'Read',
      '--allowedTools',
      'Read',
      '--output-format',
      'json'
    ])
  })

  it('never includes --dangerously-skip-permissions', () => {
    expect(buildKpiSpawnArgs()).not.toContain('--dangerously-skip-permissions')
  })

  it('restricts tools to Read only', () => {
    const args = buildKpiSpawnArgs()
    const idx = args.indexOf('--allowedTools')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('Read')
  })

  it('loads no MCP servers', () => {
    const args = buildKpiSpawnArgs()
    expect(args).toContain('--strict-mcp-config')
    // No --mcp-config beside it: that is what makes the flag load zero servers.
    expect(args).not.toContain('--mcp-config')
  })

  it('unloads the unused built-in tool schemas, which --allowedTools does not', () => {
    // --allowedTools gates the permission prompt; --tools decides which tool
    // DEFINITIONS enter context. Both are needed and they do different jobs —
    // ~27k tokens of the measured overhead was tool schemas alone.
    const args = buildKpiSpawnArgs()
    const idx = args.indexOf('--tools')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('Read')
  })

  it('passes no empty or spaced argument, which shell:true would silently drop', () => {
    // spawnClaudeHeadless uses shell:true, so argv is concatenated unquoted. An
    // empty or space-bearing value vanishes and the preceding flag swallows the
    // next one — which is why --settings '{...}' cannot be added here yet.
    for (const arg of buildKpiSpawnArgs()) {
      expect(arg.length).toBeGreaterThan(0)
      expect(arg).not.toMatch(/\s/)
    }
  })
})
