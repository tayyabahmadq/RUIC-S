/**
 * Phase E2 (E2-A2, R24): the transport adapters terminate on `done`.
 *
 * A REAL phase-02 adapter streams text, then usage, then a terminal `done`.
 * F06TransportAdapter (the leader's Transport.completion) used to concatenate
 * EVERY text chunk and never stopped, so a chunk after `done` was appended to
 * the leader's JSON and the plan parse failed with LEADER_INVALID_LLM_JSON.
 * This is the same defect class the crew worker had (fixed in E1 under R21).
 *
 * The test drives the LEADER end to end — not the adapter in isolation — with a
 * stub that emits text -> usage -> done and then one post-done leak chunk, and
 * requires the plan to parse cleanly. It MUST fail on pre-fix code.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'node:path'
import { initOpusDeck } from '../config/bootstrap.js'
import { wireOpusDeck } from './index.js'
import type { Transport as F02Transport, TransportChunk } from '../transport/types.js'

const PLAN = [{
  id: 'T-01', path: 'src/app.ts', description: 'write the entry file', acceptance: ['ok'],
}]

/** The realistic grammar, plus one post-done leak chunk on EVERY call. */
function leakyTransport(): F02Transport {
  return {
    async *complete(): AsyncIterable<TransportChunk> {
      const req = arguments[0] as { messages: { content: string }[] }
      const prompt = req.messages.map((m) => m.content).join('\n')
      const body = prompt.includes('TASK_DECOMPOSITION')
        ? JSON.stringify(PLAN)
        : JSON.stringify({ satisfied: true, evidence: 'src/app.ts:1' })
      // text, in two pieces, to prove concatenation across chunks
      const cut = Math.max(1, Math.floor(body.length / 2))
      yield { type: 'text', text: body.slice(0, cut) }
      yield { type: 'text', text: body.slice(cut) }
      yield { type: 'usage', inputTokens: 11, outputTokens: 22 }
      yield { type: 'done', finishReason: 'stop' }
      // Pre-fix this chunk was concatenated onto the leader's JSON.
      yield { type: 'text', text: 'POST-DONE-LEAK-MUST-NOT-BE-CONSUMED' }
    },
  }
}

test('R24: the leader transport terminates on done - a post-done chunk cannot corrupt the plan JSON', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-e2-adapter-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const runtime = initOpusDeck({
      memoryDir, outputDir: path.join(root, 'OUTPUT'),
      brief: 'build an app', goalState: ['app builds'],
      crew: {
        lead: { id: 'lead', provider: 'custom', model: 'lead-model', contextWindowTokens: 4096 },
        engineers: [{ id: 'eng-1', provider: 'custom', model: 'eng-model', contextWindowTokens: 4096 }],
        security: [
          { id: 'sec-1', provider: 'custom', model: 'sec-model', contextWindowTokens: 4096 },
          { id: 'sec-2', provider: 'custom', model: 'sec-model-2', contextWindowTokens: 4096 },
        ],
      },
    })
    const wired = await wireOpusDeck(runtime, {
      transport: leakyTransport(),
      leadModelId: 'lead',
      auditorModelIds: ['sec-1', 'sec-2'],
    })

    // Pre-fix: rejects with CommonsError LEADER_INVALID_LLM_JSON
    // ('Transport did not return valid JSON for the plan').
    const tasks = await wired.leader.plan({
      brief: 'build an app', goalState: 'app builds', crew: { lead: 'lead', engineers: ['eng-1'] },
    })

    assert.strictEqual(tasks.length, 1, 'the plan parsed under the full realistic grammar')
    assert.strictEqual(tasks[0].id, 'T-01')
    assert.strictEqual(tasks[0].path, 'src/app.ts')
    assert.deepStrictEqual(tasks[0].acceptance, ['ok'])

    // The leak chunk never reached the leader.
    const stored = fs.readFileSync(path.join(memoryDir, 'STATE', 'tasks.json'), 'utf8')
    assert.ok(!stored.includes('POST-DONE-LEAK'), 'no post-done chunk leaked into the stored plan')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('R24: F06TransportAdapter routes usage chunks into the response and never into the text', async () => {
  const { F06TransportAdapter } = await import('./transport-adapter.js')
  const adapter = new F06TransportAdapter({
    async *complete(): AsyncIterable<TransportChunk> {
      yield { type: 'text', text: '{"ok":' }
      yield { type: 'text', text: 'true}' }
      yield { type: 'usage', inputTokens: 7, outputTokens: 9 }
      yield { type: 'done', finishReason: 'stop' }
      yield { type: 'text', text: 'LEAK' }
    },
  })
  const res = await adapter.completion({ modelId: 'lead', messages: [{ role: 'user', content: 'x' }] })
  assert.strictEqual(res.text, '{"ok":true}', 'only the text chunks, concatenated')
  const usage = res.usage
  assert.ok(usage !== undefined, 'the adapter reports usage')
  assert.strictEqual(usage.inputTokens, 7, 'the usage chunk reached the response usage')
  assert.strictEqual(usage.outputTokens, 9)
  assert.ok(!res.text.includes('LEAK'), 'nothing after done was consumed')
})