/**
 * Phase 12 smoke test — CodeGraph (f12).
 *
 * Covers: extraction fixtures for every supported import form; resolver
 * in-tree vs out-of-tree; cluster/hub math on a golden graph; CODEMAP
 * token-cap behavior; digest + planner-prompt integration (the section
 * reaches the prompt through the normal digest slot); the R6 both-direction
 * compaction tests; the crash-safety probe (one malformed file → logged
 * skip, rebuild completes); and the wiring hook (source-tree filter +
 * fingerprint gating).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'node:path'
import { openCommons } from '../commons/index.js'
import { estimateTokens } from '../compactor/index.js'
import { buildPrompt } from '../crew/assemble-prompt.js'
import { initOpusDeck } from '../config/bootstrap.js'
import { wireOpusDeck } from '../wiring/index.js'
import { createCodegraph } from './index.js'
import { classifyFileRole } from './detect.js'
import { extractFromFile, extractImports, extractSymbols } from './extract.js'
import { buildGraph, resolveImport } from './build.js'
import { clusterGraph } from './cluster.js'
import { renderCodegraphSection, renderReport } from './section.js'
import type { EventBus } from '../compactor/types.js'
import type { FileExtraction, WorkspaceGraph } from './types.js'
import type { Transport as F02Transport, TransportChunk } from '../transport/types.js'

// ---------------------------------------------------------------------------
// Extraction fixtures — every supported import form
// ---------------------------------------------------------------------------

test('extract: all supported import forms are captured with correct flags', () => {
  const content = [
    "import { a } from './util'",
    "import def from './util'",
    "import * as ns from './ns'",
    "import './side-effect'",
    "export { b } from './reexport'",
    "const x = require('pkg')",
    "const y = await import('./dynamic')",
    "import mixed, { named } from './mixed'",
  ].join('\n')
  const imports = extractImports(content)
  const sources = imports.map((i) => i.source)
  for (const expected of ['./util', './ns', './side-effect', './reexport', 'pkg', './dynamic', './mixed']) {
    assert.ok(sources.includes(expected), `extracted ${expected}`)
  }
  assert.strictEqual(imports.filter((i) => i.source === './util').length, 1, 'duplicate import sources are deduped')
  for (const imp of imports) {
    if (imp.source === 'pkg') {
      assert.strictEqual(imp.isRelative, false)
      assert.strictEqual(imp.isExternal, true)
    } else {
      assert.strictEqual(imp.isRelative, true)
      assert.strictEqual(imp.isExternal, false)
    }
  }
})

test('extract: node: builtins and absolute paths are not relative', () => {
  const imports = extractImports("import fs from 'node:fs'\nimport x from '/abs/path'\n")
  assert.strictEqual(imports[0]!.isRelative, false)
  assert.strictEqual(imports[0]!.isExternal, false, 'node: builtin is not counted as an external import')
  assert.strictEqual(imports[1]!.isRelative, false)
  assert.strictEqual(imports[1]!.isExternal, false)
})

test('extract: exported symbols of every supported kind', () => {
  const content = [
    'export function f() {}',
    'export async function g() {}',
    'export class C {}',
    'export const k = 1',
    'export let l = 2',
    'export var v = 3',
    'export interface I {}',
    'export type T = number',
    'export enum E { A }',
  ].join('\n')
  const symbols = extractSymbols(content)
  const kinds = symbols.map((s) => s.kind)
  for (const kind of ['function', 'class', 'const', 'let', 'var', 'interface', 'type', 'enum']) {
    assert.ok(kinds.includes(kind as never), `extracted ${kind}`)
  }
  assert.deepStrictEqual(symbols.map((s) => s.name), ['f', 'g', 'C', 'k', 'l', 'v', 'I', 'T', 'E'])
})

test('extract: malformed file (NUL byte) is a logged skip, never a throw', () => {
  const bad = extractFromFile('src/bad.ts', 'const a = 1;\u0000\nconst b = 2;\n')
  assert.strictEqual(bad.skipped, true)
  assert.ok(bad.skipReason?.includes('malformed'), `skip reason recorded: ${bad.skipReason}`)
  assert.deepStrictEqual(bad.imports, [])
  assert.deepStrictEqual(bad.symbols, [])

  const good = extractFromFile('src/good.ts', 'export const a = 1;\n')
  assert.strictEqual(good.skipped, false)
  assert.strictEqual(good.skipReason, undefined)
})

// ---------------------------------------------------------------------------
// File role detection
// ---------------------------------------------------------------------------

test('detect: file roles from path conventions', () => {
  assert.strictEqual(classifyFileRole('src/index.ts'), 'entry')
  assert.strictEqual(classifyFileRole('src/main.ts'), 'entry')
  assert.strictEqual(classifyFileRole('src/cli.ts'), 'entry')
  assert.strictEqual(classifyFileRole('src/util.ts'), 'module')
  assert.strictEqual(classifyFileRole('src/util.test.ts'), 'test')
  assert.strictEqual(classifyFileRole('src/util.spec.ts'), 'test')
  assert.strictEqual(classifyFileRole('src/__tests__/util.ts'), 'test')
  assert.strictEqual(classifyFileRole('package.json'), 'config')
  assert.strictEqual(classifyFileRole('tsconfig.json'), 'config')
  assert.strictEqual(classifyFileRole('.env'), 'config')
  assert.strictEqual(classifyFileRole('vite.config.ts'), 'config')
  assert.strictEqual(classifyFileRole('README.md'), 'doc')
  assert.strictEqual(classifyFileRole('notes.txt'), 'doc')
})

// ---------------------------------------------------------------------------
// Resolver — in-tree vs out-of-tree
// ---------------------------------------------------------------------------

test('resolveImport: in-tree relative imports resolve with extension fallbacks', () => {
  const known = new Set(['src/util.ts', 'src/util/index.ts', 'shared/h.ts'])
  assert.strictEqual(resolveImport('src/app.ts', './util', known), 'src/util.ts')
  assert.strictEqual(resolveImport('src/app.ts', './util/index', known), 'src/util/index.ts')
  assert.strictEqual(resolveImport('src/app.ts', '../shared/h', known), 'shared/h.ts')
})

test('resolveImport: out-of-tree and unresolved imports return null', () => {
  const known = new Set(['src/app.ts'])
  assert.strictEqual(resolveImport('src/app.ts', './missing', known), null)
  assert.strictEqual(resolveImport('src/app.ts', '../elsewhere', known), null)
  // externals are never resolved in-tree
  assert.strictEqual(resolveImport('src/app.ts', 'lodash', known), null)
})

// ---------------------------------------------------------------------------
// Graph assembly
// ---------------------------------------------------------------------------

test('buildGraph: in-tree edges resolve, externals counted, siblings linked', () => {
  const files: FileExtraction[] = [
    { path: 'src/app.ts', imports: [{ source: './util', isRelative: true, isExternal: false }, { source: 'lodash', isRelative: false, isExternal: true }], symbols: [{ name: 'app', kind: 'const' }], skipped: false },
    { path: 'src/util.ts', imports: [{ source: 'lodash', isRelative: false, isExternal: true }], symbols: [{ name: 'helper', kind: 'function' }], skipped: false },
    { path: 'README.md', imports: [], symbols: [], skipped: false },
    { path: 'src/broken.ts', imports: [], symbols: [], skipped: true, skipReason: 'malformed' },
  ]
  const graph = buildGraph(files)
  assert.strictEqual(graph.nodes.length, 3, 'skipped files produce no node')
  assert.strictEqual(graph.externalCount, 2)
  const importEdges = graph.edges.filter((e) => e.kind === 'imports')
  assert.deepStrictEqual(importEdges, [{ from: 'src/app.ts', to: 'src/util.ts', kind: 'imports' }])
  const siblingEdges = graph.edges.filter((e) => e.kind === 'sibling')
  assert.ok(siblingEdges.some((e) => e.from === 'src/app.ts' && e.to === 'src/util.ts'), 'same-directory sibling edge')
  assert.ok(!siblingEdges.some((e) => e.to === 'README.md'), 'root-level file has no same-directory sibling')
})

// ---------------------------------------------------------------------------
// Cluster/hub math on a golden graph
// ---------------------------------------------------------------------------

function goldenGraph(): WorkspaceGraph {
  return {
    nodes: [
      { id: 'index.ts', kind: 'entry' },
      { id: 'a.ts', kind: 'module' },
      { id: 'b.ts', kind: 'module' },
      { id: 'c.ts', kind: 'module' },
      { id: 'd.ts', kind: 'module' },
      { id: 'e.ts', kind: 'module' },
    ],
    edges: [
      { from: 'index.ts', to: 'a.ts', kind: 'imports' },
      { from: 'index.ts', to: 'b.ts', kind: 'imports' },
      { from: 'a.ts', to: 'c.ts', kind: 'imports' },
      { from: 'b.ts', to: 'c.ts', kind: 'imports' },
      { from: 'd.ts', to: 'e.ts', kind: 'imports' },
    ],
    externalCount: 0,
    generatedAt: '2026-10-17T00:00:00.000Z',
  }
}

test('clusterGraph: entry traversal, hub ranking by in-degree, orphans', () => {
  const result = clusterGraph(goldenGraph())
  assert.strictEqual(result.clusters.length, 1)
  assert.strictEqual(result.clusters[0]!.entryId, 'index.ts')
  assert.deepStrictEqual(result.clusters[0]!.memberIds, ['a.ts', 'b.ts', 'c.ts', 'index.ts'])
  // c has in-degree 2 (the hub), a/b/e have in-degree 1 each — ties broken by id
  assert.deepStrictEqual(result.hubs, [
    { id: 'c.ts', inDegree: 2 },
    { id: 'a.ts', inDegree: 1 },
    { id: 'b.ts', inDegree: 1 },
    { id: 'e.ts', inDegree: 1 },
  ])
  assert.deepStrictEqual(result.orphans, ['d.ts', 'e.ts'], 'files unreachable from any entry are orphans')
})

// ---------------------------------------------------------------------------
// CODEMAP token-cap behavior
// ---------------------------------------------------------------------------

test('renderCodegraphSection: content is trimmed to the token cap, header survives', () => {
  const graph: WorkspaceGraph = {
    nodes: [
      { id: 'index.ts', kind: 'entry' },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `m${i}.ts`, kind: 'module' as const })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `orphan${i}.ts`, kind: 'module' as const })),
    ],
    edges: Array.from({ length: 30 }, (_, i) => ({ from: 'index.ts', to: `m${i}.ts`, kind: 'imports' as const })),
    externalCount: 3,
    generatedAt: '2026-10-17T00:00:00.000Z',
  }
  const clusters = clusterGraph(graph)

  const full = renderCodegraphSection(graph, clusters, 10000)
  assert.ok(full.includes('## CODEMAP'))
  assert.ok(full.includes('External imports: 3'))
  assert.ok(full.includes('... and 20 more'), 'orphan overflow is summarized')

  const tiny = renderCodegraphSection(graph, clusters, 30)
  assert.ok(tiny.startsWith('## CODEMAP'), 'header is never trimmed away')
  assert.ok(estimateTokens(tiny) <= 30, `section fits the cap (got ${estimateTokens(tiny)})`)
})

test('renderReport: skipped files are listed in the human-readable report', () => {
  const md = renderReport(goldenGraph(), clusterGraph(goldenGraph()), ['src/broken.ts'])
  assert.ok(md.includes('# CodeGraph Report'))
  assert.ok(md.includes('src/broken.ts'), 'skipped file listed')
  assert.ok(md.includes('c.ts (2)'), 'hub with in-degree listed')
})

// ---------------------------------------------------------------------------
// Rebuild end-to-end through the commons write path
// ---------------------------------------------------------------------------

class StubBus implements EventBus {
  private handlers = new Map<string, Array<(p: unknown) => void>>()
  events: Array<{ type: string; payload: unknown }> = []
  subscribe(type: string, handler: (p: unknown) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
  }
  emit(type: string, payload: unknown): void | Promise<void> {
    this.events.push({ type, payload })
    for (const h of this.handlers.get(type) ?? []) h(payload)
  }
}

async function makeWorkspace(memoryDir: string, withMalformed: boolean): Promise<void> {
  const ws = path.join(memoryDir, 'WORKSPACE')
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'src', 'index.ts'), "import { helper } from './util'\nimport _ from 'lodash'\nexport function main() { return helper() }\n", 'utf8')
  fs.writeFileSync(path.join(ws, 'src', 'util.ts'), 'export function helper() { return 1 }\n', 'utf8')
  fs.writeFileSync(path.join(ws, 'README.md'), '# Workspace\n', 'utf8')
  if (withMalformed) {
    fs.writeFileSync(path.join(ws, 'src', 'broken.ts'), 'const a = 1;\u0000\nconst b = 2;\n', 'utf8')
  }
}

test('rebuild: graph + report written to state, digest gains CODEMAP, event emitted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-f12-rebuild-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const commons = await openCommons(memoryDir)
    await makeWorkspace(memoryDir, false)
    const bus = new StubBus()
    const codegraph = createCodegraph({ commons, bus, memoryDir, sourceTree: 'WORKSPACE' })

    const result = await codegraph.rebuild()
    assert.strictEqual(result.files, 3)
    assert.strictEqual(result.skipped.length, 0)
    assert.strictEqual(result.clusters, 1)
    assert.strictEqual(result.hubs, 1)

    // graph + report on disk through the commons write path
    const graphJson = JSON.parse(await commons.read('STATE/folder-12/codegraph.json')) as WorkspaceGraph
    assert.strictEqual(graphJson.nodes.length, 3)
    assert.strictEqual(graphJson.externalCount, 1)
    assert.ok(graphJson.edges.some((e) => e.from === 'src/index.ts' && e.to === 'src/util.ts' && e.kind === 'imports'))
    const report = await commons.read('STATE/folder-12/report.md')
    assert.ok(report.includes('src/util.ts'), 'report mentions hub file')

    // digest gained the CODEMAP section via the commons write path
    const digest = await commons.read('STATE/digest.md')
    assert.ok(digest.includes('## CODEMAP'), 'digest has a CODEMAP section')
    assert.ok(digest.includes('- src/util.ts (1)'), 'digest lists the hub with in-degree')
    assert.ok(digest.includes('README.md'), 'digest lists the orphan')

    // event emitted with the catalog payload shape { files, clusters, hubs }
    const rebuilt = bus.events.find((e) => e.type === 'codegraph.rebuilt')
    assert.ok(rebuilt, 'codegraph.rebuilt emitted')
    assert.deepStrictEqual(rebuilt!.payload, { files: 3, clusters: 1, hubs: 1 })

    // load() round-trips the persisted graph
    const loaded = await codegraph.load()
    assert.ok(loaded && loaded.nodes.length === 3, 'load() returns the built graph')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('load(): null when no graph has been built yet', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-f12-load-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const commons = await openCommons(memoryDir)
    const codegraph = createCodegraph({ commons, bus: new StubBus(), memoryDir, sourceTree: 'WORKSPACE' })
    assert.strictEqual(await codegraph.load(), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// CRASH-SAFETY PROBE: one malformed file → logged skip, rebuild completes
// ---------------------------------------------------------------------------

test('crash-safety probe: malformed file is skipped, graph is otherwise complete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-f12-crash-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const commons = await openCommons(memoryDir)
    await makeWorkspace(memoryDir, true)
    const codegraph = createCodegraph({ commons, bus: new StubBus(), memoryDir, sourceTree: 'WORKSPACE' })

    const result = await codegraph.rebuild()
    assert.ok(result.skipped.includes('src/broken.ts'), 'malformed file appears as a logged skip')
    assert.strictEqual(result.files, 3, 'all well-formed files are in the graph')

    const graphJson = JSON.parse(await commons.read('STATE/folder-12/codegraph.json')) as WorkspaceGraph
    const ids = graphJson.nodes.map((n) => n.id)
    assert.ok(ids.includes('src/index.ts') && ids.includes('src/util.ts') && ids.includes('README.md'))
    assert.ok(!ids.includes('src/broken.ts'), 'malformed file produced no node')
    assert.ok(graphJson.edges.some((e) => e.from === 'src/index.ts' && e.to === 'src/util.ts'), 'edges are intact')

    const report = await commons.read('STATE/folder-12/report.md')
    assert.ok(report.includes('src/broken.ts'), 'report logs the skip')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Full wiring: digest + planner-prompt integration + the rate-limited hook
// ---------------------------------------------------------------------------

/**
 * The full-wiring transport. Phase E3 (A3, per R21/R24): EVERY response is the
 * full canonical phase-02 grammar a real adapter emits - text, then usage, then
 * a terminal `done`. This stub previously yielded text only, so the compactor
 * path was exercised through `F04TransportAdapter` WITHOUT a `done` terminator
 * and could never have caught a regression in it. It now terminates like the
 * crew and leader paths do.
 */
