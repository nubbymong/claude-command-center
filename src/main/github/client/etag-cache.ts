/**
 * Thin ETag-per-endpoint cache. Backed by a plain object so it round-trips
 * through JSON persistence (RepoCache.etags) without extra serialization.
 */
export class EtagCache {
  constructor(private backing: Record<string, string>) {}
  get(key: string): string | undefined {
    return this.backing[key]
  }
  set(key: string, etag: string): void {
    this.backing[key] = etag
  }
  delete(key: string): void {
    delete this.backing[key]
  }
}
