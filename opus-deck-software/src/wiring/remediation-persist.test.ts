/**
 * Phase E2 (E2-A1, R23): remediation resolutions are persisted ENGINE-SIDE.
 *
 * Before this phase `wired.remediateFindings(...)` returned the resolutions but
 * never wrote them into STATE/findings.json. The ONLY writer of a `resolved`
 * flag was a caller — in practice the C1 Electron shell's post-review
 * re-persist. That made the engine alone insufficient: a clean run driven only
 * by the engine left the remediated finding `resolved: false` in the file the
 * pre-merge gate reads, and the merge failed with GATE_FAILED.
 *
 * This test drives the ENGINE ALONE (no shell, no re-persist call):
 *   scan -> persistFindings -> remediateFindings -> merge
 * and requires the merge gate to PASS. It MUST fail on pre-fix code.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'node:path'
import { initOpusDeck } from '../config/bootstrap.js'
import { wireOpusDeck } from './index.js'
import type { RemediationTask } from '../audit/types.js'

/** One critical finding with the auto-patchable `env-var` strategy (SEC-004). */
const DIRTY_CODE = 'export const API_TOKEN = "sk-prod-9f3a2b1cdeadbeef42";\n'

const SECRET_PATTERN =
  /(api[_-]?key|secret|token|password|passwd|credential)\s*[:=]\s*['"][^'"]{8,}['"]/gi

function findingsFile(memoryDir: string): string {
  return path.join(memoryDir, 'STATE', 'findings.json')
}

test('R23: wired.remediateFindings persists the resolution; the engine alone reaches a passing pre-merge gate', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-e2-remediation-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const outputDir = path.join(root, 'OUTPUT')
    const runtime = initOpusDeck({
      memoryDir, outputDir, brief: 'build an app', goalState: ['app builds'],
      crew: {
        lead: { id: 'lead', provider: 'custom', model: 'lead-model', contextWindowTokens: 4096 },
        engineers: [{ id: 'eng-1', provider: 'custom', model: 'eng-model', contextWindowTokens: 4096 }],
        security: [
          { id: 'sec-1', provider: 'custom', model: 'sec-model', contextWindowTokens: 4096 },
          { id: 'sec-2', provider: 'custom', model: 'sec-model-2', contextWindowTokens: 4096 },
        ],
      },
    })
    // No shell: the engine's own wiring is the whole driver.
    const wired = await wireOpusDeck(runtime, {
      transport: {
        async *complete() {
          const req = arguments[0] as { messages: { content: string }[] }
          const prompt = req.messages.map((m) => m.content).join('\n')
          yield {
            type: 'text',
            text: prompt.includes('TASK_DECOMPOSITION')
              ? JSON.stringify([{ id: 'T-01', path: 'src/app.ts', description: 'do it', acceptance: ['ok'] }])
              : JSON.stringify({ satisfied: true, evidence: 'src/app.ts:1' }),
          }
        },
      } as never,
      leadModelId: 'lead',
      auditorModelIds: ['sec-1', 'sec-2'],
    })

    // Plan + route so STATE/tasks.json is a valid array of rows (the pre-merge
    // gate reads it), exactly as the real pipeline does before merge.
    await wired.leader.plan({ brief: 'build an app', goalState: 'app builds', crew: { lead: 'lead', engineers: ['eng-1'] } })
    await wired.leader.route()

    // The audited artifact exists on disk and carries exactly one critical,
    // auto-remediable finding.
    const appPath = path.join(memoryDir, 'WORKSPACE', 'src', 'app.ts')
    fs.mkdirSync(path.dirname(appPath), { recursive: true })
    fs.writeFileSync(appPath, DIRTY_CODE, 'utf8')

    const report = wired.scan([{ path: 'src/app.ts', code: DIRTY_CODE }], ['sec-1', 'sec-2'])
    assert.strictEqual(report.findings.length, 1, 'exactly one finding')
    assert.strictEqual(report.findings[0].ruleId, 'SEC-004', 'the remediable critical SEC-004')
    await wired.persistFindings(report.findings)

    // The patching task bus is the only collaborator that patches the artifact;
    // the wiring supplies the gate, the artifact store and the escalation queue.
    const executed: RemediationTask[] = []
    const bus = {
      enqueue: async (task: RemediationTask): Promise<{ taskId: string; accepted: boolean }> => {
        executed.push(task)
        if (task.patchStrategy === 'env-var' && task.targetPath !== '') {
          const full = path.join(memoryDir, 'WORKSPACE', ...task.targetPath.split('/'))
          let code = ''
          try { code = await fs.promises.readFile(full, 'utf8') } catch { code = '' }
          const patched = code.replace(SECRET_PATTERN, '$1 = process.env.SECRET_VALUE')
          if (patched !== code) await fs.promises.writeFile(full, patched, 'utf8')
        }
        return { taskId: task.id, accepted: true }
      },
      awaitSettlement: async (r: { taskId: string }) => ({ taskId: r.taskId, ok: true }),
    }

    // THE COMPOSITION UNDER TEST — the wiring's remediateFindings, not f08's.
    const result = await wired.remediateFindings(
      report.findings,
      { bus, artifacts: wired.f08.artifactStore, escalations: wired.f08.escalationQueue, now: () => '2026-01-01T00:00:00.000Z' },
      { maxRounds: 2 },
    )

    assert.ok(executed.some((t) => t.ruleId === 'SEC-004'), 'the patchable task executed')
    assert.strictEqual(result.resolved.length, 1, 'the finding was resolved by the loop')

    // R23: the resolution is in the PERSISTED file, engine-side, with no caller.
    const persisted = JSON.parse(fs.readFileSync(findingsFile(memoryDir), 'utf8')) as Array<{ id: string; resolved: boolean }>
    assert.strictEqual(persisted.length, 1, 'the row survived (R22 merge-by-id never dropped it)')
    assert.strictEqual(persisted[0].resolved, true, 'R23: the resolved flag was persisted engine-side')

    // The decisive assertion: the ENGINE ALONE reaches a passing pre-merge gate.
    // Release the build claim first — the gate requires no live claim rows.
    await wired.f05.release('eng-1', ['src/app.ts'])
    // Pre-fix this rejects with GATE_FAILED:critical-findings.
    const manifest = await wired.merge(memoryDir, outputDir)
    assert.ok(manifest, 'the pre-merge gate PASSED without any shell re-persist')
    assert.ok(
      fs.existsSync(path.join(outputDir, 'MANIFEST.json')),
      'MANIFEST.json was written, so the gate did not block',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})