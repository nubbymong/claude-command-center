// @vitest-environment jsdom
// What a form field's CONTENTS do on the way to the agent: nothing. They stop
// at the page.
//
// This file replaces a table of ~50 cases that asked "does the heuristic
// recognise this field as secret?". Two adversarial rounds answered that
// question badly in both directions — round 4 found the matcher redacted 20 of
// 23 ordinary fields, round 5 found it missed `apikey`, `billing cc-csc`,
// `<label for>`-labelled password fields, `github_pat_…`, every 2FA and
// recovery code, and every non-English word for "password". Both rounds were
// right, because recognising every way a human might name a secret, across
// languages, spellings and separators, is not a thing a regex does.
//
// So the question changed. A field's contents are never carried, and the tests
// below are about the ABSENCE of a path rather than the accuracy of a guess:
// there is nothing left to recognise, so there is nothing left to get wrong.
//
// The cases are kept — every one is a real leak round 5 demonstrated — because
// a table that lists what USED to escape is the clearest statement of what this
// property is for.

import { describe, it, expect, beforeAll } from 'vitest'
import { bridgeRequest, installBridge, stubLayout } from './canvas-bridge-harness'
import { sanitizeSnapshotResult } from '../../../src/shared/canvas-snapshot-sanitize'
import { serializeSnapshot } from '../../../src/shared/canvas-snapshot-serialize'
import type { CanvasSnapshotResult, SnapshotNode } from '../../../src/shared/canvas'

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

/** Render markup and return BOTH the sanitised node and the text the agent
 *  actually receives — a field's contents must be absent from both, and the
 *  serialized form is the one that catches a leak through some other token. */
async function capture(markup: string): Promise<{ field?: SnapshotNode; text: string }> {
  document.body.innerHTML = `<form data-test-box="0,0,400,200">${markup}</form>`
  const reply = await bridgeRequest('snapshot', { analysis: false })
  expect(reply.ok, reply.error).toBe(true)
  const clean = sanitizeSnapshotResult(reply.result, undefined, { scoped: true })
  const text = serializeSnapshot({
    versionId: 'v1',
    capturedAt: '2026-08-12T00:00:00Z',
    viewport: clean.viewport,
    root: clean.root,
  }).text
  return { field: flatten(clean.root).find((n) => n.uxId === 'subject'), text }
}

const BOX = 'data-test-box="0,10,300,32" data-ux-id="subject"'
const SECRET = 'CORRECT-HORSE-BATTERY-STAPLE'

beforeAll(() => {
  stubLayout()
  installBridge()
})

