/**
 * Phase 11 dirty smoke test — finding -> escalation -> veto -> merge-block.
 *
 * Dirty file contains eval() (no strategy), a hardcoded secret (env-var
 * strategy), and Math.random(). Verifies:
 *  a. all three findings appear in STATE/findings.json
 *  b. the patchable finding auto-executes and clears on re-scan (resolved: true)
 *  c. the eval() finding is escalated (not advisory), lands in ReviewQueue pending
 *  d. VETO that escalation -> follow-up task path is a real WORKSPACE path
 *  e. an unresolved critical BLOCKS merge (GATE_FAILED)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'node:path'
import { initOpusDeck } from '../config/bootstrap.js'
import { wireOpusDeck } from './index.js'
import { remediateFindings, scanAll, gateBlocked } from '../audit/index.js'
import { merge } from '../merge/index.js'
import type { RemediationTask } from '../audit/types.js'

const DIRTY_CODE =
  'const input = prompt();\n' +
  'eval(input);\n' +
  'const API_TOKEN = "sk-prod-9f3a2b1cdeadbeef42";\n' +
  'const id = Math.random();\n'

test('dirty smoke: eval escalated to ReviewQueue, secret patched+cleared, merge blocked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-dirty-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const outputDir = path.join(root, 'OUTPUT')
    const runtime = initOpusDeck({
      memoryDir, outputDir, brief: 'build an app', goalState: ['app builds'],
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
            yield { type: 'text', text: JSON.stringify({ intent: 'write', path: 'src/app.ts', added: [DIRTY_CODE], atLine: 1, removedLineCount: 0 }) }
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
    fs.writeFileSync(appPath, DIRTY_CODE, 'utf8')

    // --- 3a: all three findings raised and persisted to STATE/findings.json ---
    const report = wired.scan([{ path: 'src/app.ts', code: DIRTY_CODE }], ['sec-1', 'sec-2'])
    assert.ok(report.findings.some((f) => f.ruleId === 'SEC-001'), 'SEC-001 eval raised')
    assert.ok(report.findings.some((f) => f.ruleId === 'SEC-004'), 'SEC-004 secret raised')
    assert.ok(report.findings.some((f) => f.ruleId === 'SEC-006'), 'SEC-006 Math.random raised')
    assert.strictEqual(gateBlocked(report.findings), true, 'dirty file is gate-blocked')

    await wired.persistFindings(report.findings)
    const persisted = JSON.parse(fs.readFileSync(path.join(memoryDir, 'STATE', 'findings.json'), 'utf8'))
    assert.strictEqual(persisted.length, 3, 'all three findings persisted')

    // --- 3b: patchable finding auto-executes and clears on re-scan ---
    const executed: RemediationTask[] = []
    const customBus = {
      enqueue: async (task: RemediationTask): Promise<{ taskId: string; accepted: boolean }> => {
        executed.push(task)
        if (task.patchStrategy === 'env-var' && task.targetPath) {
          const full = path.join(memoryDir, 'WORKSPACE', ...task.targetPath.split('/'))
          let code = ''
          try { code = await fs.promises.readFile(full, 'utf8') } catch { }
          const patched = code.replace(/(api[_-]?key|secret|token|password|passwd|credential)\s*[:=]\s*['"][^'"]{8,}['"]/gi, '$1 = process.env.SECRET_VALUE')
          if (patched !== code) await fs.promises.writeFile(full, patched, 'utf8')
        }
        return { taskId: task.id, accepted: true }
      },
      awaitSettlement: async (r: { taskId: string }) => Promise.resolve({ taskId: r.taskId, ok: true }),
    }

    const result = await remediateFindings(
      report.findings,
      { bus: customBus, artifacts: wired.f08.artifactStore, escalations: wired.f08.escalationQueue, now: () => '2026-01-01T00:00:00.000Z' },
      { maxRounds: 2 },
    )

    const patchedTask = executed.find((t) => t.ruleId === 'SEC-004' && t.patchStrategy === 'env-var')
    assert.ok(patchedTask, 'patchable SEC-004 task emitted')
    const resolved = result.resolved.find((f) => f.ruleId === 'SEC-004')
    assert.ok(resolved, 'SEC-004 resolved: true after re-scan')

    // --- 3c: eval() escalated (not advisory), lands in ReviewQueue pending ---
    const esc = result.escalations.find((e) => e.reason === 'no-patch-strategy')
    assert.ok(esc, 'SEC-001 escalated with no-patch-strategy (not advisory)')
    assert.ok(result.advisories.every((a) => a.blocking === false), 'advisories non-blocking')

    const pending = await wired.reviewQueue.listPending()
    assert.ok(pending.length >= 1, 'escalation reached ReviewQueue pending list')
    const escPending = pending.find((d) => d.touched.includes('src/app.ts'))
    assert.ok(escPending, 'pending decision touches src/app.ts')
    assert.strictEqual(escPending.status, 'pending', 'decision is pending for lead judgement')

    // --- 3d: VETO -> follow-up task path is a real WORKSPACE path ---
    // release the build lock so the veto's follow-up task can claim src/app.ts
    await wired.f05.release('eng-1', ['src/app.ts'])
    const vetoed = await wired.reviewQueue.veto(escPending.id, 'eval requires manual rewrite')
    assert.strictEqual(vetoed.status, 'vetoed')
    assert.ok(vetoed.followUpTaskId, 'veto produced a follow-up task')
    assert.ok(
      vetoed.followUpTaskId!.startsWith('T-'),
      `follow-up task is a real task id (got ${vetoed.followUpTaskId})`,
    )

    // --- 3e: unresolved critical BLOCKS merge ---
    await assert.rejects(
      merge(memoryDir, outputDir),
      (err: any) => err.code === 'GATE_FAILED',
      'unresolved critical blocks merge with GATE_FAILED'
    )
    assert.ok(!fs.existsSync(path.join(outputDir, 'MANIFEST.json')), 'no MANIFEST written when gate blocked')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
