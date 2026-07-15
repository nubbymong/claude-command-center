import { describe, it, expect } from 'vitest'
import { ToolIndex, slugifyServer, tokenize } from '../../../../src/main/mcp-proxy/tool-index'
import type { AggregatedTool } from '../../../../src/main/mcp-proxy/supervisor'

function agg(
  upstreamId: string,
  upstreamName: string,
  name: string,
  description?: string,
  inputSchema?: unknown,
): AggregatedTool {
  return { upstreamId, upstreamName, tool: { name, description, inputSchema } }
}

describe('slugifyServer', () => {
  it('lowercases and collapses non-alphanumerics', () => {
    expect(slugifyServer('My Server!')).toBe('my_server')
    expect(slugifyServer('  GitHub-API  ')).toBe('github_api')
    expect(slugifyServer('***')).toBe('server')
  })
})

describe('tokenize', () => {
  it('splits snake_case and camelCase', () => {
    expect(tokenize('read_file')).toEqual(['read', 'file'])
    expect(tokenize('readFile')).toEqual(['read', 'file'])
  })
})

describe('namespacing + resolve', () => {
  it('exposes server__tool and maps back to the routing target', () => {
    const idx = new ToolIndex([agg('u1', 'Filesystem', 'read_file', 'Read a file')])
    expect(idx.all()[0].name).toBe('filesystem__read_file')
    expect(idx.resolve('filesystem__read_file')).toEqual({ upstreamId: 'u1', toolName: 'read_file' })
    expect(idx.resolve('nope__x')).toBeNull()
  })

  it('disambiguates colliding server slugs by upstream', () => {
    const idx = new ToolIndex([
      agg('u1', 'My Server', 'a'),
      agg('u2', 'My  Server', 'b'), // slugs to the same base
    ])
    const names = idx.all().map((r) => r.name)
    expect(new Set(names)).toEqual(new Set(['my_server__a', 'my_server_2__b']))
    // u1 keeps the base slug, u2 gets the numeric suffix
    expect(idx.resolve('my_server__a')).toEqual({ upstreamId: 'u1', toolName: 'a' })
    expect(idx.resolve('my_server_2__b')).toEqual({ upstreamId: 'u2', toolName: 'b' })
  })

  it('keeps a stable slug across multiple tools of one upstream', () => {
    const idx = new ToolIndex([agg('u1', 'FS', 'a'), agg('u1', 'FS', 'b')])
    expect(idx.all().map((r) => r.name)).toEqual(['fs__a', 'fs__b'])
  })
})

describe('describe', () => {
  it('returns full detail incl. inputSchema, or null', () => {
    const schema = { type: 'object', properties: { path: { type: 'string', description: 'file path' } } }
    const idx = new ToolIndex([agg('u1', 'FS', 'read_file', 'Read a file', schema)])
    const d = idx.describe('fs__read_file')
    expect(d).toMatchObject({ toolName: 'read_file', server: 'FS', inputSchema: schema })
    expect(idx.describe('missing')).toBeNull()
  })
})

describe('search (BM25)', () => {
  const tools = [
    agg('u1', 'Filesystem', 'read_file', 'Read the contents of a file from disk'),
    agg('u1', 'Filesystem', 'write_file', 'Write contents to a file on disk'),
    agg('u2', 'GitHub', 'create_issue', 'Open a new issue on a repository', {
      type: 'object',
      properties: { title: { type: 'string', description: 'issue title' } },
    }),
    agg('u2', 'GitHub', 'list_pull_requests', 'List open pull requests'),
  ]
  const idx = new ToolIndex(tools)

  it('ranks the most relevant tool first', () => {
    const hits = idx.search('read file')
    expect(hits[0].name).toBe('filesystem__read_file')
  })

  it('matches on argument names/descriptions from the schema', () => {
    const hits = idx.search('issue title')
    expect(hits[0].name).toBe('github__create_issue')
  })

  it('filters by server (slug or display name)', () => {
    const bySlug = idx.search('file', { server: 'filesystem' })
    expect(bySlug.every((r) => r.name.startsWith('filesystem__'))).toBe(true)
    const byName = idx.search('', { server: 'GitHub' })
    expect(byName.every((r) => r.server === 'GitHub')).toBe(true)
  })

  it('respects the limit and returns compact one-line rows', () => {
    const hits = idx.search('file', { limit: 1 })
    expect(hits).toHaveLength(1)
    expect(hits[0].description.length).toBeLessThanOrEqual(200)
    expect(hits[0].description).not.toContain('\n')
  })

  it('empty query returns tools in insertion order up to the limit', () => {
    expect(idx.search('', { limit: 2 }).map((r) => r.name)).toEqual([
      'filesystem__read_file',
      'filesystem__write_file',
    ])
  })

  it('returns nothing for a term absent from the corpus', () => {
    expect(idx.search('kubernetes')).toEqual([])
  })

  it('is deterministic for equal scores (tie-break by name)', () => {
    const a = new ToolIndex(tools).search('disk')
    const b = new ToolIndex(tools).search('disk')
    expect(a).toEqual(b)
  })
})
