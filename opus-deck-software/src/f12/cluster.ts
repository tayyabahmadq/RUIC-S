/**
 * Opus//DECK — Phase 12: CodeGraph — clustering + hub analysis.
 * Entry-point traversal → module-cluster tagging + hub-file ranking.
 */
import type { ClusterInfo, ClusterResult, GraphEdge, HubInfo, WorkspaceGraph } from './types.js'

/** Build an adjacency list from the graph's import edges. */
function buildAdjacency(edges: GraphEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.kind !== 'imports') continue
    const list = adj.get(edge.from) ?? []
    list.push(edge.to)
    adj.set(edge.from, list)
  }
  return adj
}

/** Compute in-degree for every node. */
function computeInDegree(edges: GraphEdge[]): Map<string, number> {
  const deg = new Map<string, number>()
  for (const edge of edges) {
    if (edge.kind !== 'imports') continue
    deg.set(edge.to, (deg.get(edge.to) ?? 0) + 1)
  }
  return deg
}

/** BFS from a start node, returning all reachable nodes (including start). */
function bfsReachable(start: string, adj: Map<string, string[]>): Set<string> {
  const visited = new Set<string>()
  const queue: string[] = [start]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    for (const next of adj.get(current) ?? []) {
      if (!visited.has(next)) queue.push(next)
    }
  }
  return visited
}

/**
 * Cluster the graph: BFS from each entry point → module clusters.
 * Rank hubs by in-degree. Identify orphans (unreachable from any entry).
 */
export function clusterGraph(graph: WorkspaceGraph): ClusterResult {
  const adj = buildAdjacency(graph.edges)
  const inDegree = computeInDegree(graph.edges)

  const entries = graph.nodes.filter((n) => n.kind === 'entry')
  const reachable = new Set<string>()
  const clusters: ClusterInfo[] = []

  for (const entry of entries) {
    const members = bfsReachable(entry.id, adj)
    clusters.push({ entryId: entry.id, memberIds: [...members].sort() })
    for (const m of members) reachable.add(m)
  }

  // Orphans: nodes not reachable from any entry
  const orphans = graph.nodes.map((n) => n.id).filter((id) => !reachable.has(id))

  // Hubs: nodes with in-degree > 0, sorted descending
  const hubs: HubInfo[] = graph.nodes
    .map((n) => ({ id: n.id, inDegree: inDegree.get(n.id) ?? 0 }))
    .filter((h) => h.inDegree > 0)
    .sort((a, b) => b.inDegree - a.inDegree || (a.id < b.id ? -1 : 1))

  return { clusters, hubs, orphans }
}
