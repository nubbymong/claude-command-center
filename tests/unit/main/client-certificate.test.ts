/**
 * [host] A main-process `net` request (webContents null) gets no client
 * certificate, as on Electron 43, where such a request failed with
 * ERR_SSL_CLIENT_AUTH_CERT_NEEDED. The app's one `net` caller probes whatever
 * URL the user typed into the in-app browser (webview-manager.ts checkUrl).
 * Nothing real is requested.
 */
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { parse } from '@babel/parser'
import { selectClientCertificate, installClientCertificatePolicy } from '../../../src/main/client-certificate'

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

function answer(webContents: unknown) {
  const event = { preventDefault: vi.fn() }
  const callback = vi.fn()
  selectClientCertificate(event, webContents as Electron.WebContents | null, 'https://typed.example/', [CERT], callback)
  return { event, callback }
}

describe('select-client-certificate: a main-process net request presents no certificate', () => {
  it('a main-process net request (webContents null) presents no certificate: the default is prevented and the callback gets none', () => {
    const { event, callback } = answer(null)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0]).toEqual([])
  })

  it('a request with a WebContents is not answered by this handler', () => {
    const { event, callback } = answer({ id: 7 })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
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
