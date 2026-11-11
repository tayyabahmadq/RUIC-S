/**
 * Phase 11 smoke test — full end-to-end wiring.
 * initOpusDeck + wireOpusDeck, then plan -> route -> build -> audit -> merge
 * -> signOff, asserting run.completed is emitted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initOpusDeck } from '../config/bootstrap.js'
import { wireOpusDeck } from './index.js'
import { runCrew } from '../crew/index.js'
import type { Transport as F02Transport, TransportChunk } from '../transport/types.js'

function crewModel(id: string, model: string) {
  return { id, provider: 'custom' as const, model, contextWindowTokens: 4096 }
}

function mockTransport(): F02Transport {
  return {
    // R21 (E1): every response streams the FULL realistic phase-02 chunk
    // grammar — text, then usage, then done — exactly like a real adapter.
    async *complete(): AsyncIterable<TransportChunk> {
      const req = arguments[0] as { messages: { content: string }[]; modelId: string }
      const prompt = req.messages.map((m) => m.content).join('\n')
      if (prompt.includes('TASK_DECOMPOSITION')) {
        yield { type: 'text', text: JSON.stringify([{ id: 'T-01', path: 'src/app.ts', description: 'Implement the app', acceptance: ['compiles cleanly'] }]) }
        yield { type: 'usage', inputTokens: 12, outputTokens: 34 }
        yield { type: 'done', finishReason: 'stop' }
      } else if (prompt.includes('CRITERION_VERIFICATION')) {
        yield { type: 'text', text: JSON.stringify({ satisfied: true, evidence: 'src/app.ts:1 — criterion met' }) }
        yield { type: 'usage', inputTokens: 8, outputTokens: 6 }
        yield { type: 'done', finishReason: 'stop' }
      } else {
        yield { type: 'text', text: JSON.stringify({ intent: 'write', path: 'src/app.ts', added: ['export const app = 1;'], atLine: 1, removedLineCount: 0 }) }
        yield { type: 'usage', inputTokens: 20, outputTokens: 16 }
        yield { type: 'done', finishReason: 'stop' }
      }
    },
  }
}

test('full wiring: initOpusDeck + wireOpusDeck completes a one-file build end-to-end', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-wiring-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const outputDir = path.join(root, 'OUTPUT')
    const runtime = initOpusDeck({
      memoryDir, outputDir, brief: 'build a trivial app', goalState: ['app builds'],
      crew: {
        lead: crewModel('lead', 'lead-model'),
        engineers: [crewModel('eng-1', 'eng-model')],
        security: [crewModel('sec-1', 'sec-model'), crewModel('sec-2', 'sec-model-2')],
      },
    })
    const wired = await wireOpusDeck(runtime, {
      transport: mockTransport(), leadModelId: 'lead',
      auditorModelIds: ['sec-1', 'sec-2'],
    })

    // plan + route
    const input = { brief: 'build a trivial app', goalState: 'app builds', crew: { lead: 'lead', engineers: ['eng-1'] } }
    const tasks = await wired.leader.plan(input)
    assert.ok(tasks.length >= 1)
    assert.strictEqual(tasks[0].path, 'src/app.ts')
    await wired.leader.route()

    // build via crew
    const crewResult = await runCrew([{ modelId: 'eng-1' }], tasks, {
      dependencies: { bus: wired.hub, commons: wired.f07.commons, transport: wired.f07.transport, locks: wired.f07.locks },
    })
    assert.ok(crewResult.workers.some((w) => w.completedTaskIds.length > 0), 'worker completed a task')

    const appPath = path.join(memoryDir, 'WORKSPACE', 'src', 'app.ts')
    assert.ok(fs.existsSync(appPath), 'WORKSPACE/src/app.ts written')
    assert.ok(fs.readFileSync(appPath, 'utf8').includes('export const app = 1;'))

    // audit — clean file, no findings
    const report = wired.scan([{ path: 'src/app.ts', code: fs.readFileSync(appPath, 'utf8') }], ['sec-1', 'sec-2'])
    assert.strictEqual(report.findings.length, 0)

    // release the build lock so merge's dangling-locks gate passes
    await wired.f05.release('eng-1', ['src/app.ts'])

    // merge
    const manifest = await wired.merge(memoryDir, outputDir)
    assert.ok(manifest.totalFiles >= 1)
    assert.ok(fs.existsSync(path.join(outputDir, 'MANIFEST.json')))
    assert.ok(fs.existsSync(path.join(outputDir, 'OVERRIDES.log')))

    // verify + signOff
    const results = await wired.leader.verify(['app builds'])
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].satisfied, true)
    const signOff = await wired.leader.signOff()
    assert.strictEqual(signOff.checksum.length, 64)
    assert.strictEqual(signOff.fileCount, 1)

    // run.completed emitted on the shared hub
    const published = await wired.hub.published()
    assert.ok(published.some((e) => e.type === 'run.completed'), 'run.completed emitted')

    // compactor watch() is subscribed (compactor wired)
    assert.ok(wired.compactor, 'compactor wired')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
