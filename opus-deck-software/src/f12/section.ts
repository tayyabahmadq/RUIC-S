/**
 * Opus//DECK — Phase 12: CodeGraph — CODEMAP digest section renderer.
 * Renders a compact CODEMAP section (top hubs, orphan list, cluster table),
 * sized to the token cap using the compactor's estimateTokens (R1).
 */
import { estimateTokens } from '../compactor/index.js'
import type { ClusterResult, WorkspaceGraph } from './types.js'

/** Maximum number of hubs to list in the section. */
const MAX_HUBS = 5
/** Maximum number of orphans to list. */
const MAX_ORPHANS = 10
/** Maximum number of clusters to list. */
const MAX_CLUSTERS = 10

/**
 * Render the CODEMAP digest section from a graph + cluster result.
 * The section is trimmed to fit within `tokenCap` tokens.
 */
export function renderCodegraphSection(graph: WorkspaceGraph, clusters: ClusterResult, tokenCap: number): string {
  const lines: string[] = ['## CODEMAP', '']

  // Top hubs by in-degree
  const topHubs = clusters.hubs.slice(0, MAX_HUBS)
  if (topHubs.length > 0) {
    lines.push('Hubs (by in-degree):')
    for (const hub of topHubs) {
      lines.push(`- ${hub.id} (${hub.inDegree})`)
    }
    lines.push('')
  }

  // Cluster table
  const topClusters = clusters.clusters.slice(0, MAX_CLUSTERS)
  if (topClusters.length > 0) {
    lines.push('Clusters:')
    for (const cluster of topClusters) {
      lines.push(`- ${cluster.entryId}: ${cluster.memberIds.length} files`)
    }
    lines.push('')
  }

  // Orphan list
  if (clusters.orphans.length > 0) {
    lines.push('Orphans:')
    for (const orphan of clusters.orphans.slice(0, MAX_ORPHANS)) {
      lines.push(`- ${orphan}`)
    }
    if (clusters.orphans.length > MAX_ORPHANS) {
      lines.push(`- ... and ${clusters.orphans.length - MAX_ORPHANS} more`)
    }
    lines.push('')
  }

  // External import count
  lines.push(`External imports: ${graph.externalCount}`)

  // Trim to token cap: remove lines from the end until under budget
  let section = lines.join('\n')
  while (estimateTokens(section) > tokenCap && lines.length > 2) {
    lines.pop()
    section = lines.join('\n')
  }

  return section
}

/**
 * Render the human-readable report (report.md content).
 */
export function renderReport(graph: WorkspaceGraph, clusters: ClusterResult, skipped: string[]): string {
  const lines: string[] = [
    '# CodeGraph Report',
    '',
    `- Files: ${graph.nodes.length}`,
    `- External imports: ${graph.externalCount}`,
    `- Generated: ${graph.generatedAt}`,
    '',
  ]

  if (skipped.length > 0) {
    lines.push('## Skipped Files')
    for (const s of skipped) {
      lines.push(`- ${s}`)
    }
    lines.push('')
  }

  if (clusters.hubs.length > 0) {
    lines.push('## Hubs (by in-degree)')
    for (const hub of clusters.hubs.slice(0, 10)) {
      lines.push(`- ${hub.id} (${hub.inDegree})`)
    }
    lines.push('')
  }

  if (clusters.clusters.length > 0) {
    lines.push('## Clusters')
    for (const cluster of clusters.clusters.slice(0, 10)) {
      lines.push(`- ${cluster.entryId}: ${cluster.memberIds.length} files`)
    }
    lines.push('')
  }

  if (clusters.orphans.length > 0) {
    lines.push('## Orphans')
    for (const orphan of clusters.orphans.slice(0, 20)) {
      lines.push(`- ${orphan}`)
    }
    lines.push('')
  }

  return lines.join('\n') + '\n'
}
