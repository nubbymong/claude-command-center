import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain .mjs helper script, no type declarations by design
import { REQUIRED_FIELDS, buildPayload, validatePayload, describeDescriptionPathProblem } from '../../scripts/file-advisory.mjs'

// #207. Filing a private advisory cost five failed API calls and a wrong diagnosis
// because the payload was hand-built and omitted `vulnerabilities[]` and
// `cvss_vector_string`. The endpoint answers that with:
//
//     500 Internal Server Error, Content-Length: 0
//
// NOT a 422 naming the field — so it reads as an outage. These tests keep the
// required-field list enforced by CI rather than by memory.

const BASE = { summary: 'A one-line summary', description: 'Detail.', functions: ['fnA'] }

describe('buildPayload', () => {
  it('fills in every field the endpoint requires', () => {
    const payload = buildPayload(BASE)
    for (const field of REQUIRED_FIELDS) {
      expect(payload[field], field).toBeDefined()
    }
    expect(validatePayload(payload)).toEqual([])
  })

  it('defaults the fields that are easy to forget', () => {
    const payload = buildPayload(BASE)
    expect(payload.cvss_vector_string).toMatch(/^CVSS:3\.1\//)
    expect(payload.cwe_ids).toHaveLength(1)
    expect(payload.vulnerabilities[0].package.ecosystem).toBe('other')
    expect(payload.vulnerabilities[0].vulnerable_version_range).toBeTruthy()
    // Requesting the private fork is the default: the fix must be developed there,
    // never on a branch of the public repo.
    expect(payload.start_private_fork).toBe(true)
  })

  it('honours --no-fork', () => {
    expect(buildPayload({ ...BASE, fork: false }).start_private_fork).toBe(false)
  })
})

describe('validatePayload', () => {
  it('names each missing required field, and says WHY it matters', () => {
    for (const field of REQUIRED_FIELDS) {
      const payload = buildPayload(BASE)
      delete payload[field]
      const problems = validatePayload(payload)
      expect(problems.join(' '), field).toContain(`"${field}"`)
      expect(problems.join(' '), field).toMatch(/500/)
    }
  })

  it('treats an empty array or blank string as missing', () => {
    expect(validatePayload({ ...buildPayload(BASE), cwe_ids: [] }).join(' ')).toContain('cwe_ids')
    expect(validatePayload({ ...buildPayload(BASE), vulnerabilities: [] }).join(' ')).toContain('vulnerabilities')
    expect(validatePayload({ ...buildPayload(BASE), summary: '   ' }).join(' ')).toContain('summary')
  })

  it('rejects a malformed CVSS vector and a malformed CWE id', () => {
    expect(validatePayload({ ...buildPayload(BASE), cvss_vector_string: 'high' }).join(' ')).toMatch(/CVSS:3\.1/)
    expect(validatePayload({ ...buildPayload({ ...BASE, cwe: 'sqli' }) }).join(' ')).toContain('not a CWE id')
    expect(validatePayload(buildPayload({ ...BASE, cwe: 'CWE-22' }))).toEqual([])
    expect(validatePayload(buildPayload({ ...BASE, cwe: 'CWE-noinfo' }))).toEqual([])
  })

  it('rejects an over-long summary', () => {
    expect(validatePayload(buildPayload({ ...BASE, summary: 'x'.repeat(1025) })).join(' ')).toContain('max 1024')
  })

  it('rejects a vulnerabilities entry missing its package name or version range', () => {
    const p1 = buildPayload(BASE)
    p1.vulnerabilities[0].package.name = ''
    expect(validatePayload(p1).join(' ')).toContain('package.name')
    const p2 = buildPayload(BASE)
    p2.vulnerabilities[0].vulnerable_version_range = ''
    expect(validatePayload(p2).join(' ')).toContain('vulnerable_version_range')
  })
})

describe('describeDescriptionPathProblem — the embargo, enforced', () => {
  const repo = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo'
  const inside = (p: string) => (process.platform === 'win32' ? `C:\\work\\repo\\${p}` : `/work/repo/${p}`)
  const outside = process.platform === 'win32' ? 'C:\\Users\\me\\sec\\desc.md' : '/home/me/sec/desc.md'

  it('rejects a description written inside the repo', () => {
    // CONTEXT.d/ is the specific trap: it feels like a scratch notebook and is a
    // tracked file, so a repro written there is a disclosure.
    for (const p of ['CONTEXT.d/2026-01-01-note.md', 'docs/finding.md', 'desc.md', 'architecture/decisions/x.md']) {
      const problem = describeDescriptionPathProblem(inside(p), repo)
      expect(problem, p).toBeTruthy()
      expect(problem, p).toMatch(/public|publication/i)
    }
  })

  it('accepts a description outside the repo', () => {
    expect(describeDescriptionPathProblem(outside, repo)).toBeNull()
  })

  it('is not fooled by a sibling directory that shares a prefix', () => {
    const sibling = process.platform === 'win32' ? 'C:\\work\\repo-notes\\desc.md' : '/work/repo-notes/desc.md'
    expect(describeDescriptionPathProblem(sibling, repo)).toBeNull()
  })
})
