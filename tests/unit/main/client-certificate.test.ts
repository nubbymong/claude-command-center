/**
 * [host] No request the app makes presents a client certificate without the
 * user's choice, and the app offers none: a main-process `net` request
 * (webContents null; the in-app browser's URL check, webview-manager.ts
 * checkUrl) and a page in any window or view (a webContents) alike are
 * answered with no certificate, whatever the store holds. Each refusal is
 * logged once per server per run, by its host and port alone, as Electron
 * names the server (`host:port`, an IPv6 address in brackets). Nothing real
 * is requested.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { parse } from '@babel/parser'

const logged = vi.hoisted(() => [] as string[])
vi.mock('../../../src/main/debug-logger', () => {
  const log = (...a: unknown[]): void => { logged.push(a.map(String).join(' ')) }
  return { logInfo: log, logWarn: log, logError: log, logDebug: log }
})

const CC = await import('../../../src/main/client-certificate')
const { selectClientCertificate, installClientCertificatePolicy } = CC

beforeEach(() => {
  logged.length = 0
  CC._resetClientCertificateLogForTest()
})

type Statement = ReturnType<typeof parse>['program']['body'][number]
type ImportDeclaration = Extract<Statement, { type: 'ImportDeclaration' }>
/** Just enough of an expression node to follow a call or member chain. */
type Link = { type: string; name?: string; callee?: unknown; object?: unknown; property?: { type: string; name?: string } }

/** The statement lists a module runs as it loads: its top level, and the branches of an if and plain blocks in them; never a function body. */
function loadTimeBlocks(body: Statement[], out: Statement[][] = []): Statement[][] {
  out.push(body)
  for (const s of body) {
    if (s.type === 'IfStatement') {
      for (const branch of [s.consequent, s.alternate]) {
        if (branch) loadTimeBlocks(branch.type === 'BlockStatement' ? branch.body : [branch], out)
      }
    } else if (s.type === 'BlockStatement') loadTimeBlocks(s.body, out)
  }
  return out
}

const CERT = { subjectName: 'CN=me', issuerName: 'CN=corp', fingerprint: 'sha256/x' } as unknown as Electron.Certificate

const CERT2 = { subjectName: 'CN=me-too', issuerName: 'CN=other', fingerprint: 'sha256/y' } as unknown as Electron.Certificate

/** One request as Electron hands it over: the server it asked, named `host:port`
 *  (App::SelectClientCertificate passes the request's host and port, not a URL). */
function answer(webContents: unknown, certificates: Electron.Certificate[] = [CERT], url = 'typed.example:443') {
  const event = { preventDefault: vi.fn() }
  const callback = vi.fn()
  selectClientCertificate(event, webContents as Electron.WebContents | null, url, certificates, callback)
  return { event, callback }
}

/** Prevented once, and answered once with no certificate. */
function expectNoCertificate({ event, callback }: ReturnType<typeof answer>): void {
  expect(event.preventDefault).toHaveBeenCalledTimes(1)
  expect(callback).toHaveBeenCalledTimes(1)
  expect(callback.mock.calls[0]).toEqual([])
}

