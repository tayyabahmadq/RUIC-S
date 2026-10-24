/**
 * Phase 7 — R21 (E1) FIX 1 regression: transport stream realism.
 *
 * A REAL phase-02 adapter streams the full chunk grammar:
 *   {type:'text'} ... then {type:'usage'} ... then {type:'done'}.
 * The crew worker used to JSON.stringify every non-text chunk into the
 * write-intent text, so real usage/done chunks corrupted the parse. This
 * test drives the worker through a stub that emits exactly the realistic
 * sequence (plus one post-done chunk to prove `done` terminates) and MUST
 * fail on pre-fix code (temp-copy proven), pass after the fix.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngineerWorker } from './worker.js'
import { InMemoryTaskQueue } from './pool.js'
import type { CrewDependencies } from './types.js'
import type { TransportChunk as F02Chunk } from '../transport/types.js'

const INTENT = {
  intent: 'write',
  path: 'src/real.ts',
  added: ['export const real = 1;'],
  atLine: 1,
  removedLineCount: 0,
}

/** Mirrors F07TransportClient.stream(): the raw complete() iterable is handed to the worker. */
function realisticTransport(): { stream(): AsyncIterable<F02Chunk> } {
  return {
    async *stream(): AsyncIterable<F02Chunk> {
      yield { type: 'text', text: JSON.stringify(INTENT) }
      yield { type: 'usage', inputTokens: 12, outputTokens: 34 }
      yield { type: 'done', finishReason: 'stop' }
      // Unreachable after the fix: `done` terminates the stream.
      yield { type: 'text', text: 'AFTER-DONE-LEAK' }
    },
  }
}

test('R21 realistic stream: text -> usage -> done completes cleanly (no JSON corruption, done terminates)', async () => {
  const writes: unknown[] = []
  const usageSeen: Array<{ inputTokens: number; outputTokens: number }> = []
  const deps: CrewDependencies & { transport: ReturnType<typeof realisticTransport> } = {
    commons: { write: (args) => { writes.push(args) } },
    transport: realisticTransport(),
    locks: {},
    usageSink: (usage) => { usageSeen.push(usage) },
  }
  const worker = createEngineerWorker('eng-real', deps)
  const result = await worker.run(new InMemoryTaskQueue([
    { id: 'T-01', locks: ['src/real.ts'], description: 'do it' },
  ] as never))

  assert.deepStrictEqual(
    result.completedTaskIds,
    ['T-01'],
    'the task completed under the full realistic chunk grammar',
  )
  assert.deepStrictEqual(result.failedTaskIds, [], 'no parse failure')

  // 1. The write-intent is EXACTLY the text chunk — no usage/done JSON on the wire.
  const payloads = writes as Array<{ path: string; added: string[]; atLine: number }>
  assert.strictEqual(payloads.length, 1, 'exactly one write')
  assert.strictEqual(payloads[0].path, 'src/real.ts')
  assert.deepStrictEqual(payloads[0].added, INTENT.added, 'added lines are the model text only')
  assert.strictEqual(payloads[0].atLine, 1)

  // 2. Usage chunks fed the injected accounting sink exactly once.
  assert.deepStrictEqual(usageSeen, [{ inputTokens: 12, outputTokens: 34 }], 'usage chunks reach the usage sink')

  // 3. `done` terminated the stream: the post-done chunk never reached the text.
  const serialized = JSON.stringify(payloads)
  assert.ok(!serialized.includes('AFTER-DONE-LEAK'), 'no chunk after done was consumed')
})
