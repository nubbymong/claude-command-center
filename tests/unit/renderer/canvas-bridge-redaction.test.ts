// @vitest-environment jsdom
// Which field values reach the agent, and which are replaced by "(redacted)".
//
// This is a two-sided property and the suite used to test only one side of it,
// with a single `type="password"` assertion. Both sides matter:
//
//   - A missed secret is permanent. A snapshot goes verbatim into the model's
//     context and from there into transcripts.
//   - An over-eager redaction is not "safe". Field values are primary evidence
//     in a design review; when the heuristic matched `key` inside `keywords`
//     and `card` inside "Card title" it redacted 20 of 23 ordinary fields, and
//     a card-authoring form could not be reviewed at all.
//
// So the tables below are the guard: every entry names the rule it exists for,
// and the false-positive table is as load-bearing as the false-negative one.
//
// These drive the BUNDLED bridge — the same string ccc-ux:// serves — through
// the measurement-only path (jsdom cannot run axe).

import { describe, it, expect, beforeAll } from 'vitest'
import { bridgeRequest, installBridge, stubLayout } from './canvas-bridge-harness'
import type { CanvasSnapshotResult, SnapshotNode } from '../../../src/shared/canvas'

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

/** Render one field and report what its value looked like on the wire. */
async function fieldValue(markup: string): Promise<string | undefined> {
  document.body.innerHTML = `<form data-test-box="0,0,400,200">${markup}</form>`
  const reply = await bridgeRequest('snapshot', { analysis: false })
  expect(reply.ok, reply.error).toBe(true)
  const nodes = flatten((reply.result as CanvasSnapshotResult).root)
  const field = nodes.find((n) => n.uxId === 'subject')
  expect(field, `no node with data-ux-id="subject" in the snapshot`).toBeDefined()
  return field!.state?.value
}

const BOX = 'data-test-box="0,10,300,32" data-ux-id="subject"'

beforeAll(() => {
  stubLayout()
  installBridge()
})

describe('values that must never reach the agent', () => {
  const SECRET = 'CORRECT-HORSE-BATTERY-STAPLE'
  const cases: Array<[string, string]> = [
    ['input type=password', `<input ${BOX} type="password" value="${SECRET}" />`],
    ['input type=hidden', `<input ${BOX} type="hidden" value="${SECRET}" />`],

    // The autocomplete tokens whose entire purpose is to say "this is payment
    // or credential data". A hand-rolled name="cardNumber" was redacted while
    // the spec-compliant attribute handed over a live card number.
    ['autocomplete=cc-number', `<input ${BOX} autocomplete="cc-number" value="4111111111111111" />`],
    ['autocomplete=cc-csc', `<input ${BOX} autocomplete="cc-csc" value="737" />`],
    ['autocomplete=one-time-code', `<input ${BOX} autocomplete="one-time-code" value="483920" />`],
    ['autocomplete=current-password', `<input ${BOX} autocomplete="current-password" value="${SECRET}" />`],
    ['autocomplete=new-password', `<input ${BOX} autocomplete="new-password" value="${SECRET}" />`],

    // The accessible name, the placeholder and the visible label: the three
    // most common ways to identify a secret field without naming it one.
    ['aria-label names a secret', `<input ${BOX} aria-label="API secret" value="${SECRET}" />`],
    ['placeholder names a secret', `<input ${BOX} placeholder="Recovery phrase" value="${SECRET}" />`],
    ['wrapping label names a secret', `<label>Card number<input ${BOX} value="4111111111111111" /></label>`],

    // Content that is a credential whatever the field is called — the backstop
    // for a key pasted into a bare textarea.
    [
      'PEM private key in a textarea',
      `<textarea ${BOX}>-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA</textarea>`,
    ],
    ['API key shaped value', `<input ${BOX} name="notes" value="sk-abcdefghij0123456789xyz" />`],
    ['GitHub token shaped value', `<input ${BOX} name="notes" value="ghp_abcdefghij0123456789ABCD" />`],
    ['Slack token shaped value', `<input ${BOX} name="notes" value="xoxb-1234567890-abcdefgh" />`],

    // Field names, in the conventions a page actually uses.
    ['name=apiKey', `<input ${BOX} name="apiKey" value="${SECRET}" />`],
    ['name=api_key', `<input ${BOX} name="api_key" value="${SECRET}" />`],
    ['name=APIKey', `<input ${BOX} name="APIKey" value="${SECRET}" />`],
    ['name=cardNumber', `<input ${BOX} name="cardNumber" value="4111111111111111" />`],
    ['name=pin', `<input ${BOX} name="pin" value="4821" />`],
    ['name=authToken', `<input ${BOX} name="authToken" value="${SECRET}" />`],
    ['name=seedPhrase', `<input ${BOX} name="seedPhrase" value="${SECRET}" />`],
    ['id=passwd', `<input ${BOX} id="passwd" value="${SECRET}" />`],
    ['name=routingNumber', `<input ${BOX} name="routingNumber" value="026009593" />`],
    ['name=ssn', `<input ${BOX} name="ssn" value="123-45-6789" />`],
    ['name=cvv', `<input ${BOX} name="cvv" value="737" />`],

    // A one-word label IS a field name. These are the risky words allowed back
    // into prose, and only when the surface is nothing but the word.
    ['label is exactly "PIN"', `<label>PIN<input ${BOX} value="4821" /></label>`],
    ['aria-label is exactly "Key"', `<input ${BOX} aria-label="Key" value="${SECRET}" />`],
    ['label is exactly "Token"', `<label>Token<input ${BOX} value="${SECRET}" /></label>`],
  ]

  it.each(cases)('redacts %s', async (_label, markup) => {
    expect(await fieldValue(markup)).toBe('(redacted)')
  })
})

