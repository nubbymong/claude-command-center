import { create } from 'zustand'
import type { AgentTemplate, AgentModelOverride } from '../types/electron'
import { generateId } from '../utils/id'
import { saveConfigNow } from '../utils/config-saver'

// ── Built-in Templates ──

export const BUILTIN_TEMPLATES: AgentTemplate[] = [
  {
    id: 'builtin-code-reviewer',
    name: 'code-reviewer',
    description: 'Review code for bugs, logic errors, security vulnerabilities, and code quality issues',
    prompt: 'You are a senior code reviewer. Analyze the code for bugs, logic errors, security vulnerabilities, performance issues, and adherence to best practices. Provide specific, actionable feedback with file paths and line numbers.',
    model: 'inherit' as AgentModelOverride,
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    isBuiltIn: true,
  },
  {
    id: 'builtin-test-runner',
    name: 'test-runner',
    description: 'Run tests, analyze failures, and suggest fixes',
    prompt: 'You are a testing specialist. Run the project test suite, analyze any failures, identify root causes, and suggest specific fixes. Report test coverage gaps if detectable.',
    model: 'inherit' as AgentModelOverride,
    tools: ['Read', 'Bash', 'Glob', 'Grep'],
    isBuiltIn: true,
  },
  {
    id: 'builtin-security-auditor',
    name: 'security-auditor',
    description: 'Scan for OWASP vulnerabilities and security issues',
    prompt: 'You are a security auditor. Scan the codebase for OWASP Top 10 vulnerabilities including injection flaws, broken authentication, sensitive data exposure, XSS, and insecure configurations. Provide severity ratings and remediation steps.',
    model: 'inherit' as AgentModelOverride,
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    isBuiltIn: true,
  },
  {
    id: 'builtin-doc-writer',
    name: 'doc-writer',
    description: 'Generate documentation for code, APIs, and architecture',
    prompt: 'You are a technical writer. Generate clear, comprehensive documentation including API references, architecture overviews, usage examples, and inline code comments. Follow the existing documentation style of the project.',
    model: 'inherit' as AgentModelOverride,
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    isBuiltIn: true,
  },
  {
    id: 'builtin-performance-optimizer',
    name: 'performance-optimizer',
    description: 'Analyze and optimize code performance',
    prompt: 'You are a performance engineer. Identify performance bottlenecks, memory leaks, unnecessary computations, and inefficient algorithms. Suggest concrete optimizations with benchmarks where possible.',
    model: 'inherit' as AgentModelOverride,
    tools: ['Read', 'Bash', 'Glob', 'Grep', 'Edit'],
    isBuiltIn: true,
  },
]

// ── Store ──

interface AgentLibraryState {
  templates: AgentTemplate[]
  isLoaded: boolean

  hydrate: (templates: AgentTemplate[]) => void
  addTemplate: (template: AgentTemplate) => void
  updateTemplate: (id: string, updates: Partial<AgentTemplate>) => void
  removeTemplate: (id: string) => void
  duplicateTemplate: (id: string) => AgentTemplate | undefined

  // No getter methods here on purpose (#442): a method building a fresh array
  // per call, used inside a zustand selector, fails Object.is and re-renders
  // for ever — under React 19 that is an update-depth throw that took the
  // whole window down. Select `templates` and derive with useMemo, appending
  // the module const BUILTIN_TEMPLATES where the built-ins are wanted.
}

// Through config-saver, never straight to the IPC: config-saver is where the
// write latch lives (a failed config READ must never become a WRITE), plus the
// retry and the health marking. A direct `config.save` here bypassed all
// three -- one Agent Library action under "your configuration could not be
// loaded" replaced agent-templates.json with the single new entry (ADR-009
// pass, beta.16). A test now bans direct `config.save` calls outside the two
// places that own the latch.
function saveTemplates(templates: AgentTemplate[]): void {
  saveConfigNow('agentTemplates', templates)
}

export const useAgentLibraryStore = create<AgentLibraryState>((set, get) => ({
  templates: [],
  isLoaded: false,

  hydrate: (templates: AgentTemplate[]) => {
    set({ templates: templates || [], isLoaded: true })
  },

  addTemplate: (template: AgentTemplate) => {
    set(state => {
      const templates = [...state.templates, template]
      saveTemplates(templates)
      return { templates }
    })
  },

  updateTemplate: (id: string, updates: Partial<AgentTemplate>) => {
    set(state => {
      const templates = state.templates.map(t => t.id === id ? { ...t, ...updates } : t)
      saveTemplates(templates)
      return { templates }
    })
  },

  removeTemplate: (id: string) => {
    set(state => {
      const templates = state.templates.filter(t => t.id !== id)
      saveTemplates(templates)
      return { templates }
    })
  },

  duplicateTemplate: (id: string) => {
    const state = get()
    const all = [...state.templates, ...BUILTIN_TEMPLATES]
    const original = all.find(t => t.id === id)
    if (!original) return undefined
    const newId = generateId()
    const copy: AgentTemplate = {
      ...original,
      id: newId,
      name: original.name + '-copy',
      isBuiltIn: undefined,
    }
    const templates = [...state.templates, copy]
    saveTemplates(templates)
    set({ templates })
    return copy
  },

}))
