import { useCommandStore } from '../stores/commandStore'

/**
 * The one-row command bar, explained once (#382, ADR-018). Shown to existing
 * users on the first launch after the upgrade (sinceVersion = the release it
 * ships in, so `stepsNewSince` picks it up) and to fresh installs in the full
 * flow. One line per change, the same shape as the What's New page: less
 * text, grouped, so the eye can find the part it cares about.
 */
interface Item {
  title: string
  desc: string
}

const ROWS: { heading: string; items: Item[] }[] = [
  {
    heading: 'What moved',
    items: [
      { title: 'One row.', desc: 'Tools, then your Global buttons, then this config\'s Session buttons. Two terminal lines come back.' },
      { title: 'Add is first.', desc: 'A labelled button at the left; its arrow adds a section or a note, and reviews buttons that need a look.' },
      { title: 'Notes are a tool.', desc: 'The encrypted notes left the header for a lock with a count; click it for the list.' },
    ],
  },
  {
    heading: 'What it now tells you',
    items: [
      { title: 'Where a button runs.', desc: 'A small mark before each cluster: the agent, the partner shell, the browser — and "this PC" on an SSH session.' },
      { title: 'Which agent.', desc: 'A Codex session says Codex; a terminal-only session hides what it cannot do and dims Logs with the reason.' },
      { title: 'What does not fit.', desc: 'Folds into "N more" per band — Global first, Session last, pinned never. Or pick two rows in Settings.' },
    ],
  },
  {
    heading: 'What you can do',
    items: [
      { title: 'Drag.', desc: 'Reorder along a band, drop on a section, or drop on the other band — that one asks first.' },
      { title: 'Right-click anything.', desc: 'Every button, tool, section and band has a menu that says what it is; a tool can be hidden, here or everywhere.' },
      { title: 'One settings page.', desc: 'Settings → Custom Commands: the row, hidden tools, Snap, and a plain list of every button.' },
    ],
  },
]

export function CommandBarStep({ onNext, onBack }: { onNext: () => void; onBack?: () => void }) {
  // Existing buttons that clash with the new model were tagged on this launch
  // (never changed) -- tell the user how many and where to look.
  const reviewCount = useCommandStore((s) => s.commands.filter((c) => c.needsReview?.length).length)
  const count = ROWS.reduce((n, r) => n + r.items.length, 0)
  return (
    <>
      <div className="p2">
        <div className="p2-inner" style={{ width: 'min(920px, 95vw)' }}>
          <h2 className="h2" data-ux-id="commandbar-heading">The command bar is one row</h2>
          <p className="p2-sub" data-ux-id="commandbar-sub">
            {count} things to know, in one line each. Nothing you had was changed without asking.
          </p>

          <div className="wn-sections" data-ux-id="commandbar-sections">
            {ROWS.map((s) => (
              <section key={s.heading} data-ux-id={`section-${s.heading.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
                <h3 className="wn-sec-h">{s.heading}</h3>
                {s.items.map((it) => (
                  <div className="wn-item" key={it.title}>
                    <span className="wn-dot" />
                    <div>
                      <span className="wn-t">{it.title}</span>{' '}
                      <span className="wn-d">{it.desc}</span>
                    </div>
                  </div>
                ))}
              </section>
            ))}
          </div>

          <p className="gh-freebie" data-ux-id="commandbar-review" data-review-count={reviewCount}>
            {reviewCount > 0 ? (
              <>
                <b>{reviewCount} of your existing button{reviewCount === 1 ? '' : 's'} carr{reviewCount === 1 ? 'ies' : 'y'} an amber mark</b> — an argument that looks like a secret, a Global prompt your terminal-only configs cannot run, a dissolved "Global" section, or a shell button on an SSH config. Nothing was changed: open <b>Add ▾ → Review {reviewCount} command{reviewCount === 1 ? '' : 's'}</b> on the bar, or <b>Settings → Custom Commands → Needs review</b>, and fix or keep each one.
              </>
            ) : (
              <>
                Your existing buttons all fit the new model — nothing to review. The detail lives in <b>Feature Guide → What&apos;s New</b>, any time.
              </>
            )}
          </p>
        </div>
      </div>
      <div className="foot">
        {onBack ? <button className="back" onClick={onBack} type="button">← Back</button> : <span className="hint">Right-click anything on the bar to learn what it does.</span>}
        <button className="cta" onClick={onNext} type="button" data-ux-id="commandbar-cta">
          Continue →
        </button>
      </div>
    </>
  )
}
