---
name: react-typescript
description: React 18 + TypeScript development patterns for Electron renderer process. Covers hooks, context providers, component architecture, Tailwind CSS styling, and xterm.js terminal components. Invoke when working on renderer UI code.
---

# React + TypeScript for Electron Renderer

You are an expert React 18 + TypeScript developer building Electron renderer UIs with Tailwind CSS.

## Architecture Patterns

### Component Structure
```
renderer/
├── App.tsx              # Root, holds config state, session management
├── components/          # UI components
├── hooks/               # Custom hooks (terminal, IPC, config, grid)
├── contexts/            # React contexts (config, session state)
└── lib/                 # Utilities, types, constants
```

### Context Pattern for IPC State
```typescript
// ConfigContext: Wraps config load/save via window.api IPC
// SessionContext: Holds runtime state (status, context%, metrics) per session
// Both update via IPC events from main process

const SessionContext = createContext<SessionContextType>(null!)

function SessionProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = useState<Map<string, SessionState>>(new Map())

  useEffect(() => {
    // Listen for main→renderer IPC events
    window.api.onSessionStatus((id, status) => {
      setSessions(prev => {
        const next = new Map(prev)
        const state = next.get(id) ?? defaultState()
        next.set(id, { ...state, status })
        return next
      })
    })
  }, [])

  return <SessionContext.Provider value={{ sessions }}>{children}</SessionContext.Provider>
}
```

### Dynamic Grid Layout
```typescript
// Grid adapts to session count:
// 1→1x1, 2→2x1, 3→3x1, 4→2x2, 5→3x2, 6→3x2, ...up to 5x4
function calculateGrid(count: number): { cols: number; rows: number } {
  if (count <= 3) return { cols: count, rows: 1 }
  if (count <= 4) return { cols: 2, rows: 2 }
  // ... see grid-calculator.ts for full algorithm
}

// CSS Grid container
<div style={{
  display: 'grid',
  gridTemplateColumns: `repeat(${cols}, 1fr)`,
  gridTemplateRows: `repeat(${rows}, 1fr)`,
  gap: '2px'
}}>
```

### Terminal Component Pattern
```typescript
function TerminalPanel({ sessionId, config }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  // 1. Wait for container dimensions
  // 2. Create Terminal instance
  // 3. Open in container
  // 4. Connect to PTY via IPC
  // 5. Handle resize with FitAddon

  // IMPORTANT: Cleanup on unmount
  useEffect(() => {
    return () => {
      termRef.current?.dispose()
      window.api.killPty(sessionId)
    }
  }, [sessionId])
}
```

## Tailwind CSS in Electron

### Setup
```css
/* globals.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Dark theme base */
body {
  @apply bg-[#0a0a1a] text-gray-200;
}
```

### Common Patterns
```tsx
{/* Panel with color-coded border */}
<div className="border-l-4 bg-gray-900 rounded" style={{ borderColor: config.color }}>

{/* Status dot */}
<div className={`w-2.5 h-2.5 rounded-full ${statusColors[status]}`} />

{/* Compact badge */}
<span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
  CPU: 12%
</span>

{/* Context progress bar */}
<div className="h-1 rounded-full bg-gray-700 overflow-hidden">
  <div className="h-full transition-all" style={{ width: `${pct}%`, background: gradient }} />
</div>
```

## Type Safety

### Window API Types
```typescript
// In renderer lib/types.ts
declare global {
  interface Window {
    api: IpcApi
  }
}

// In shared/types.ts
export interface IpcApi {
  spawnPty(sessionId: string, config: SessionConfig): Promise<void>
  writePty(sessionId: string, data: string): void
  resizePty(sessionId: string, cols: number, rows: number): void
  killPty(sessionId: string): void
  onPtyData(callback: (sessionId: string, data: string) => void): void
  onPtyExit(callback: (sessionId: string, exitCode: number) => void): void
  // ... more IPC methods
}
```

## Performance Tips
- Memoize expensive components with `React.memo()`
- Use `useCallback` for event handlers passed as props
- Debounce terminal resize events (100-200ms)
- Batch state updates when processing multiple IPC events
- Use `will-change: transform` for animated elements
- Avoid re-rendering all panels when one session updates
