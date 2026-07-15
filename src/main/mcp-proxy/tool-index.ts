/**
 * Conductor Proxy — tool index + search (T3, #95).
 *
 * Turns the supervisor's aggregated upstream tools into a searchable index so
 * the LLM discovers tools on demand (via the search_tools meta-tool, T4) instead
 * of every upstream tool definition being loaded into context up front.
 *
 * Pure + deterministic: `new ToolIndex(aggregatedTools)` builds an immutable
 * snapshot; the proxy rebuilds it (cheap) whenever the supervisor emits a
 * change. Search is a small self-contained BM25 over each tool's name +
 * description + argument names + argument descriptions — no native deps, no
 * model, no I/O. Semantic/embedding search is deferred (see epic non-goals).
 *
 * Namespacing: tools are exposed as `server__tool`. The index owns the
 * authoritative map from a namespaced name back to (upstreamId, toolName), so
 * routing (T4 call_tool) is always correct even when two servers slug alike —
 * collisions are disambiguated with a numeric suffix at build time.
 */

import type { AggregatedTool } from './supervisor'

/** A compact search hit — the only per-tool payload put in the LLM's context
 *  by search_tools. The full input schema is fetched separately via describe. */
export interface ToolSearchRow {
  /** `server__tool` namespaced identifier — pass this to call_tool/describe_tool. */
  name: string
  /** Human server label (the upstream's display name). */
  server: string
  /** One-line description (first line, length-capped). */
  description: string
}

/** Everything the index knows about one tool. */
export interface IndexedTool {
  namespacedName: string
  server: string
  upstreamId: string
  toolName: string
  description: string
  inputSchema?: unknown
}

const DEFAULT_LIMIT = 10
const ONE_LINE_MAX = 200
const NAMESPACE_SEP = '__'

// BM25 params — standard defaults.
const K1 = 1.5
const B = 0.75

/** Slugify an upstream display name into the `server` half of `server__tool`.
 *  Lowercase; runs of non-alphanumerics collapse to a single underscore; edges
 *  trimmed. Empty result falls back to 'server'. */
export function slugifyServer(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug.length > 0 ? slug : 'server'
}

function firstLine(desc: string | undefined): string {
  if (!desc) return ''
  const line = desc.split('\n')[0].trim()
  return line.length > ONE_LINE_MAX ? line.slice(0, ONE_LINE_MAX - 1) + '…' : line
}

/** Tokenize into lowercased alphanumeric terms. camelCase and snake_case both
 *  split so `read_file` / `readFile` both match "read" and "file". */
export function tokenize(text: string): string[] {
  if (!text) return []
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

/** Pull argument names + descriptions out of a JSON-Schema-ish inputSchema.
 *  Defensive: any non-object shape yields no terms. */
function schemaTerms(inputSchema: unknown): string[] {
  if (!inputSchema || typeof inputSchema !== 'object') return []
  const props = (inputSchema as Record<string, unknown>).properties
  if (!props || typeof props !== 'object') return []
  const terms: string[] = []
  for (const [argName, argDef] of Object.entries(props as Record<string, unknown>)) {
    terms.push(...tokenize(argName))
    if (argDef && typeof argDef === 'object') {
      const desc = (argDef as Record<string, unknown>).description
      if (typeof desc === 'string') terms.push(...tokenize(desc))
    }
  }
  return terms
}

interface Doc {
  tool: IndexedTool
  terms: string[]
  tf: Map<string, number>
  len: number
}

export class ToolIndex {
  private readonly docs: Doc[] = []
  private readonly byName = new Map<string, IndexedTool>()
  private readonly df = new Map<string, number>() // document frequency per term
  private readonly avgLen: number

  constructor(tools: AggregatedTool[]) {
    const usedSlugs = new Map<string, string>() // slug -> upstreamId (first claimant)
    const slugForUpstream = new Map<string, string>()

    for (const { upstreamId, upstreamName, tool } of tools) {
      // Resolve a stable, unique server slug per upstreamId.
      let slug = slugForUpstream.get(upstreamId)
      if (!slug) {
        const base = slugifyServer(upstreamName)
        slug = base
        let n = 2
        while (usedSlugs.has(slug) && usedSlugs.get(slug) !== upstreamId) {
          slug = `${base}_${n++}`
        }
        usedSlugs.set(slug, upstreamId)
        slugForUpstream.set(upstreamId, slug)
      }

      const namespacedName = `${slug}${NAMESPACE_SEP}${tool.name}`
      const indexed: IndexedTool = {
        namespacedName,
        server: upstreamName,
        upstreamId,
        toolName: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
      }
      // Guard against the same namespaced name appearing twice (duplicate tool
      // names within one server) — keep the first, skip the rest.
      if (this.byName.has(namespacedName)) continue
      this.byName.set(namespacedName, indexed)

      const terms = [
        ...tokenize(tool.name),
        ...tokenize(slug),
        ...tokenize(indexed.description),
        ...schemaTerms(tool.inputSchema),
      ]
      const tf = new Map<string, number>()
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1)
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      this.docs.push({ tool: indexed, terms, tf, len: terms.length })
    }

    this.avgLen =
      this.docs.length > 0
        ? this.docs.reduce((s, d) => s + d.len, 0) / this.docs.length
        : 0
  }

  get size(): number {
    return this.docs.length
  }

  /** BM25 search. Empty query returns the first `limit` tools (all() order).
   *  `server` filters to one upstream by slug or display name (case-insensitive). */
  search(query: string, opts: { server?: string; limit?: number } = {}): ToolSearchRow[] {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT
    const serverFilter = opts.server?.toLowerCase().trim()

    const inScope = (d: Doc): boolean => {
      if (!serverFilter) return true
      const slug = d.tool.namespacedName.split(NAMESPACE_SEP)[0]
      return slug === serverFilter || d.tool.server.toLowerCase() === serverFilter
    }

    const qTerms = tokenize(query)
    if (qTerms.length === 0) {
      return this.docs
        .filter(inScope)
        .slice(0, limit)
        .map((d) => this.row(d.tool))
    }

    const N = this.docs.length
    const scored: Array<{ doc: Doc; score: number }> = []
    for (const doc of this.docs) {
      if (!inScope(doc)) continue
      let score = 0
      for (const term of qTerms) {
        const f = doc.tf.get(term)
        if (!f) continue
        const n = this.df.get(term) ?? 0
        // BM25 IDF with +1 so it never goes negative for common terms.
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
        const denom = f + K1 * (1 - B + (B * doc.len) / (this.avgLen || 1))
        score += idf * ((f * (K1 + 1)) / denom)
      }
      if (score > 0) scored.push({ doc, score })
    }

    scored.sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.doc.tool.namespacedName.localeCompare(b.doc.tool.namespacedName),
    )
    return scored.slice(0, limit).map((s) => this.row(s.doc.tool))
  }

  /** Full detail for one namespaced tool (for describe_tool), or null. */
  describe(namespacedName: string): IndexedTool | null {
    return this.byName.get(namespacedName) ?? null
  }

  /** Resolve a namespaced name to its routing target (for call_tool), or null. */
  resolve(namespacedName: string): { upstreamId: string; toolName: string } | null {
    const t = this.byName.get(namespacedName)
    return t ? { upstreamId: t.upstreamId, toolName: t.toolName } : null
  }

  /** All tools as compact rows, in insertion order. */
  all(): ToolSearchRow[] {
    return this.docs.map((d) => this.row(d.tool))
  }

  private row(t: IndexedTool): ToolSearchRow {
    return { name: t.namespacedName, server: t.server, description: firstLine(t.description) }
  }
}