describe('select-client-certificate: no request presents a client certificate', () => {
  it('a main-process net request (webContents null) presents no certificate: the default is prevented and the callback gets none', () => {
    const { event, callback } = answer(null)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0]).toEqual([])
  })

  it('a page request presents no client certificate: a request with a webContents is prevented and answered with none, exactly once', () => {
    expectNoCertificate(answer({ id: 7 }))
    expectNoCertificate(answer({ id: 7 }, []))
    expectNoCertificate(answer({ id: 8 }, [CERT, CERT2]))
  })

  it('a page request and a main-process request to a host already refused are refused again, every time', () => {
    for (let i = 0; i < 3; i++) {
      expectNoCertificate(answer({ id: 9 }, [CERT], 'idp.example:443'))
      expectNoCertificate(answer(null, [CERT], 'idp.example:443'))
    }
  })

  it('a refused request is logged by the server Electron names (host and port), once per server per run', () => {
    answer({ id: 7 }, [CERT], 'client.example:443')
    answer(null, [CERT], 'client.example:443')
    answer({ id: 7 }, [CERT], '10.0.0.1:443')
    answer({ id: 8 }, [CERT], '[::1]:8443')
    answer({ id: 8 }, [CERT], '[::1]:8443')
    answer(null, [CERT], 'Other.Example:8443')
    const lines = logged.filter((l) => l.includes('certificate'))
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('client.example:443 asked')
    expect(lines[1]).toContain('10.0.0.1:443 asked')
    expect(lines[2]).toContain('[::1]:8443 asked')
    expect(lines[3]).toContain('other.example:8443 asked')
    for (const l of lines) expect(l).not.toMatch(/\(no host\)|\(unparseable\)|\(unprintable host\)|CN=/)
  })

  it('past the logging bound one line says more servers were refused, and every request is still refused', () => {
    for (let i = 0; i < 200; i++) expectNoCertificate(answer({ id: 7 }, [CERT], `h${i}.example:443`))
    expectNoCertificate(answer({ id: 7 }, [CERT], 'h200.example:443'))
    expectNoCertificate(answer(null, [CERT], 'h201.example:443'))
    const lines = logged.filter((l) => l.includes('certificate'))
    expect(lines).toHaveLength(201)
    expect(lines[199]).toContain('h199.example:443 asked')
    expect(lines[200]).toMatch(/more servers asked for a client certificate; none was sent/)
    expect(lines.join('\n')).not.toMatch(/h20[01]\.example/)
  })

  it('a URL, should one be given, is logged by its host only, once per host per run', () => {
    answer({ id: 7 }, [CERT], 'https://login.idp.example:8443/sso/start?ticket=VALUE-ONE#frag-two')
    answer({ id: 7 }, [CERT], 'https://login.idp.example:8443/other/path?x=VALUE-THREE')
    answer(null, [CERT], 'https://second.example/a?b=VALUE-FOUR')
    const lines = logged.filter((l) => l.includes('certificate'))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('login.idp.example:8443')
    expect(lines[1]).toContain('second.example')
    for (const l of lines) expect(l).not.toMatch(/VALUE|frag|\/sso|\/other|\/a|\?|#|CN=/)
  })

  it('a URL that does not parse is still refused, and logged without it', () => {
    expectNoCertificate(answer({ id: 7 }, [CERT], 'not a url VALUE-FIVE'))
    expect(logged.join(' ')).not.toContain('VALUE')
  })

  it('installs the handler on app select-client-certificate', () => {
    const on = vi.fn()
    installClientCertificatePolicy({ on })
    expect(on).toHaveBeenCalledWith('select-client-certificate', selectClientCertificate)
  })

  it('the main process installs it at startup, before the app is ready (index.ts, a statement that runs as the module loads)', () => {
    // Read from index.ts's syntax tree, not its text: a call in a comment or a
    // string is not a statement, and one inside a function runs only if that
    // function is called.
    const src = fs.readFileSync(path.join(__dirname, '../../../src/main/index.ts'), 'utf8')
    const program = parse(src, { sourceType: 'module', plugins: ['typescript'] }).program
    const imports = program.body.filter((s): s is ImportDeclaration => s.type === 'ImportDeclaration')
    const named = (from: string, name: string) => imports.some((d) => d.source.value === from && d.importKind !== 'type'
      && d.specifiers.some((sp) => sp.type === 'ImportSpecifier' && sp.importKind !== 'type' && sp.local.name === name
        && sp.imported.type === 'Identifier' && sp.imported.name === name))
    expect(named('./client-certificate', 'installClientCertificatePolicy')).toBe(true)
    expect(named('electron', 'app')).toBe(true)

    const install = (s: Statement) => s.type === 'ExpressionStatement' && s.expression.type === 'CallExpression'
      && s.expression.callee.type === 'Identifier' && s.expression.callee.name === 'installClientCertificatePolicy'
      && s.expression.arguments.length === 1 && s.expression.arguments[0].type === 'Identifier' && s.expression.arguments[0].name === 'app'
    const whenReady = (s: Statement) => {
      if (s.type !== 'ExpressionStatement') return false
      let e = s.expression as Link
      for (;;) {
        if (e.type === 'CallExpression') e = e.callee as Link
        else if (e.type === 'MemberExpression') {
          const o = e.object as Link
          if (o.type === 'Identifier' && o.name === 'app' && e.property?.type === 'Identifier' && e.property.name === 'whenReady') return true
          e = o
        } else return false
      }
    }
    const placed = loadTimeBlocks(program.body).some((block) => {
      const at = block.findIndex(install)
      return at >= 0 && block.slice(at + 1).some(whenReady)
    })
    expect(placed, 'installClientCertificatePolicy(app) runs as index.ts loads, before app.whenReady() in the same block').toBe(true)
  })
})