function mockF02Transport(prompts?: string[]): F02Transport {
  return {
    async *complete(): AsyncIterable<TransportChunk> {
      const req = arguments[0] as { messages: { content: string }[] }
      const prompt = req.messages.map((m) => m.content).join('\n')
      if (prompts) prompts.push(prompt)
      if (prompt.includes('TASK_DECOMPOSITION')) {
        yield { type: 'text', text: JSON.stringify([{ id: 'T-01', path: 'src/index.ts', description: 'Implement the app', acceptance: ['compiles cleanly'] }]) }
      } else if (prompt.includes('CODEMAP') || prompt.includes('DIGEST') || prompt.includes('ARCH')) {
        // compactor chat (via F04TransportAdapter): the five canonical sections
        yield { type: 'text', text: 'ARCH\n- compressed arch\n\nIFACE\n- compressed iface\n\nOPEN\n- open risk\n\nSETTLED\n- settled decision\n\nPINS\n- pin line' }
      } else {
        yield { type: 'text', text: '{}' }
      }
      yield { type: 'usage', inputTokens: 20, outputTokens: 30 }
      yield { type: 'done', finishReason: 'stop' }
    },
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return cond()
}

async function wireFresh(memoryDir: string, prompts?: string[]) {
  const outputDir = path.join(memoryDir, '..', 'OUTPUT')
  const runtime = initOpusDeck({
    memoryDir,
    outputDir,
    brief: 'build a trivial app',
    goalState: ['app builds'],
    crew: {
      lead: { id: 'lead', provider: 'custom' as const, model: 'lm', contextWindowTokens: 4096 },
      engineers: [{ id: 'eng-1', provider: 'custom' as const, model: 'em', contextWindowTokens: 4096 }],
      security: [
        { id: 'sec-1', provider: 'custom' as const, model: 'sm', contextWindowTokens: 4096 },
        { id: 'sec-2', provider: 'custom' as const, model: 'sm2', contextWindowTokens: 4096 },
      ],
    },
  })
  const wired = await wireOpusDeck(runtime, {
    transport: mockF02Transport(prompts),
    leadModelId: 'lead',
    auditorModelIds: ['sec-1', 'sec-2'],
  })
  return { runtime, wired }
}

test('wiring: rebuild → CODEMAP reaches the planner prompt through the digest slot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-f12-wire-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const { wired } = await wireFresh(memoryDir)
    assert.ok(wired.f12.codegraph, 'codegraph is wired into the composition root')

    const ws = path.join(memoryDir, 'WORKSPACE', 'src')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'index.ts'), "import { helper } from './util'\nexport function main() { return helper() }\n", 'utf8')
    fs.writeFileSync(path.join(ws, 'util.ts'), 'export function helper() { return 1 }\n', 'utf8')

    const result = await wired.f12.rebuildCodegraph()
    assert.strictEqual(result.files, 2)
    assert.deepStrictEqual(result.skipped, [])

    // the CODEMAP section reached STATE/digest.md through the commons write path
    const digest = await wired.commons.read('STATE/digest.md')
    assert.ok(digest.includes('## CODEMAP'), 'digest contains the CODEMAP section')
    assert.ok(digest.includes('- src/util.ts (1)'), 'digest lists the hub')

    // the planner/worker prompt gains the section through the NORMAL digest slot
    // (slot 2 of the five-slot prompt — no separate injection channel)
    const prompt = buildPrompt({
      task: { id: 'T-01', description: 'Implement the app' },
      brief: 'build a trivial app',
      digest,
      presence: [],
      workingSet: [],
      bus: wired.hub,
    })
    assert.ok(prompt.includes('## 2. STATE/digest.md'), 'prompt has the digest slot')
    assert.ok(prompt.includes('## CODEMAP'), 'CODEMAP section reached the prompt via the digest slot')
    assert.ok(prompt.includes('- src/util.ts (1)'), 'hub line reached the prompt')

    // codegraph.rebuilt on the shared hub with the catalog payload
    const published = await wired.hub.published()
    const rebuilt = published.find((e) => e.type === 'codegraph.rebuilt')
    assert.ok(rebuilt, 'codegraph.rebuilt emitted on the hub')
    assert.deepStrictEqual(rebuilt!.payload, { files: 2, clusters: 1, hubs: 1 })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('live: writes through the wired commons trigger a real codegraph rebuild (no manual emission)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-f12-live-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const { wired } = await wireFresh(memoryDir)

    const ws = path.join(memoryDir, 'WORKSPACE', 'src')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\n', 'utf8')

    const rebuiltCount = (): number => wired.hub.published().filter((e) => e.type === 'codegraph.rebuilt').length

    // 1. a write through the REAL wiring path: the wrapped commons emits
    //    memory.written after every successful write; the hook does the rest.
    //    NO manual event emission anywhere in this test.
    await wired.commons.write({
      path: 'WORKSPACE/src/a.ts',
      diff: { added: ['export const a = 1;'], removedLineCount: 0, atLine: 1 },
      intent: 'live write through wired commons',
      author: 'lead',
    })
    assert.ok(await waitFor(() => rebuiltCount() === 1), 'codegraph.rebuilt fired on the hub from a live commons write')

    const graphJson = JSON.parse(await wired.commons.read('STATE/folder-12/codegraph.json')) as WorkspaceGraph
    assert.ok(graphJson.nodes.some((n) => n.id === 'src/a.ts'), 'live-written file is in the rebuilt graph (source-tree-relative id)')

    // 2. fingerprint gate: an identical rewrite does not rebuild again
    await wired.commons.write({
      path: 'WORKSPACE/src/a.ts',
      diff: { added: ['export const a = 1;'], removedLineCount: 1, atLine: 1 },
      intent: 'identical rewrite',
      author: 'lead',
    })
    await new Promise((r) => setTimeout(r, 400))
    assert.strictEqual(rebuiltCount(), 1, 'identical state never rebuilds (fingerprint gate)')

    // 3. a write outside the source tree is filtered out
    await wired.commons.write({
      path: 'STATE/other.json',
      diff: { added: ['{}'], removedLineCount: 0, atLine: 1 },
      intent: 'state write outside the source tree',
      author: 'lead',
    })
    await new Promise((r) => setTimeout(r, 400))
    assert.strictEqual(rebuiltCount(), 1, 'non-source-tree write did not rebuild')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// R6: CODEMAP is regenerable state — compaction may demote it; rebuild restores
// ---------------------------------------------------------------------------

test('R6: compaction with a CODEMAP section produces a valid digest; rebuild restores the section', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-f12-r6-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const { wired } = await wireFresh(memoryDir)

    const ws = path.join(memoryDir, 'WORKSPACE', 'src')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'index.ts'), "import { helper } from './util'\nexport function main() { return helper() }\n", 'utf8')
    fs.writeFileSync(path.join(ws, 'util.ts'), 'export function helper() { return 1 }\n', 'utf8')

    // Direction (a): rebuild → CODEMAP present; compaction still yields a valid digest
    await wired.f12.rebuildCodegraph()
    let digest = await wired.commons.read('STATE/digest.md')
    assert.ok(digest.includes('## CODEMAP'), 'precondition: CODEMAP present before compaction')

    const compacted = await wired.compactor.compact(true)
    assert.strictEqual(compacted.ran, true, 'compaction ran')
    digest = await wired.commons.read('STATE/digest.md')
    assert.ok(digest.includes('# DIGEST (compacted v1)'), 'compacted digest has a valid header')
    for (const section of ['ARCH', 'IFACE', 'OPEN', 'SETTLED', 'PINS']) {
      assert.ok(digest.includes(section), `compacted digest keeps the ${section} section`)
    }
    assert.ok(!digest.includes('## CODEMAP'), 'CODEMAP was demoted by compaction (correct per R6)')
    assert.ok(fs.existsSync(path.join(memoryDir, 'ARCHIVE', 'digest@v1.md')), 'previous digest archived')

    // Direction (b): the next rebuild restores the CODEMAP section
    const result = await wired.f12.rebuildCodegraph()
    assert.strictEqual(result.files, 2)
    digest = await wired.commons.read('STATE/digest.md')
    assert.ok(digest.includes('## CODEMAP'), 'rebuild restored the CODEMAP section after compaction')
    assert.ok(digest.includes('- src/util.ts (1)'), 'restored section carries the hub data')
    assert.ok(digest.includes('# DIGEST (compacted v1)'), 'the rest of the compacted digest is preserved')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Live planner-prompt integration: rebuilt CODEMAP reaches plan()