describe('values that must still reach the agent', () => {
  // Every one of these was redacted by the unbounded-substring heuristic.
  const cases: Array<[string, string, string]> = [
    ['name=keywords ("key")', `<input ${BOX} name="keywords" value="design, ux" />`, 'design, ux'],
    ['label "Card title" ("card")', `<label>Card title<input ${BOX} value="Q3 roadmap" /></label>`, 'Q3 roadmap'],
    ['aria-label "Pin to top" ("pin")', `<input ${BOX} aria-label="Pin to top" value="yes" />`, 'yes'],
    ['name=authorName ("auth")', `<input ${BOX} name="authorName" value="Ada" />`, 'Ada'],
    [
      'placeholder "Search by keyword" ("key")',
      `<input ${BOX} placeholder="Search by keyword" value="canvas" />`,
      'canvas',
    ],
    ['name=cardTitle ("card")', `<input ${BOX} name="cardTitle" value="Welcome" />`, 'Welcome'],
    ['label "Passenger name" ("pass")', `<label>Passenger name<input ${BOX} value="Ada" /></label>`, 'Ada'],
    ['name=compassHeading ("pass")', `<input ${BOX} name="compassHeading" value="270" />`, '270'],
    ['aria-label "Private message" ("private")', `<input ${BOX} aria-label="Private message" value="hi" />`, 'hi'],
    [
      'placeholder "Enter a phrase" ("phrase")',
      `<input ${BOX} placeholder="Enter a phrase to search" value="canvas" />`,
      'canvas',
    ],
    ['name=seedData ("seed")', `<input ${BOX} name="seedData" value="42" />`, '42'],
    ['name=discardDraft ("card")', `<input ${BOX} name="discardDraft" value="no" />`, 'no'],
    ['name=accountName', `<input ${BOX} name="accountName" value="Acme" />`, 'Acme'],
    ['name=email', `<input ${BOX} name="email" type="email" value="nick@example.com" />`, 'nick@example.com'],
    ['label "Sort order" ("sort")', `<label>Sort order<input ${BOX} value="newest" /></label>`, 'newest'],
    ['name=tokenizerMode ("token")', `<input ${BOX} name="tokenizerMode" value="bpe" />`, 'bpe'],
    // The other side of the one-word rule: a sentence containing the word is
    // not a field name, however the word is capitalised.
    ['label "Keyboard shortcut"', `<label>Keyboard shortcut<input ${BOX} value="ctrl+k" /></label>`, 'ctrl+k'],
    ['placeholder "Token bucket size"', `<input ${BOX} placeholder="Token bucket size" value="64" />`, '64'],
    ['aria-label "Pass to reviewer"', `<input ${BOX} aria-label="Pass to reviewer" value="Ada" />`, 'Ada'],
  ]

  it.each(cases)('keeps %s', async (_label, markup, expected) => {
    expect(await fieldValue(markup)).toBe(expected)
  })
})

describe('what the redaction pass costs the page', () => {
  it('does not re-scan a page-sized label for every control under it', async () => {
    // The identifying surfaces have no length limit and the page writes all of
    // them. Deciding "is this a secret?" rewrites its input three times and
    // then matches several patterns against it, PER CONTROL — so one big label
    // over many controls is quadratic work, synchronous, on the page's own
    // thread, where neither capture timeout can fire because both are timers
    // on the blocked thread.
    document.body.innerHTML = `<label data-test-box="0,0,400,4000">${'lorem ipsum dolor sit amet '.repeat(20_000)}${Array.from(
      { length: 400 },
      (_, i) => `<input data-test-box="0,${i},300,32" value="v${i}" />`,
    ).join('')}</label>`
    const started = Date.now()
    const reply = await bridgeRequest('snapshot', { analysis: false }, 60_000)
    expect(reply.ok, reply.error).toBe(true)
    // Measured: 2,417 ms unbounded, 240 ms with the surface clamp.
    expect(Date.now() - started).toBeLessThan(1200)
  }, 60_000)

  it('gives every control under one label that label’s text', async () => {
    // The label's text is memoised per label, so two controls under one label
    // must both see it — the failure mode of a badly keyed cache is that only
    // the first one does.
    document.body.innerHTML = `<form data-test-box="0,0,400,200"><label>Card number
        <input data-test-box="0,10,300,32" data-ux-id="first" value="4111111111111111" />
        <input data-test-box="0,50,300,32" data-ux-id="second" value="4222222222222222" />
      </label></form>`
    const reply = await bridgeRequest('snapshot', { analysis: false })
    expect(reply.ok, reply.error).toBe(true)
    const nodes = flatten((reply.result as CanvasSnapshotResult).root)
    expect(nodes.find((n) => n.uxId === 'first')?.state?.value).toBe('(redacted)')
    expect(nodes.find((n) => n.uxId === 'second')?.state?.value).toBe('(redacted)')
  })
})
