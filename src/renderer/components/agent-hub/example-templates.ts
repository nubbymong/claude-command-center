// Click-to-prefill example tasks shown on the Cloud Agents first-run state. Each
// opens the New Agent dialog with the name + prompt filled in (the project is
// still required). Kept here so the copy lives in one editable place.

export type ExampleIcon = 'refactor' | 'tests' | 'audit'

export interface AgentExample {
  id: string
  name: string
  description: string
  icon: ExampleIcon
}

export const AGENT_EXAMPLES: AgentExample[] = [
  {
    id: 'refactor',
    name: 'Refactor a module',
    description: 'Refactor [module] for readability and smaller functions. Keep behaviour identical; note any risks.',
    icon: 'refactor',
  },
  {
    id: 'tests',
    name: 'Write missing tests',
    description: 'Find code with no test coverage and write focused unit tests for the most important gaps.',
    icon: 'tests',
  },
  {
    id: 'audit',
    name: 'Audit dependencies',
    description: 'Audit dependencies for known CVEs and outdated majors. List findings with severity and a suggested fix.',
    icon: 'audit',
  },
]
