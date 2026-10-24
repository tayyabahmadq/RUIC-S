/**
 * Phase 5: path canonicalization.
 */
export function normalizePath(p: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new Error('path_invalid')
  let normalized = p.replace(/\\/g, '/')
  // collapse . and .. segments, strip trailing slash
  const parts = normalized.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  const result = out.join('/')
  if (result === '' || result === '.') throw new Error('path_invalid')
  return result
}

export function canonicalPath(p: string): string {
  return normalizePath(p)
}

export function normalizePathSet(pathSet: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of pathSet) {
    const c = normalizePath(p)
    if (!seen.has(c)) { seen.add(c); out.push(c) }
  }
  return out
}

export function preview(value: unknown): string {
  try { return JSON.stringify(value) } catch { return String(value) }
}
