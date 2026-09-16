// Keyframes for the attention pulse (sidebar rows, tab dots) and the insights
// pulse dot, injected once into <head>. Lifted out of Sidebar.tsx (2.1.1): it
// had a twin in TabBar.tsx that lacked the insights-pulse rules, and both
// shared this element id, so which CSS landed depended on Sidebar mounting
// first (it always did). This is the union; both call sites use it now.
const ATTENTION_STYLES_ID = 'attention-pulse-styles'

export function injectAttentionStyles(): void {
  if (document.getElementById(ATTENTION_STYLES_ID)) return
  const style = document.createElement('style')
  style.id = ATTENTION_STYLES_ID
  style.textContent = `
    @keyframes attention-pulse {
      0%, 100% { opacity: 0; }
      50% { opacity: 0.35; }
    }
    .attention-pulse-bg {
      animation: attention-pulse 2s ease-in-out infinite;
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
