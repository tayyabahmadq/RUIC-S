/**
 * Phase 11 — R22 (E1) FIX 2 regression: STATE/findings.json is never
 * uninformed-dropped.
 *
 * Scenarios:
 *   B1. signOff() leaves seeded findings (including resolved:true rows)
 *       intact — the mandated standing guard.
 *   B2. the f11 review agent's routed persist (through the canonical writer)
 *       must NOT erase previously persisted rows — this is the actual
 *       clobber path the C1 shell observed (a clean review persists [] and
 *       used to delete the whole file). MUST fail pre-fix (temp-copy proven).
 *   B3. wired.persistFindings merges by id: existing rows survive, an
 *       existing resolution never goes back to unresolved, new rows append.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initOpusDeck } from '../config/bootstrap.js'
import { wireOpusDeck } from './index.js'
import type { Transport as F02Transport, TransportChunk } from '../transport/types.js'
import type { ResolvedCrew } from '../config/types.js'

/* ---------- helpers ---------- */

function crewModel(id: string, model: string) {
  return { id, provider: 'custom' as const, model, contextWindowTokens: 4096 }
}

function crew(): ResolvedCrew {
  return {
    lead: crewModel('lead', 'lead-model'),
    engineers: [crewModel('eng-1', 'eng-model')],
    security: [crewModel('sec-1', 'sec-model'), crewModel('sec-2', 'sec-model-2')],
  }
}

/** A clean-run transport: empty plan, satisfied verify, trivial write intent. */
function cleanTransport(): F02Transport {
  return {
    async *complete(): AsyncIterable<TransportChunk> {
      const req = arguments[0] as { messages: { content: string }[] }
      const prompt = req.messages.map((m) => m.content).join('\n')
      if (prompt.includes('TASK_DECOMPOSITION')) {
        yield { type: 'text', text: '[]' }
      } else if (prompt.includes('CRITERION_VERIFICATION')) {
        yield { type: 'text', text: JSON.stringify({ satisfied: true, evidence: 'src/app.ts:1' }) }
      } else {
        yield { type: 'text', text: JSON.stringify({ intent: 'write', path: 'src/app.ts', added: ['export const app = 1;'], atLine: 1, removedLineCount: 0 }) }
      }
    },
  }
}

const SEEDED = [
  { id: 'F-01', severity: 'critical', path: 'src/app.ts', line: 4, detector: 'sec-1', resolved: true },
  { id: 'F-02', severity: 'medium', path: 'src/app.ts', line: 7, detector: 'sec-2', resolved: false },
]

function findingsFile(memoryDir: string): string {
  return path.join(memoryDir, 'STATE', 'findings.json')
}

function seedFindings(memoryDir: string): void {
  fs.writeFileSync(findingsFile(memoryDir), JSON.stringify(SEEDED, null, 2), 'utf8')
}

interface TestContext {
  root: string
  memoryDir: string
  wired: Awaited<ReturnType<typeof wireOpusDeck>>
}

async function boot(root: string): Promise<TestContext> {
  const memoryDir = path.join(root, 'COMMONS')
  const outputDir = path.join(root, 'OUTPUT')
  const runtime = initOpusDeck({
    memoryDir, outputDir, brief: 'build an app', goalState: ['app builds'], crew: crew(),
  })
  const wired = await wireOpusDeck(runtime, {
    transport: cleanTransport(), leadModelId: 'lead', auditorModelIds: ['sec-1', 'sec-2'],
  })
  return { root, memoryDir, wired }
}

/* ---------- B1: the mandated R22 guard — signOff leaves findings intact ---------- */

test('R22: signOff does not clobber STATE/findings.json (resolved rows survive intact)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-e1-signoff-'))
  try {
    const { memoryDir, wired } = await boot(root)
    seedFindings(memoryDir)
    await wired.leader.signOff()
    const after = JSON.parse(fs.readFileSync(findingsFile(memoryDir), 'utf8'))
    assert.deepStrictEqual(after, SEEDED, 'seeded findings (resolved:true included) survive signOff')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---------- B2: the real clobber path — the f11 review persist ---------- */

test('R22: the f11 review persist preserves previously persisted resolved findings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-e1-review-'))
  try {
    const { memoryDir, wired } = await boot(root)
    seedFindings(memoryDir)
    // Clean review of an empty WORKSPACE: the agent persists its OWN set —
    // an empty one — through the canonical findings writer. Pre-fix that
    // overwrote STATE/findings.json wholesale and erased the seeded rows.
    await wired.f11.reviewAgent.review({
      runId: 'run-clean', brief: 'build an app', goalState: ['app builds'], memoryDir,
    })
    const after = JSON.parse(fs.readFileSync(findingsFile(memoryDir), 'utf8')) as Array<{ id: string; resolved: boolean }>
    const f01 = after.find((row) => row.id === 'F-01')
    assert.ok(f01 !== undefined, 'seeded resolved finding still present after the review persist')
    assert.strictEqual(f01.resolved, true, 'the resolved flag survived')
    const f02 = after.find((row) => row.id === 'F-02')
    assert.ok(f02 !== undefined, 'seeded unresolved finding still present after the review persist')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ---------- B3: merge semantics of the canonical writer ---------- */

test('R22: persistFindings merges by id — existing rows survive, resolution never regresses', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-e1-merge-'))
  try {
    const { memoryDir, wired } = await boot(root)
    seedFindings(memoryDir)
    await wired.persistFindings([
      {
        id: 'F-01', ruleId: 'SEC-004', severity: 'high', path: 'src/app.ts', line: 9,
        detectorModelId: 'sec-2', resolved: false, evidence: 'e', message: 're-reported',
      },
      {
        id: 'F-05', ruleId: 'SEC-009', severity: 'low', path: 'src/app.ts',
        detectorModelId: 'sec-1', resolved: false, evidence: 'e', message: 'no line, keeps existing anchor',
      },
      {
        id: 'F-03', ruleId: 'SEC-006', severity: 'low', path: 'src/other.ts', line: 1,
        detectorModelId: 'sec-1', resolved: false, evidence: 'e', message: 'fresh finding',
      },
    ] as never)
    const after = JSON.parse(fs.readFileSync(findingsFile(memoryDir), 'utf8')) as Array<{ id: string; resolved: boolean; severity: string; detector: string; line?: number }>
    const f01 = after.find((row) => row.id === 'F-01')
    assert.ok(f01 !== undefined, 'F-01 present')
    assert.strictEqual(f01.resolved, true, 'an existing resolution never regresses to unresolved')
    assert.strictEqual(f01.severity, 'high', 'fresh incoming fields update the row')
    assert.strictEqual(f01.detector, 'sec-2', 'the persisting model id is recorded')
    assert.strictEqual(f01.line, 9, 'a re-anchored line updates the row')
    const f05 = after.find((row) => row.id === 'F-05')
    assert.ok(f05 !== undefined, 'F-05 present')
    assert.strictEqual(f05.line, undefined, 'a line-less incoming row carries no invented anchor')
    assert.ok(after.some((row) => row.id === 'F-02'), 'the untouched seeded row survived')
    assert.ok(after.some((row) => row.id === 'F-03'), 'the new row was appended')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
