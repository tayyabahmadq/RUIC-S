/**
 * Opus//DECK — Phase 12: CodeGraph (public API barrel).
 */
export { CommonsError } from './errors.js'
export { createCodegraph, fingerprintSourceTree } from './index.js'
export type { Codegraph, CodegraphDeps } from './index.js'
export { classifyFileRole } from './detect.js'
export { extractFromFile, extractImports, extractSymbols } from './extract.js'
export { buildGraph, resolveImport } from './build.js'
export { clusterGraph } from './cluster.js'
export { renderCodegraphSection, renderReport } from './section.js'
export type {
  FileRole,
  GraphNode,
  GraphEdge,
  WorkspaceGraph,
  ExtractedImport,
  ExtractedSymbol,
  FileExtraction,
  ClusterInfo,
  HubInfo,
  ClusterResult,
  CodegraphResult,
} from './types.js'
