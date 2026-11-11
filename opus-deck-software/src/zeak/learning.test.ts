/**
 * Zeak v2 tests — the TRY BOX, the learning loop, predictive early-stop.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Brain } from '../state/index.js'
import { errorSignature, TryBox } from '../state/trybox.js'
import { runLearningCycle, clusterDeterministically, decayGuides } from './learning.js'
import type { LearningOptions } from './learning.js'
import { zeakWrap } from './zeak.js'
import type { Transport, CompletionRequest, TransportChunk } from '../transport/types.js'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ruic-zeak2-'))
}

function brain(): { b: Brain; dir: string; cleanup: () => void } {
  const dir = tmpDir()
  const b = new Brain(dir, null)
  return { b, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/* ---------------- TRY BOX ---------------- */

test('trybox: signatures are deterministic and anchor keywords dominate', () => {
  const a = errorSignature("PARSE_FAILED: model output did not match the wire format (attempt 1)")
  const b = errorSignature("PARSE_FAILED: model output did not match the wire format (attempt 99)")
  assert.equal(a, b) // digits normalized, anchor dominates
  const c = errorSignature('ECONNREFUSED 127.0.0.1:11434')
  assert.match(c, /^E:ECONNREFUSED/)
})

test('trybox: record + tally + occurrence gate data', async () => {
  const { b, cleanup } = brain()
  try {
    await b.recordFailure({ taskId: 'T-01', modelId: 'eng-1', method: 'regex parse', errorDetail: 'PARSE_FAILED: model output unparseable' })
    await b.recordFailure({ taskId: 'T-01', modelId: 'eng-1', method: 'regex parse again', errorDetail: 'PARSE_FAILED: model output not parseable' })
    await b.recordFailure({ taskId: 'T-02', modelId: 'eng-1', method: 'regex parse third', errorDetail: 'PARSE_FAILED: unparseable again' })
    const tally = await b.trybox.tally()
    assert.equal(tally[0]!.occurrences, 3)
    assert.ok(tally[0]!.signature.startsWith('E:PARSE_FAILED'))
  } finally {
    cleanup()
  }
})

/* ---------------- Learning loop: Model 2 + Model 3 ---------------- */

function learningOptions(chat: (p: string, s: string) => Promise<string | null>, events: Array<{ event: string; payload: unknown }>): LearningOptions {
  return {
    chat,
    minOccurrences: 3,
    guideCap: 40,
    staleDays: 14,
    emit: (event, payload) => events.push({ event, payload }),
  }
}

test('learning: one occurrence NEVER becomes a guide (Pin 1, sacred)', async () => {
  const { b, cleanup } = brain()
  try {
    await b.init()
    await b.recordFailure({ taskId: 'T-01', modelId: 'eng-1', method: 'weird one-off', errorDetail: 'SOME_UNIQUE_ERROR xyz' })
    // Deterministic fallback path (chat would return null if consulted — the
    // occurrence gate fires first anyway).
    const events: Array<{ event: string; payload: unknown }> = []
    const result = await runLearningCycle(b, learningOptions(async () => null, events))
    assert.equal(result.guidesAdded.length, 0)
    const guides = await b.readGuides()
    assert.equal(guides, '')
  } finally {
    cleanup()
  }
})

test('learning: 3+ occurrences + Model 3 verify -> guide added AND backed up', async () => {
  const dir = tmpDir()
  // Embedder on: the guide must also land in the vector store (fix-memory).
  const b = new Brain(dir, async (text: string) => {
    const v = new Array(8).fill(0)
    for (const ch of text.toLowerCase()) v[ch.charCodeAt(0) % 8] += 1
    const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0)) || 1
    return v.map((x) => x / norm)
  })
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  try {
    await b.init()
    for (const t of ['T-01', 'T-02', 'T-03']) {
      await b.recordFailure({ taskId: t, modelId: 'eng-1', method: 'regex parse', errorDetail: 'PARSE_FAILED: bad json' })
    }
    let model3Called = 0
    const events: Array<{ event: string; payload: unknown }> = []
    const result = await runLearningCycle(b, learningOptions(async (prompt, system) => {
      if (system.includes('failure memory')) {
        // Model 2: confirm the pattern
        const tally = await b.trybox.tally()
        return JSON.stringify(tally.map((t) => ({ signature: t.signature, occurrences: t.occurrences })))
      }
      model3Called += 1
      return JSON.stringify({ verified: true, guide: 'Always emit one JSON object matching the write-intent schema; no prose.' })
    }, events))
    assert.equal(model3Called, 1, 'Model 3 verified the pattern')
    assert.equal(result.guidesAdded.length, 1)
    const guides = await b.readGuides()
    assert.ok(guides.includes('Always emit one JSON object'))
    // The sketch's "agent.md is backed up": an ARCHIVE version exists.
    const archive = join(dir, 'ARCHIVE')
    assert.ok(existsSync(archive))
    assert.ok(readdirSync(archive).some((f) => /^guides@v\d+\.md$/.test(f)))
    assert.ok(events.some((e) => e.event === 'learning.guide_added'))
    // And the guide is embedded into the vector store (fix-memory).
    const raw = await b.vectors.raw()
    assert.ok(raw.some((v) => v.source.startsWith('guide')))
  } finally {
    cleanup()
  }
})