describe('a field never carries what the user typed', () => {
  // Every row is a field whose contents used to reach the agent's context, or
  // (the last few) one whose contents used to be wrongly withheld. The
  // distinction no longer exists, which is the point.
  const cases: Array<[string, string]> = [
    // --- structural: these were always caught -------------------------------
    ['input type=password', `<input ${BOX} type="password" value="${SECRET}" />`],
    ['input type=hidden', `<input ${BOX} type="hidden" value="${SECRET}" />`],

    // --- round 5: no separator, so no word boundary was ever produced -------
    ['name=apikey', `<input ${BOX} name="apikey" value="${SECRET}" />`],
    ['name=APIKEY', `<input ${BOX} name="APIKEY" value="${SECRET}" />`],
    ['name=cardnumber', `<input ${BOX} name="cardnumber" value="4111111111111111" />`],
    ['name=privatekey', `<input ${BOX} name="privatekey" value="${SECRET}" />`],
    ['name=authtoken', `<input ${BOX} name="authtoken" value="${SECRET}" />`],

    // --- round 5: the accessible name was never read -----------------------
    ['label for= says Password', `<label for="pw">Password</label><input ${BOX} id="pw" value="${SECRET}" />`],
    ['aria-labelledby says Password', `<span id="l">Password</span><input ${BOX} aria-labelledby="l" value="${SECRET}" />`],
    ['title says Password', `<input ${BOX} title="Password" value="${SECRET}" />`],

    // --- round 5: the spec-legal autocomplete prefix defeated the anchor ----
    ['autocomplete="billing cc-csc"', `<input ${BOX} autocomplete="billing cc-csc" value="737" />`],
    ['autocomplete="shipping cc-number"', `<input ${BOX} autocomplete="shipping cc-number" value="4111111111111111" />`],
    ['autocomplete=cc-csc', `<input ${BOX} autocomplete="cc-csc" value="737" />`],

    // --- round 5: token formats the content matcher did not know -----------
    ['a fine-grained GitHub PAT', `<input ${BOX} name="notes" value="github_pat_11ABCDEFG0abcdefghijKLMNOP" />`],
    ['an AWS access key id', `<input ${BOX} name="notes" value="AKIAIOSFODNN7EXAMPLE" />`],
    ['a JWT', `<input ${BOX} name="notes" value="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl" />`],
    // A textarea holds its value as a child text NODE and a contenteditable
    // holds whatever was typed into it, so both reached the agent as the node's
    // accessible name long after the value itself stopped being carried. This
    // was found by asserting against the whole serialized snapshot rather than
    // against the field, which is the only reason it was found at all.
    ['a PEM key in a textarea', `<textarea ${BOX}>-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA</textarea>`],
    ['a secret typed into a textarea', `<textarea ${BOX}>${SECRET}</textarea>`],
    ['a secret typed into a contenteditable', `<div ${BOX} contenteditable="true">${SECRET}</div>`],
    ['a bare contenteditable', `<div ${BOX} contenteditable>${SECRET}</div>`],

    // --- round 5: 2FA / recovery / session, all type=text in the real world -
    ['name=verificationCode', `<input ${BOX} name="verificationCode" value="483920" />`],
    ['name=recoveryCode', `<input ${BOX} name="recoveryCode" value="${SECRET}" />`],
    ['name=otp1 (split-digit OTP)', `<input ${BOX} name="otp1" value="4" />`],
    ['name=securityAnswer', `<input ${BOX} name="securityAnswer" value="Rosebud" />`],
    ['name=sessionId', `<input ${BOX} name="sessionId" value="${SECRET}" />`],

    // --- round 5: not English ----------------------------------------------
    ['name=motDePasse', `<input ${BOX} name="motDePasse" value="${SECRET}" />`],
    ['name=wachtwoord', `<input ${BOX} name="wachtwoord" value="${SECRET}" />`],
    ['name=kennwort', `<input ${BOX} name="kennwort" value="${SECRET}" />`],

    // --- round 5: the matcher and the model read different strings ----------
    ['a fullwidth label', `<label>Ｐａｓｓｗｏｒｄ<input ${BOX} value="${SECRET}" /></label>`],
    ['a Cyrillic homoglyph label', `<label>Pаssword<input ${BOX} value="${SECRET}" /></label>`],
    ['an identifying word past 4096 chars', `<label>${'x'.repeat(4200)}Password<input ${BOX} value="${SECRET}" /></label>`],

    // --- and the fields that were wrongly WITHHELD, which also stop here ----
    ['name=keywords', `<input ${BOX} name="keywords" value="${SECRET}" />`],
    ['label "Card title"', `<label>Card title<input ${BOX} value="${SECRET}" /></label>`],
    ['name=email', `<input ${BOX} name="email" type="email" value="${SECRET}" />`],
  ]

  it.each(cases)('holds back the contents of %s', async (_label, markup) => {
    const { field, text } = await capture(markup)
    expect(field, 'the field should still be in the tree').toBeDefined()
    // The two that matter, and the second is the load-bearing one: the value
    // must be absent from the WHOLE serialized snapshot, not merely from the
    // field where it would obviously have been.
    expect(JSON.stringify(field)).not.toContain(SECRET)
    expect(text).not.toContain(SECRET)
    // ...and not through any of the other real values used above either.
    for (const secret of ['4111111111111111', '737', 'github_pat_', 'AKIAIOSFODNN7EXAMPLE', 'eyJhbGciOi', 'BEGIN RSA', '483920', 'Rosebud']) {
      expect(text, `leaked via ${secret}`).not.toContain(secret)
    }
  })
})

describe('what a review gets instead', () => {
  it('reports how much the field holds, so overflow is still reviewable', async () => {
    const { field, text } = await capture(`<input ${BOX} name="title" value="${'a'.repeat(140)}" />`)
    expect(field?.state?.valueLength).toBe(140)
    expect(text).toContain('[chars=140]')
  })

  it('says nothing at all for an empty field', async () => {
    const { field } = await capture(`<input ${BOX} name="title" value="" />`)
    expect(field?.state?.valueLength).toBeUndefined()
  })

  it('still shows everything that IDENTIFIES the field', async () => {
    // The label, the placeholder and the accessible name are page-authored text
    // written for a human to read, and they are what makes a review possible.
    // They are not withheld — only what the user typed is.
    const { field } = await capture(
      `<label for="cvv">Security code</label><input ${BOX} id="cvv" placeholder="3 digits" value="737" />`,
    )
    expect(field?.name).toBe('Security code')
    expect(field?.state?.type).toBe('text')
  })

  it('bounds a page-claimed length instead of trusting it', async () => {
    const clean = sanitizeSnapshotResult({
      root: {
        role: 'document',
        name: '',
        box: {},
        state: { type: 'text', valueLength: 9e15 },
        children: [],
      },
    })
    expect(clean.root.state?.valueLength).toBe(1_000_000)
  })

  it('drops a length that is not a number rather than coercing it', async () => {
    // The one field that used to carry page text now carries a count, so the
    // only way back in would be for a non-number to survive. It does not.
    for (const valueLength of ['(redacted) but actually ' + SECRET, {}, [], NaN, Infinity, -5, true]) {
      const clean = sanitizeSnapshotResult({
        root: { role: 'document', name: '', box: {}, state: { type: 'text', valueLength }, children: [] },
      })
      expect(clean.root.state?.valueLength, `valueLength=${JSON.stringify(valueLength)}`).toBeUndefined()
    }
  })
})
