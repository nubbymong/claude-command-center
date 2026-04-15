import { create } from 'zustand'
import type { AgentTemplate, AgentModelOverride } from '../types/electron'

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

  getUserTemplates: () => AgentTemplate[]
  getBuiltInTemplates: () => AgentTemplate[]
  getAllTemplates: () => AgentTemplate[]
}

function saveTemplates(templates: AgentTemplate[]): void {
  window.electronAPI.config.save('agentTemplates', templates)
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
    const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
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

  getUserTemplates: () => get().templates,
  getBuiltInTemplates: () => BUILTIN_TEMPLATES,
  getAllTemplates: () => [...get().templates, ...BUILTIN_TEMPLATES],
}))
