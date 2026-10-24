/**
 * Phase 11 (f11) seam tests — R13 directed repair.
 *
 *  1. ATTRIBUTION (repair 2): a finding produced by reviewer model
 *     "reviewer-x" persists with that model id in the `detector` field —
 *     never the rule id, never null.
 *  2. CONSUMPTION POINT (repair 4): a caller that subverts the exported
 *     `bundleFiles` (drops a file from the bundles it returns) is still
 *     caught by the coverage check the review agent runs itself, before any
 *     LLM call — even though the subverted bundler did not throw.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'node:path'
import { ReviewAgent } from './review-agent.js'
import { bundleFiles } from './bundle.js'
import type { ReviewAgentDeps, PersistedFinding } from './types.js'

/** Minimal deps: real file reads off `memoryDir`, a scripted transport, a
 *  persistFindings spy. No holdersOf (held-claim filtering skipped). */
function stubDeps(
  memoryDir: string,
  persisted: PersistedFinding[][],
  reviewModelId: string,
  findings: unknown[],
): ReviewAgentDeps {
  return {
    hub: { emit() {} },
    commons: {
      read: async (p: string) => fs.readFileSync(path.join(memoryDir, ...p.split('/')), 'utf8'),
      write: async () => 'txn-000001',
    },
    transport: {
      async *complete() {
        yield { type: 'text' as const, text: JSON.stringify(findings) }
      },
    },
    estimateTokens: (t: string) => t.length,
    persistFindings: async (rows: readonly PersistedFinding[]) => {
      persisted.push([...rows])
    },
    escalationQueue: { push: async () => {} },
    auditorModelIds: [],
    reviewModelId,
  }
}

test('attribution: persisted detector is the reviewer model id, not the rule id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-f11-attribution-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    fs.mkdirSync(path.join(memoryDir, 'WORKSPACE', 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(memoryDir, 'WORKSPACE', 'src', 'app.ts'),
      'const input = prompt();\neval(input);\n',
      'utf8',
    )

    const persisted: PersistedFinding[][] = []
    const deps = stubDeps(memoryDir, persisted, 'reviewer-x', [
      {
        ruleId: 'SEC-001',
        path: 'WORKSPACE/src/app.ts',
        line: 2,
        evidence: 'eval(input);',
        message: 'eval found',
        patchStrategy: undefined,
      },
    ])
    const agent = new ReviewAgent(deps)
    const result = await agent.review({ runId: 'run-attr', brief: 'b', goalState: [], memoryDir })

    assert.strictEqual(result.findings.length, 1, 'the eval finding survived positioning/reflection')
    assert.strictEqual(result.findings[0].ruleId, 'SEC-001')
    assert.strictEqual(persisted.length, 1, 'persistFindings called exactly once')
    assert.strictEqual(persisted[0].length, 1, 'exactly one row persisted')
    assert.strictEqual(persisted[0][0].detector, 'reviewer-x', 'detector is the reviewer model id')
    assert.notStrictEqual(persisted[0][0].detector, 'SEC-001', 'detector is NOT the rule id')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('coverage: a subverted bundleFiles export is caught at the consumption point', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-f11-subvert-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    fs.mkdirSync(path.join(memoryDir, 'WORKSPACE', 'src'), { recursive: true })
    fs.writeFileSync(path.join(memoryDir, 'WORKSPACE', 'src', 'alpha.ts'), 'const a = 1;\n', 'utf8')
    fs.writeFileSync(path.join(memoryDir, 'WORKSPACE', 'src', 'zebra.ts'), 'const z = 1;\n', 'utf8')

    const dropped = 'WORKSPACE/src/zebra.ts'
    // Subvert the compiled export the review agent calls: run the real bundler,
    // then silently drop a file from every bundle it returned — so the
    // bundler's own post-condition passes but coverage is broken.
    const bundleMod = require('./bundle.js') as { bundleFiles: typeof bundleFiles }
    const original = bundleMod.bundleFiles
    bundleMod.bundleFiles = (files, criteria, est) => {
      const bundles = original(files, criteria, est)
      return bundles.map((b) => ({ ...b, files: b.files.filter((f) => f !== dropped) }))
    }

    try {
      const persisted: PersistedFinding[][] = []
      const deps = stubDeps(memoryDir, persisted, 'reviewer-x', [])
      const agent = new ReviewAgent(deps)
      await assert.rejects(
        agent.review({
          runId: 'run-subvert',
          brief: 'b',
          goalState: [],
          memoryDir,
          files: ['WORKSPACE/src/alpha.ts', dropped],
        }),
        /Bundle coverage failure/,
        'the consumption-point coverage check throws despite the subverted bundler',
      )
      assert.strictEqual(persisted.length, 0, 'no findings persisted after a coverage failure')
    } finally {
      bundleMod.bundleFiles = original
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
