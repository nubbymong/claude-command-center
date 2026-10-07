// Keyframes for the attention pulse (sidebar rows, tab dots) and the insights
// pulse dot, injected once into <head>. Lifted out of Sidebar.tsx (2.1.1): it
// had a twin in TabBar.tsx that lacked the insights-pulse rules, and both
// shared this element id, so which CSS landed depended on Sidebar mounting
// first (it always did). This is the union; both call sites use it now.
const ATTENTION_STYLES_ID = 'attention-pulse-styles'

// The attention overlay is the session's identity colour painted UNDER the card
// or tab text, so its strength and the text colours drawn over it decide whether
// they stay readable. Both are held to 4.5:1 for every identity colour in both
// themes by tests/unit/renderer/token-contrast.test.ts, which reads these.

/** The pulse's strongest opacity. */
export const ATTENTION_PULSE_PEAK = 0.16
/** What the overlay shows when its animation does not run (reduced motion, a
 *  capture with animations disabled): a quiet tint, never the bare colour. */
export const ATTENTION_PULSE_REST = 0.1

export function injectAttentionStyles(): void {
  if (document.getElementById(ATTENTION_STYLES_ID)) return
  const style = document.createElement('style')
  style.id = ATTENTION_STYLES_ID
  style.textContent = `
    @keyframes attention-pulse {
      0%, 100% { opacity: 0; }
      50% { opacity: ${ATTENTION_PULSE_PEAK}; }
    }
    .attention-pulse-bg {
      opacity: ${ATTENTION_PULSE_REST};
      animation: attention-pulse 2s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .attention-pulse-bg { animation: none; opacity: ${ATTENTION_PULSE_REST}; }
    }
    @keyframes insights-pulse {
      0%, 100% { opacity: 0.5; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.2); }
    }
    .insights-pulse-dot {
      animation: insights-pulse 1.5s ease-in-out infinite;
    }
  `
  document.head.appendChild(style)
}