// ---------------------------------------------------------------------------

test('live: rebuilt CODEMAP reaches the leader plan prompt through the digest slot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-f12-plan-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const prompts: string[] = []
    const { wired } = await wireFresh(memoryDir, prompts)

    const ws = path.join(memoryDir, 'WORKSPACE', 'src')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'index.ts'), "import { helper } from './util'\nexport function main() { return helper() }\n", 'utf8')
    fs.writeFileSync(path.join(ws, 'util.ts'), 'export function helper() { return 1 }\n', 'utf8')

    await wired.f12.rebuildCodegraph()

    // plan() through the wired leader with a mock transport — end to end,
    // no composed prompt: the digest slot must carry the CODEMAP section.
    const tasks = await wired.leader.plan({
      brief: 'build a trivial app',
      goalState: 'app builds',
      crew: { lead: 'lead', engineers: ['eng-1'] },
    })
    assert.ok(tasks.length >= 1, 'plan still returns tasks')

    const planPrompt = prompts.join('\n')
    assert.ok(planPrompt.includes('TASK_DECOMPOSITION'), 'the plan call happened')
    assert.ok(planPrompt.includes('## CODEMAP'), 'plan prompt contains the CODEMAP section via the digest slot')
    assert.ok(planPrompt.includes('- src/util.ts (1)'), 'plan prompt contains the hub data')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Event catalog audit
