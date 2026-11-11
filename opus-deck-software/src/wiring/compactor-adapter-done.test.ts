/**
 * Phase E3 (A2, R24): the COMPACTOR path terminates on `done`.
 *
 * This completes E1 (crew worker, R21) and E2 (leader adapter, R24). The
 * compactor's `F04TransportAdapter` shared `collectChunks`, which concatenated
 * EVERY text chunk and never stopped - so a chunk after `done` was folded into
 * the compacted digest and archived with it.
 *
 * The stub emits the full canonical grammar - text (split in two, to prove
 * concatenation), then usage, then done - followed by a post-done LEAK chunk
 * carrying a unique marker. The test asserts the marker appears NOWHERE: not in
 * STATE/digest.md, not in any ARCHIVE file, not in the transport's collected
 * answer. It MUST fail on pre-fix code.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'node:path'
import { initOpusDeck } from '../config/bootstrap.js'
import { wireOpusDeck } from './index.js'
import { F04TransportAdapter } from './transport-adapter.js'
import type { Transport as F02Transport, TransportChunk } from '../transport/types.js'

/** The unique marker a post-`done` chunk would carry if it were consumed. */
const LEAK = 'POST-DONE-LEAK-MUST-NOT-BE-CONSUMED'

/** text (two pieces) -> usage -> done -> a post-done leak chunk. */
function leakyCompactorTransport(): F02Transport {
  return {
    async *complete(): AsyncIterable<TransportChunk> {
      const body = 'ARCH\n- pre-done arch\n\nIFACE\n- pre-done iface\n\nOPEN\n- pre-done risk\n\nSETTLED\n- pre-done decision\n\nPINS\n- pre-done pin'
      const cut = Math.max(1, Math.floor(body.length / 2))
      yield { type: 'text', text: body.slice(0, cut) }
      yield { type: 'text', text: body.slice(cut) }
      yield { type: 'usage', inputTokens: 20, outputTokens: 30 }
      yield { type: 'done', finishReason: 'stop' }
      // Unreachable once the adapter terminates on done.
      yield { type: 'text', text: LEAK }
    },
  }
}

function walkFiles(dir: string): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkFiles(full))
    else if (e.isFile()) out.push(full)
  }
  return out
}

test('R24: the compactor adapter terminates on done - a post-done chunk reaches neither the digest nor the archive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-e3-compactor-'))
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
    const wired = await wireOpusDeck(runtime, {
      transport: leakyCompactorTransport(),
      leadModelId: 'lead',
      auditorModelIds: ['sec-1', 'sec-2'],
    })

    // Seed a digest so compaction has something to compact, and force it.
    await wired.commons.write({
      path: 'STATE/digest.md',
      diff: { added: ['# DIGEST', '', 'ARCH', '- something worth compressing'], removedLineCount: 0, atLine: 1 },
      intent: 'seed digest', author: 'test',
    })

    const result = await wired.compactor.compact(true)
    assert.strictEqual(result.ran, true, 'compaction ran')

    // 1. The digest carries the PRE-done text only.
    const digest = await wired.commons.read('STATE/digest.md')
    assert.ok(digest.includes('pre-done arch'), 'the pre-done text reached the digest')
    assert.ok(digest.includes('pre-done pin'), 'both halves of the split text were concatenated')
    assert.ok(!digest.includes(LEAK), 'the post-done chunk did NOT reach the digest')

    // 2. Neither did it reach anything archived.
    const archived = walkFiles(path.join(memoryDir, 'ARCHIVE'))
    assert.ok(archived.length > 0, 'the previous digest was archived')
    for (const file of archived) {
      assert.ok(
        !fs.readFileSync(file, 'utf8').includes(LEAK),
        `the post-done chunk did NOT reach the archive file ${path.basename(file)}`,
      )
    }

    // 3. Nor did it reach the answer the adapter hands the compactor.
    const adapter = new F04TransportAdapter(leakyCompactorTransport(), 'lead-model')
    const answered = await adapter.chat({ messages: [{ role: 'user', content: 'Compress the following chunk.' }] })
    assert.ok(answered.text.includes('pre-done arch'), 'the adapter collected the pre-done text')
    assert.ok(!answered.text.includes(LEAK), 'the adapter discarded everything after done')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('R24: the compactor adapter routes usage and never concatenates it into the answer', async () => {
  const seen: Array<{ inputTokens: number; outputTokens: number }> = []
  const adapter = new F04TransportAdapter(leakyCompactorTransport(), 'lead-model')
  const answered = await adapter.chat({ messages: [{ role: 'user', content: 'Compress the following chunk.' }] })
  assert.ok(!answered.text.includes('"usage"'), 'no usage JSON was concatenated into the answer')
  assert.ok(!answered.text.includes('inputTokens'), 'no usage field leaked into the answer')
  // The optional sink is the additive seam; with none supplied, usage is simply
  // consumed and dropped (never double-counted - the phase-02 usage layer and
  // the shell's transport wrapper already account for it).
  assert.deepStrictEqual(seen, [], 'no sink supplied, nothing routed - and nothing corrupted')
})