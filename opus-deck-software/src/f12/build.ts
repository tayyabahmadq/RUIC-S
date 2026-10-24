/**
 * Opus//DECK — Phase 12: CodeGraph — graph assembly.
 * Builds the workspace graph from file extractions: resolves relative
 * imports in-tree, drops externals to a count, adds sibling edges.
 */
import type { FileExtraction, GraphEdge, GraphNode, WorkspaceGraph } from './types.js'
import { classifyFileRole } from './detect.js'

/** Extensions to try when resolving a relative import. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js']

/** Normalize a forward-slash relative path (collapse '.', resolve '..', trim '/'). */
function normalizeRel(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/**
 * Resolve a relative import from one file to another.
 * Returns the resolved path if it exists in the known file set, else null.
 */
export function resolveImport(fromFile: string, source: string, knownFiles: Set<string>): string | null {
  const fromDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
  const base = normalizeRel(fromDir ? `${fromDir}/${source}` : source)

  // Try the source as-is first
  if (knownFiles.has(base)) return base

  // Try with extensions
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = base + ext
    if (knownFiles.has(candidate)) return candidate
  }

  return null
}

/**
 * Build the workspace graph from file extractions.
 * - Creates a node per non-skipped file
 * - Resolves relative imports to in-tree edges
 * - Counts external imports
 * - Adds sibling edges for files in the same directory
 */
export function buildGraph(files: FileExtraction[]): WorkspaceGraph {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let externalCount = 0

  // Build node list and known-file set
  const knownFiles = new Set<string>()
  for (const file of files) {
    if (file.skipped) continue
    knownFiles.add(file.path)
    const role = classifyFileRole(file.path)
    nodes.push({ id: file.path, kind: role, symbols: file.symbols.map((s) => s.name) })
  }

  // Build import edges
  for (const file of files) {
    if (file.skipped) continue
    for (const imp of file.imports) {
      if (imp.isRelative) {
        const resolved = resolveImport(file.path, imp.source, knownFiles)
        if (resolved !== null) {
          edges.push({ from: file.path, to: resolved, kind: 'imports' })
        }
      } else if (imp.isExternal) {
        externalCount++
      }
    }
  }

  // Build sibling edges: files in the same directory
  const dirMap = new Map<string, string[]>()
  for (const node of nodes) {
    const dir = node.id.includes('/') ? node.id.slice(0, node.id.lastIndexOf('/')) : ''
    const siblings = dirMap.get(dir) ?? []
    siblings.push(node.id)
    dirMap.set(dir, siblings)
  }
  for (const siblings of dirMap.values()) {
    if (siblings.length < 2) continue
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        edges.push({ from: siblings[i]!, to: siblings[j]!, kind: 'sibling' })
      }
    }
  }

  return { nodes, edges, externalCount, generatedAt: new Date().toISOString() }
}
