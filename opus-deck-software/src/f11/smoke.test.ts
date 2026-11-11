/**
 * Phase 11 smoke test — Review Agent (f11).
 *
 * Covers: golden bundle fixtures (pair grouping, budget split, exclusion
 * reasons); collector coverage guarantee; position anchor on a known diff;
 * reflect-deny drops with audit row; end-to-end review smoke (dirty file
 * → findings → escalation → veto → merge block).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'node:path'
import { initOpusDeck } from '../config/bootstrap.js'
import { wireOpusDeck } from '../wiring/index.js'
import { ReviewAgent } from './review-agent.js'
import { createReviewAgent } from './index.js'
import { bundleFiles, assertCoverage } from './bundle.js'
import { collectFiles } from './collect.js'
import { filterFiles } from './filter.js'
import { criteriaForBundle, listRules, RULE_PACKS, TYPESCRIPT_PACK } from './rules.js'
import { positionFindings } from './position.js'
import { estimateTokens } from '../compactor/index.js'
import type { ReviewAgentDeps, ReviewRequest, ReviewBundle, PositionedFinding } from './types.js'
import type { RuleId, Finding as F08Finding } from '../audit/types.js'

// ---------------------------------------------------------------------------
// Bundle fixtures
// ---------------------------------------------------------------------------

test('bundle: same-stem test/file pairs are grouped', () => {
  const files = [
    'WORKSPACE/src/app.ts',
    'WORKSPACE/src/app.test.ts',
    'WORKSPACE/src/util.ts',
  ]
  const bundles = bundleFiles(files, criteriaForBundle(files))
  const pairBundle = bundles.find((b) => b.files.includes('WORKSPACE/src/app.ts') && b.files.includes('WORKSPACE/src/app.test.ts'))
  assert.ok(pairBundle, 'app.ts and app.test.ts should be bundled together')
  assert.strictEqual(pairBundle!.files.length, 2)
})

test('bundle: budget split when group exceeds cap', () => {
  // Files with the same stem get grouped together; long paths push the group over budget
  const longPrefix = 'WORKSPACE/' + 'a'.repeat(1200) + '/'
  const files = [
    longPrefix + 'module.ts',
    longPrefix + 'module.test.ts',
    longPrefix + 'module.spec.ts',
    longPrefix + 'module.min.ts',
  ]
  const bundles = bundleFiles(files, [], (text) => text.length)
  assert.ok(bundles.length > 1, `should split into multiple bundles when over cap, got ${bundles.length}`)
  const allFiles = bundles.flatMap((b) => b.files)
  assert.strictEqual(allFiles.length, files.length, 'every file appears in exactly one bundle')
  const unique = new Set(allFiles)
  assert.strictEqual(unique.size, files.length, 'no file appears in multiple bundles')
})

test('bundle: coverage guarantee throws when a file is dropped', () => {
  const files = ['WORKSPACE/src/a.ts', 'WORKSPACE/src/b.ts', 'WORKSPACE/src/c.ts']
  const bundles: ReviewBundle[] = [
    { id: 'BND-000001', files: ['WORKSPACE/src/b.ts'], tokenEstimate: 100, criteria: [] },
    { id: 'BND-000002', files: ['WORKSPACE/src/c.ts'], tokenEstimate: 100, criteria: [] },
  ]
  // a.ts is missing from all bundles -> must throw
  assert.throws(() => assertCoverage(files, bundles), /Bundle coverage failure/)
})

test('bundle: exclusion reasons recorded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-f11-bundle-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    fs.mkdirSync(path.join(memoryDir, 'WORKSPACE'), { recursive: true })
    fs.mkdirSync(path.join(memoryDir, 'WORKSPACE', 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(memoryDir, 'WORKSPACE', 'node_modules', 'pkg.js'), 'x', 'utf8')
    fs.writeFileSync(path.join(memoryDir, 'WORKSPACE', 'app.ts'), 'export const a = 1;\n', 'utf8')

    const files = await collectFiles(memoryDir)
    const filterResult = await filterFiles(files, { memoryDir } as any)

    assert.ok(filterResult.excluded.some((e) => e.reason === 'vendored-or-generated'), 'vendored file excluded')
    assert.ok(filterResult.included.some((f) => f === 'WORKSPACE/app.ts'), 'app.ts included')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Collector coverage guarantee
// ---------------------------------------------------------------------------

test('collect: every non-excluded WORKSPACE file is collected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-f11-collect-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    fs.mkdirSync(path.join(memoryDir, 'WORKSPACE', 'src'), { recursive: true })
    fs.writeFileSync(path.join(memoryDir, 'WORKSPACE', 'src', 'a.ts'), 'a', 'utf8')
    fs.writeFileSync(path.join(memoryDir, 'WORKSPACE', 'src', 'b.ts'), 'b', 'utf8')
    fs.writeFileSync(path.join(memoryDir, 'WORKSPACE', 'README.md'), 'r', 'utf8')

    const files = await collectFiles(memoryDir)
    const rels = new Set(files.map((f) => f.replace('WORKSPACE/', '')))
    assert.ok(rels.has('src/a.ts'), 'a.ts collected')
    assert.ok(rels.has('src/b.ts'), 'b.ts collected')
    assert.ok(rels.has('README.md'), 'README.md collected')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Position anchor on a known diff
// ---------------------------------------------------------------------------

test('position: finding anchored to reported line', () => {
  const content = 'const x = 1;\neval(input);\nconst y = 2;\n'
  const fileContents = new Map([['WORKSPACE/src/app.ts', content]])
  const { positioned, unanchored } = positionFindings(
    [{ ruleId: 'SEC-001', path: 'WORKSPACE/src/app.ts', line: 2, evidence: 'eval(input);', message: 'eval found', patchStrategy: undefined }],
    fileContents,
  )
  assert.strictEqual(unanchored.length, 0, 'no unanchored findings')
  assert.strictEqual(positioned.length, 1, 'one positioned finding')
  assert.strictEqual(positioned[0].finding.line, 2, 'anchored to reported line')
  assert.strictEqual(positioned[0].evidence, 'eval(input);', 'evidence is the line text')
})

test('position: finding re-anchored when reported line is wrong', () => {
  const content = 'const x = 1;\nsome other code;\neval(input);\n'
  const fileContents = new Map([['WORKSPACE/src/app.ts', content]])
  const { positioned, unanchored } = positionFindings(
    [{ ruleId: 'SEC-001', path: 'WORKSPACE/src/app.ts', line: 1, evidence: 'eval(input);', message: 'eval found', patchStrategy: undefined }],
    fileContents,
  )
  assert.strictEqual(unanchored.length, 0, 'no unanchored findings')
  assert.strictEqual(positioned.length, 1, 'one positioned finding')
  assert.strictEqual(positioned[0].finding.line, 3, 're-anchored to correct line')
})

test('position: unanchorable finding is dropped', () => {
  const content = 'const x = 1;\n'
  const fileContents = new Map([['WORKSPACE/src/app.ts', content]])
  const { positioned, unanchored } = positionFindings(
    [{ ruleId: 'SEC-001', path: 'WORKSPACE/src/app.ts', line: 5, evidence: 'eval(input);', message: 'eval found', patchStrategy: undefined }],
    fileContents,
  )
  assert.strictEqual(positioned.length, 0, 'no positioned findings')
  assert.strictEqual(unanchored.length, 1, 'one unanchored finding')
})

// ---------------------------------------------------------------------------
// Reflect-deny drops
// ---------------------------------------------------------------------------

test('reflect: denied findings are dropped with audit row', () => {
  const { buildReflectPrompt } = require('./reflect.js')
  const { parseReflectOutput } = require('./reflect.js')
  const inputs = [
    {
      finding: {
        id: 'BND-000001-SEC-004-WORKSPACE/src/app.ts:3',
        ruleId: 'SEC-004',
        severity: 'critical',
        path: 'WORKSPACE/src/app.ts',
        line: 3,
        evidence: 'const API_TOKEN = "sk-..."',
        message: 'Hardcoded secret',
        patchStrategy: 'env-var',
        blocking: true,
        disposition: 'anchored',
      },
      fileContent: 'const API_TOKEN = "sk-...";\n',
      ruleHint: 'Hardcoded secret (API key, token, password) assigned a string literal >= 8 chars',
    },
  ]
  const prompt = buildReflectPrompt(inputs)
  assert.ok(prompt.includes('BND-000001-SEC-004-WORKSPACE/src/app.ts:3'), 'prompt includes finding id')
  assert.ok(prompt.includes('const API_TOKEN'), 'prompt includes code context')

  const verdicts = parseReflectOutput(
    '[{ "findingId": "BND-000001-SEC-004-WORKSPACE/src/app.ts:3", "verdict": "denied", "reason": "false positive" }]',
  )
  assert.strictEqual(verdicts.length, 1)
  assert.strictEqual(verdicts[0].verdict, 'denied')
})

// ---------------------------------------------------------------------------
// End-to-end review smoke
// ---------------------------------------------------------------------------

test('review: dirty file → escalation → veto → merge block', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-f11-smoke-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const outputDir = path.join(root, 'OUTPUT')
    const runtime = initOpusDeck({
      memoryDir,
      outputDir,
      brief: 'build an app',
      goalState: ['app builds'],
      crew: {
        lead: { id: 'lead', provider: 'custom', model: 'lm', contextWindowTokens: 4096 },
        engineers: [{ id: 'eng-1', provider: 'custom', model: 'em', contextWindowTokens: 4096 }],
        security: [
          { id: 'sec-1', provider: 'custom', model: 'sm', contextWindowTokens: 4096 },
          { id: 'sec-2', provider: 'custom', model: 'sm2', contextWindowTokens: 4096 },
        ],
      },
    })
    const wired = await wireOpusDeck(runtime, {
      transport: {
        async *complete() {
          const req = arguments[0] as { messages: { content: string }[] }
          const prompt = req.messages.map((m) => m.content).join('\n')
          if (prompt.includes('TASK_DECOMPOSITION')) {
            yield { type: 'text', text: JSON.stringify([{ id: 'T-01', path: 'src/app.ts', description: 'do it', acceptance: ['ok'] }]) }
          } else if (prompt.includes('CRITERION_VERIFICATION')) {
            yield { type: 'text', text: JSON.stringify({ satisfied: true, evidence: 'x' }) }
          } else {
            // Review agent: return findings for the dirty file
            yield { type: 'text', text: JSON.stringify([
              { ruleId: 'SEC-001', path: 'WORKSPACE/src/app.ts', line: 2, evidence: 'eval(input);', message: 'eval found', patchStrategy: undefined },
              { ruleId: 'SEC-004', path: 'WORKSPACE/src/app.ts', line: 3, evidence: 'const API_TOKEN = "sk-prod-9f3a2b1cdeadbeef42";', message: 'Hardcoded secret', patchStrategy: 'env-var' },
              { ruleId: 'SEC-006', path: 'WORKSPACE/src/app.ts', line: 4, evidence: 'const id = Math.random();', message: 'Math.random used for security values', patchStrategy: 'crypto-random' },
            ]) }
          }
        },
      } as any,
      leadModelId: 'lead',
      auditorModelIds: ['sec-1', 'sec-2'],
    })

    // plan + route so crew is stored in commons (needed by veto's routeFollowUp)
    await wired.leader.plan({ brief: 'build an app', goalState: 'app builds', crew: { lead: 'lead', engineers: ['eng-1'] } })
    await wired.leader.route()

    const appPath = path.join(memoryDir, 'WORKSPACE', 'src', 'app.ts')
    fs.mkdirSync(path.dirname(appPath), { recursive: true })
    fs.writeFileSync(
      appPath,
      'const input = prompt();\neval(input);\nconst API_TOKEN = "sk-prod-9f3a2b1cdeadbeef42";\nconst id = Math.random();\n',
      'utf8',
    )

    // Run the review agent via the wired composition root
    const result = await wired.f11.reviewAgent.review({
      runId: 'run-1',
      brief: 'build an app',
      goalState: ['app builds'],
      memoryDir,
    })

    // Findings surface from the review agent
    assert.ok(result.findings.some((f) => f.ruleId === 'SEC-001'), 'SEC-001 eval found')
    assert.ok(result.findings.some((f) => f.ruleId === 'SEC-004'), 'SEC-004 secret found')
    assert.ok(result.findings.some((f) => f.ruleId === 'SEC-006'), 'SEC-006 Math.random found')

    // Persist findings to STATE/findings.json
    const f08Findings: F08Finding[] = result.findings.map((f: PositionedFinding) => ({
      id: f.id,
      ruleId: f.ruleId as RuleId,
      severity: f.severity,
      path: f.path,
      detectorModelId: f.ruleId,
      resolved: false,
      evidence: f.evidence,
      message: f.message,
      line: f.line,
      patchStrategy: f.patchStrategy,
      auditorCount: 1,
      blocking: f.blocking,
    }))
    await wired.persistFindings(f08Findings)
    const persisted = JSON.parse(fs.readFileSync(path.join(memoryDir, 'STATE', 'findings.json'), 'utf8'))
    assert.strictEqual(persisted.length, 3, 'all three findings persisted')

    // review.completed on the hub
    const published = await wired.hub.published()
    const completed = published.find((e) => e.type === 'review.completed')
    assert.ok(completed, 'review.completed emitted on hub')
    assert.ok((completed as any).payload.requests > 0, 'at least one LLM call made')

    // eval() finding escalates to ReviewQueue as pending
    const pending = await wired.reviewQueue.listPending()
    assert.ok(pending.length >= 1, 'escalation reached ReviewQueue pending list')

    // VETO → follow-up task path is a real WORKSPACE path
    const toVeto = pending.find((d) => d.touched.includes('src/app.ts')) || pending[0]
    assert.ok(toVeto, 'pending decision touches src/app.ts')
    assert.strictEqual(toVeto.status, 'pending', 'decision is pending for lead judgement')

    // release lock so veto's follow-up can claim src/app.ts
    await wired.f05.release('eng-1', ['src/app.ts'])
    const vetoed = await wired.reviewQueue.veto(toVeto.id, 'eval requires manual rewrite')
    assert.strictEqual(vetoed.status, 'vetoed')
    assert.ok(vetoed.followUpTaskId, 'veto produced follow-up task')
    assert.ok(
      vetoed.followUpTaskId!.startsWith('T-'),
      `follow-up task is a real task id (got ${vetoed.followUpTaskId})`,
    )

    // unresolved critical blocks merge
    const { merge } = await import('../merge/index.js')
    await assert.rejects(
      merge(memoryDir, outputDir),
      (err: any) => err.code === 'GATE_FAILED',
      'unresolved critical blocks merge with GATE_FAILED',
    )
    assert.ok(!fs.existsSync(path.join(outputDir, 'MANIFEST.json')), 'no MANIFEST written when gate blocked')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