test('learning: Model 3 rejection is visible, nothing is written', async () => {
  const { b, cleanup } = brain()
  try {
    await b.init()
    for (const t of ['T-01', 'T-02', 'T-03']) {
      await b.recordFailure({ taskId: t, modelId: 'eng-1', method: 'm', errorDetail: 'EACCES denied' })
    }
    const events: Array<{ event: string; payload: unknown }> = []
    const result = await runLearningCycle(b, learningOptions(async (prompt, system) => {
      if (system.includes('failure memory')) return JSON.stringify([{ signature: (await b.trybox.tally())[0]!.signature, occurrences: 3 }])
      return JSON.stringify({ verified: false, guide: '' })
    }, events))
    assert.equal(result.guidesAdded.length, 0)
    assert.ok(events.some((e) => e.event === 'learning.guide_rejected'))
    assert.equal(await b.readGuides(), '')
  } finally {
    cleanup()
  }
})

test('learning: deterministic clustering fallback (no LLM)', () => {
  const clusters = clusterDeterministically([
    { signature: 'E:A', occurrences: 1, methods: ['x'], models: ['m'] },
    { signature: 'E:B', occurrences: 4, methods: ['y'], models: ['m'] },
  ])
  assert.deepEqual(clusters.map((c) => c.signature), ['E:B'])
})

test('learning: guides decay drops oldest over the cap (Pin 2)', async () => {
  const { b, cleanup } = brain()
  try {
    await b.init()
    for (let i = 0; i < 45; i++) await b.addGuide(`guide line number ${i}`)
    assert.equal((await b.readGuides()).split('\n').filter((l) => l.startsWith('- ')).length, 45)
    const removed = await decayGuides(b, { chat: async () => null, emit: () => undefined, guideCap: 40, minOccurrences: 3, staleDays: 14 })
    assert.equal(removed, 5)
    const lines = (await b.readGuides()).split('\n').filter((l) => l.startsWith('- '))
    assert.equal(lines.length, 40)
  } finally {
    cleanup()
  }
})

/* ---------------- Predictive early-stop (v1+v2 fusion) ---------------- */

const REQ: CompletionRequest = {
  modelId: 'eng-1',
  messages: [{ role: 'user', content: 'do the thing' }],
}

test('zeak: predictive stop fires when output heads toward a known-failed method', async () => {
  const { b, cleanup } = brain()
  try {
    await b.init()
    const signature = await b.recordFailure({ taskId: 'T-07', modelId: 'eng-1', method: 'regex parse approach', errorDetail: 'PARSE_FAILED: bad json' })
    await b.addGuide('Always emit one JSON object; no prose.')
    const events: Array<{ event: string; payload: unknown }> = []
    const paid: Transport = {
      async *complete(req: CompletionRequest): AsyncGenerator<TransportChunk, void, undefined> {
        yield { type: 'text', text: 'let me try the regex parse approach again step' }
        yield { type: 'text', text: ' one' }
        yield { type: 'text', text: ' two' }
        yield { type: 'text', text: ' three' }
        yield { type: 'text', text: ' four' }
        yield { type: 'text', text: ' five' }
        yield { type: 'text', text: ' six' }
        yield { type: 'text', text: ' seven' }
        yield { type: 'text', text: ' eight' }
        yield { type: 'text', text: ' nine more tokens' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const gated = zeakWrap(paid, {
      budgets: { departments: {}, escalations: 1 },
      brain: b,
      events: { emit: (event, payload) => events.push({ event, payload }) },
      fallbackModelId: 'eng-1',
      predictive: async (partial, taskId) => {
        if (taskId !== 'T-07') return null
        if (partial.toLowerCase().includes('regex parse approach')) {
          const guides = await b.readGuides()
          const line = guides.split('\n').find((l) => l.startsWith('- ')) ?? ''
          return { signature, guide: line.replace(/^- /, '') }
        }
        return null
      },
    }, () => 'engineering', () => 'T-07')
    const out: TransportChunk[] = []
    for await (const chunk of gated.complete({ ...REQ })) out.push(chunk)
    assert.ok(events.some((e) => e.event === 'zeak.predictive_stop'))
    // The guide is surfaced INSTEAD of the full bad attempt.
    const texts = out.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('')
    assert.ok(texts.includes('Verified guide'))
    assert.ok(texts.includes('Always emit one JSON object'))
  } finally {
    cleanup()
  }
})

test('zeak: predictive stop does NOT fire for a clean task', async () => {
  const { b, cleanup } = brain()
  try {
    await b.init()
    await b.recordFailure({ taskId: 'T-07', modelId: 'eng-1', method: 'regex parse approach', errorDetail: 'PARSE_FAILED: bad json' })
    const events: Array<{ event: string; payload: unknown }> = []
    const paid: Transport = {
      async *complete(): AsyncGenerator<TransportChunk, void, undefined> {
        yield { type: 'text', text: 'clean output that mentions nothing relevant at all.' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const gated = zeakWrap(paid, {
      budgets: { departments: {}, escalations: 1 },
      brain: b,
      events: { emit: (event, payload) => events.push({ event, payload }) },
      fallbackModelId: 'eng-1',
      predictive: async (partial, taskId) => {
        if (taskId !== 'T-07') return null
        if (partial.toLowerCase().includes('regex parse approach')) return { signature: 'E:X', guide: 'g' }
        return null
      },
    }, () => 'engineering', () => 'T-07')
    const out: TransportChunk[] = []
    for await (const chunk of gated.complete({ ...REQ })) out.push(chunk)
    assert.ok(!events.some((e) => e.event === 'zeak.predictive_stop'))
    assert.equal(out.length, 2)
  } finally {
    cleanup()
  }
})
