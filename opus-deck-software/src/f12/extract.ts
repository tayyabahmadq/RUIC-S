/**
 * Opus//DECK — Phase 12: CodeGraph — import/symbol extraction.
 * v1: scoped regex extraction for TypeScript/JS. Deterministic and
 * crash-safe per file: one unparseable file yields a logged skip.
 */
import type { ExtractedImport, ExtractedSymbol, FileExtraction } from './types.js'

// Combined regex for all import forms:
//   import ... from 'x'  |  import 'x'  |  require('x')  |  export ... from 'x'  |  import('x')
const IMPORT_RE = /(?:import\s+(?:[\w*{}\s,]+?\s+from\s+)?|export\s+(?:[\w*{}\s,]+?\s+from\s+)?|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g

// Regex for exported symbols: export function/class/const/let/var/interface/type/enum
const SYMBOL_RE = /export\s+(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+(\w+)/g

/**
 * Extract imports and symbols from file content.
 * CRASH-SAFE: returns skipped:true on any error, never throws.
 *
 * A file containing a NUL byte is malformed as a text source (binary
 * garbage); it is reported as a logged skip, never a failed rebuild.
 */
export function extractFromFile(path: string, content: string): FileExtraction {
  if (content.includes('\u0000')) {
    return { path, imports: [], symbols: [], skipped: true, skipReason: 'malformed: NUL byte (binary content)' }
  }
  try {
    const imports = extractImports(content)
    const symbols = extractSymbols(content)
    return { path, imports, symbols, skipped: false }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { path, imports: [], symbols: [], skipped: true, skipReason: reason }
  }
}

/** Extract all import sources from file content. */
export function extractImports(content: string): ExtractedImport[] {
  const out: ExtractedImport[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null
  const re = new RegExp(IMPORT_RE.source, 'g')
  while ((match = re.exec(content)) !== null) {
    const source = match[1] ?? ''
    if (source.length === 0 || seen.has(source)) continue
    seen.add(source)
    out.push({
      source,
      isRelative: source.startsWith('./') || source.startsWith('../'),
      isExternal: !source.startsWith('.') && !source.startsWith('/') && !source.startsWith('node:'),
    })
  }
  return out
}

/** Extract exported symbols from file content. */
export function extractSymbols(content: string): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null
  const re = new RegExp(SYMBOL_RE.source, 'g')
  while ((match = re.exec(content)) !== null) {
    const kind = (match[1] ?? 'const') as ExtractedSymbol['kind']
    const name = match[2] ?? ''
    if (name.length === 0 || seen.has(name)) continue
    seen.add(name)
    out.push({ name, kind })
  }
  return out
}
