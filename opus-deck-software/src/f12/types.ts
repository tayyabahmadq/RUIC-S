/**
 * Opus//DECK — Phase 12: CodeGraph (workspace knowledge-graph memory).
 * Type contracts for the codegraph pipeline.
 */

/** File role classification from path conventions. */
export type FileRole = 'entry' | 'module' | 'test' | 'config' | 'doc'

/** A node in the workspace graph. `id` is the symlink label (file path). */
export interface GraphNode {
  id: string
  kind: FileRole
  symbols?: string[]
}

/** An edge in the workspace graph. */
export interface GraphEdge {
  from: string
  to: string
  kind: 'imports' | 'sibling'
}

/** The full workspace graph. */
export interface WorkspaceGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  externalCount: number
  generatedAt: string
}

/** An import extracted from a source file. */
export interface ExtractedImport {
  /** The import source as written (e.g., "./utils", "lodash"). */
  source: string
  /** Whether the import is relative (starts with ./ or ../). */
  isRelative: boolean
  /** Whether the import is external (not relative, not absolute). */
  isExternal: boolean
}

/** A symbol extracted from a source file. */
export interface ExtractedSymbol {
  name: string
  kind: 'function' | 'class' | 'const' | 'let' | 'var' | 'interface' | 'type' | 'enum'
}

/** The result of extracting imports/symbols from one file. */
export interface FileExtraction {
  path: string
  imports: ExtractedImport[]
  symbols: ExtractedSymbol[]
  /** Whether extraction was skipped (malformed file). */
  skipped: boolean
  /** Reason for skipping, if skipped. */
  skipReason?: string
}

/** A module cluster: all nodes reachable from one entry point. */
export interface ClusterInfo {
  entryId: string
  memberIds: string[]
}

/** A hub file ranked by in-degree. */
export interface HubInfo {
  id: string
  inDegree: number
}

/** The result of clustering + hub analysis. */
export interface ClusterResult {
  clusters: ClusterInfo[]
  hubs: HubInfo[]
  orphans: string[]
}

/** The result of a full rebuild. */
export interface CodegraphResult {
  files: number
  clusters: number
  hubs: number
  graph: WorkspaceGraph
  skipped: string[]
}