// ---------------------------------------------------------------------------

test('catalog audit: every event name has a producer call site in src/ or is marked reserved in PROVENANCE', () => {
  // 1. The catalog: parse the EventName union from the catalog source
  //    (tsconfig emits no .d.ts, so the .ts source is the parse target).
  const typesSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'config', 'types.ts'), 'utf8')
  const unionBlock = /export type EventName =\s*\n((?:\s*\|\s*'[^']+'\s*\n)+)/.exec(typesSrc)
  assert.ok(unionBlock, 'EventName union found in types.ts')
  const catalog = [...unionBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.ok(catalog.length >= 20, `catalog parsed (${catalog.length} events)`)

  // 2. Producer call sites: scan non-test sources under src/.
  const srcRoot = path.join(__dirname, '..', '..', 'src')
  const producers = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
        const text = fs.readFileSync(full, 'utf8')
        for (const name of catalog) {
          if (producers.has(name)) continue
          if (text.includes(`.emit('${name}'`) || text.includes(`.emit("${name}"`)) {
            producers.set(name, full)
          }
        }
      }
    }
  }
  walk(srcRoot)

  // 3. Reserved markings: parse the PROVENANCE event catalog table.
  const provenance = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'PROVENANCE.md'), 'utf8')
  const reserved = new Set<string>()
  for (const m of provenance.matchAll(/^\| `([^`]+)` \| (.+) \|$/gm)) {
    if (/reserved/i.test(m[2])) reserved.add(m[1])
  }

  // 4. Every catalog event is produced or reserved — and the two sets match.
  const missing = catalog.filter((name) => !producers.has(name) && !reserved.has(name))
  assert.deepStrictEqual(missing, [], `every catalog event has a producer or is reserved (missing: ${missing.join(', ') || 'none'})`)
  const staleReserved = [...reserved].filter((name) => producers.has(name) || !catalog.includes(name))
  assert.deepStrictEqual(staleReserved, [], `reserved markings match the producer-less set exactly (stale: ${staleReserved.join(', ') || 'none'})`)
})

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

test('cli: codegraph build command is registered', async () => {
  const { Commands } = await import('../cli/commands.js')
  assert.ok(Commands.has('codegraph'), 'codegraph command registered')
  const handler = Commands.get('codegraph')!
  await handler('build')
  await assert.rejects(
    async () => { await handler() },
    (err: any) => err.code === 'CLI-CODEGRAPH-001',
    'usage without "build" is rejected',
  )
  await assert.rejects(
    async () => { await handler('rebuild') },
    (err: any) => err.code === 'CLI-CODEGRAPH-001',
    'unknown subcommand is rejected',
  )
})
