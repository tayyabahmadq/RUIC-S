/**
 * Opus//DECK — Phase 12: CodeGraph (workspace knowledge-graph memory).
 * Public API: createCodegraph(deps) → { rebuild(), load() }.
 *
 * The codegraph scans the source tree, extracts imports/symbols, builds a
 * workspace graph, clusters it, renders a CODEMAP digest section, and writes
 * the graph + report to STATE/folder-12/. The CODEMAP section is written into
 * the digest via the commons write path so compaction/ARCHIVE semantics apply
 * unchanged (R6: CODEMAP is regenerable state, not pinned memory).
 */
import { promises as fsp } from 'fs'
import * as nodePath from 'path'
import { createHash } from 'crypto'
import type { Commons } from '../commons/types.js'
import type { EventBus } from '../compactor/types.js'
import { CommonsError } from './errors.js'
import type { CodegraphResult, FileExtraction, WorkspaceGraph } from './types.js'
import { classifyFileRole } from './detect.js'
import { extractFromFile } from './extract.js'
import { buildGraph } from './build.js'
import { clusterGraph } from './cluster.js'
import { renderCodegraphSection, renderReport } from './section.js'

const GRAPH_PATH = 'STATE/folder-12/codegraph.json'
const REPORT_PATH = 'STATE/folder-12/report.md'
const DIGEST_PATH = 'STATE/digest.md'
const DEFAULT_TOKEN_CAP = 500

/** Dependencies for the codegraph. */
export interface CodegraphDeps {
  /** Phase-03 commons (read/write state). */
  commons: Commons
  /** Shared event hub (emit codegraph.rebuilt). */
  bus: EventBus
  /** Absolute path to the memory directory (for filesystem scanning). */
  memoryDir: string
  /** Source tree root, relative to memoryDir (e.g., "WORKSPACE"). */
  sourceTree: string
  /** Token cap for the CODEMAP section. */
  tokenCap?: number
}

/** The codegraph public API. */
export interface Codegraph {
  /** Rebuild the graph from the source tree. Emits codegraph.rebuilt. */
  rebuild(): Promise<CodegraphResult>
  /** Load the last built graph from state. Returns null if none exists. */
  load(): Promise<WorkspaceGraph | null>
}

/** Walk a directory tree, returning all file paths relative to root. */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  for (const ent of entries) {
    const full = nodePath.join(root, ent.name)
    if (ent.isDirectory()) {
      const sub = await walkFiles(full)
      for (const s of sub) out.push(nodePath.join(ent.name, s).split(nodePath.sep).join('/'))
    } else if (ent.isFile()) {
      out.push(ent.name)
    }
  }
  return out
}

/** Read a file as UTF-8. Returns null on read error (crash-safe). */
async function safeReadFile(absPath: string): Promise<string | null> {
  try {
    return await fsp.readFile(absPath, 'utf8')
  } catch {
    return null
  }
}

/** Split content into lines (for diff-writing). */
function splitLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split(/\r?\n/)
  if (content.endsWith('\n')) lines.pop()
  return lines
}

/** Write a full file via the commons write path (full-rewrite diff). */
async function writeFullFile(commons: Commons, path: string, content: string): Promise<void> {
  let current = ''
  try {
    current = await commons.read(path)
  } catch {
    // File doesn't exist yet — that's fine
  }
  const oldLines = splitLines(current)
  const newLines = splitLines(content)
  await commons.write({
    path,
    diff: { added: newLines, removedLineCount: oldLines.length, atLine: 1 },
    intent: `f12 ${nodePath.basename(path)} write`,
    author: 'codegraph',
  })
}

/** Update the digest with the CODEMAP section (replace or append). */
async function updateDigest(commons: Commons, section: string): Promise<void> {
  let current = ''
  try {
    current = await commons.read(DIGEST_PATH)
  } catch {
    // No digest yet — create one
  }

  // Remove existing CODEMAP section (from "## CODEMAP" to next "## " or end)
  const lines = current.split('\n')
  const out: string[] = []
  let inCodegraph = false
  for (const line of lines) {
    if (/^##\s+CODEMAP\s*$/i.test(line)) {
      inCodegraph = true
      continue
    }
    if (inCodegraph && /^##\s+/.test(line)) {
      inCodegraph = false
    }
    if (!inCodegraph) out.push(line)
  }

  // Append the new CODEMAP section
  const trimmed = out.join('\n').replace(/\n+$/, '')
  const newContent = trimmed + '\n\n' + section + '\n'
  await writeFullFile(commons, DIGEST_PATH, newContent)
}

/**
 * Compute a fingerprint of the source tree for rate-limiting. Exported so
 * the wiring hook can gate rebuilds on "identical state never rebuilds"
 * without duplicating the hashing scheme.
 */
export async function fingerprintSourceTree(root: string): Promise<string> {
  const files = await walkFiles(root)
  const h = createHash('sha256')
  for (const f of files.sort()) {
    const abs = nodePath.join(root, ...f.split('/'))
    try {
      const content = await fsp.readFile(abs, 'utf8')
      h.update(f)
      h.update('\u0000')
      h.update(content)
      h.update('\u0000')
    } catch {
      h.update(f)
      h.update('\u0000<unreadable>\u0000')
    }
  }
  return h.digest('hex')
}

/** Create the codegraph instance. */
export function createCodegraph(deps: CodegraphDeps): Codegraph {
  const { commons, bus, memoryDir, sourceTree } = deps
  const tokenCap = deps.tokenCap ?? DEFAULT_TOKEN_CAP
  let lastFingerprint: string | null = null

  async function rebuild(): Promise<CodegraphResult> {
    const root = nodePath.join(memoryDir, sourceTree)

    // Scan source tree
    const filePaths = await walkFiles(root)
    const extractions: FileExtraction[] = []
    const skipped: string[] = []

    for (const relPath of filePaths) {
      const absPath = nodePath.join(root, ...relPath.split('/'))
      const content = await safeReadFile(absPath)
      if (content === null) {
        skipped.push(relPath)
        console.log(`[codegraph] skipped (unreadable): ${relPath}`)
        continue
      }
      const extraction = extractFromFile(relPath, content)
      if (extraction.skipped) {
        skipped.push(relPath)
        console.log(`[codegraph] skipped: ${relPath} — ${extraction.skipReason ?? 'unknown reason'}`)
      }
      extractions.push(extraction)
    }

    // Build graph
    const graph = buildGraph(extractions)

    // Cluster
    const clusters = clusterGraph(graph)

    // Render CODEMAP section
    const section = renderCodegraphSection(graph, clusters, tokenCap)

    // Write graph + report to state
    await writeFullFile(commons, GRAPH_PATH, JSON.stringify(graph, null, 2) + '\n')
    await writeFullFile(commons, REPORT_PATH, renderReport(graph, clusters, skipped))

    // Update digest with CODEMAP section (via commons write path)
    await updateDigest(commons, section)

    // Emit event
    const result: CodegraphResult = {
      files: graph.nodes.length,
      clusters: clusters.clusters.length,
      hubs: clusters.hubs.length,
      graph,
      skipped,
    }
    await bus.emit('codegraph.rebuilt', {
      files: result.files,
      clusters: result.clusters,
      hubs: result.hubs,
    })

    // Update fingerprint
    lastFingerprint = await fingerprintSourceTree(root)

    return result
  }

  async function load(): Promise<WorkspaceGraph | null> {
    try {
      const raw = await commons.read(GRAPH_PATH)
      const parsed = JSON.parse(raw) as WorkspaceGraph
      if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        return parsed
      }
      return null
    } catch {
      return null
    }
  }

  return { rebuild, load }
}
