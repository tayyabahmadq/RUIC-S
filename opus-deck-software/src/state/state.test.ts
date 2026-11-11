/**
 * Common-S tests — the State Contract (Risk #1) and the vector store (Risk #5).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Brain, ContractStore, ContractValidationError, SCHEMA_VERSION,
  validateContract, makeContract, VectorStore,
} from './index.js'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ruic-state-'))
}

/* ---------------- State Contract ---------------- */

test('contract: accepts a well-formed entry and round-trips it', async () => {
  const dir = tmpDir()
  try {
    const store = new ContractStore(dir)
    const entry = makeContract({
      taskId: 'T-01', status: 'done', owner: 'eng-1',
      done: 'wrote WORKSPACE/output.md', artifacts: ['WORKSPACE/output.md'],
    })
    await store.record(entry)
    const back = await store.get('T-01')
    assert.ok(back !== null)
    assert.equal(back.schemaVersion, SCHEMA_VERSION)
    assert.equal(back.status, 'done')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('contract: unknown MAJOR schema version is rejected explicitly', () => {
  assert.throws(() => validateContract({
    schemaVersion: '2.0.0', taskId: 'T-01', parentTaskId: null, status: 'done',
    owner: 'eng-1', done: '', decisions: [], remaining: [], artifacts: [], updatedAt: new Date().toISOString(),
  }), (err: unknown) => err instanceof ContractValidationError && /unsupported schema major 2/.test(err.message))
})

test('contract: remaining work is the handoff — blocked/handed_off carry it', async () => {
  const dir = tmpDir()
  try {
    const brain = new Brain(dir, null)
    await brain.init()
    // A crashing worker leaves a resume point (Risk #2: exit-path enforcement).
    await brain.writeContract({
      taskId: 'T-02', status: 'blocked', owner: 'eng-1',
      remaining: ['task T-02 failed before completion: context window exhausted'],
    })
    const entry = await brain.contracts.get('T-02')
    assert.ok(entry !== null)
    assert.equal(entry.status, 'blocked')
    assert.ok(entry.remaining.length > 0)
    // Dept 4 finds open handoffs.
    const open = await brain.contracts.listByStatus('handed_off', 'blocked')
    assert.equal(open.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('contract: childrenOf links splits via parentTaskId', async () => {
  const dir = tmpDir()
  try {
    const store = new ContractStore(dir)
    await store.record(makeContract({ taskId: 'T-01a', parentTaskId: 'T-01', status: 'done', owner: 'eng-1' }))
    await store.record(makeContract({ taskId: 'T-01b', parentTaskId: 'T-01', status: 'blocked', owner: 'eng-2', remaining: ['x'] }))
    await store.record(makeContract({ taskId: 'T-02', status: 'done', owner: 'eng-1' }))
    const children = await store.childrenOf('T-01')
    assert.deepEqual(children.map((c) => c.taskId).sort(), ['T-01a', 'T-01b'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------------- Vector store (Risk #5) ---------------- */

/** Deterministic embedder: 8-dim bag-of-chars. */
async function fakeEmbed(text: string): Promise<number[]> {
  const v = new Array(8).fill(0)
  for (const ch of text.toLowerCase()) v[ch.charCodeAt(0) % 8] += 1
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}

test('vector store: cache-gate hit above threshold, miss below', async () => {
  const dir = tmpDir()
  try {
    const store = new VectorStore(dir)
    await store.add('qwen local executor serves the build', 'test', fakeEmbed)
    const hit = await store.search('qwen local executor serves the build', fakeEmbed, 0.9)
    assert.equal(hit.length, 1)
    const miss = await store.search('completely unrelated gravitational waves', fakeEmbed, 0.9)
    assert.equal(miss.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vector store: hard cap enforced, eviction keeps the most relevant', async () => {
  const dir = tmpDir()
  try {
    const store = new VectorStore(dir, { cap: 5 })
    for (let i = 0; i < 10; i++) {
      await store.add(`knowledge item number ${i} padding padding`, 'test', fakeEmbed)
    }
    assert.ok(store.size() <= 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vector store: decay drops only stale, low-relevance entries', async () => {
  const dir = tmpDir()
  try {
    const store = new VectorStore(dir)
    await store.add('fresh knowledge the crew just wrote', 'test', fakeEmbed)
    // Force-age an entry far beyond the horizon.
    const raw = await store.raw()
    raw[0]!.addedAt = new Date(Date.now() - 30 * 86_400_000).toISOString()
    await store.replace(raw)
    const dropped = await store.decay(7, 0.5)
    assert.equal(dropped, 1)
    assert.equal(store.size(), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------------- Brain facade ---------------- */

test('brain: compaction cycles serialize (Risk #4) and never run concurrently', async () => {
  const dir = tmpDir()
  try {
    const brain = new Brain(dir, fakeEmbed)
    await brain.init()
    let concurrent = 0
    let maxConcurrent = 0
    const trigger = async (): Promise<void> => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 20))
      concurrent -= 1
    }
    await Promise.all([
      brain.requestCompaction(trigger),
      brain.requestCompaction(trigger),
      brain.requestCompaction(trigger),
    ])
    assert.equal(maxConcurrent, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('brain: task flags persist across instances (zeakFallback durability)', async () => {
  const dir = tmpDir()
  try {
    const a = new Brain(dir, null)
    await a.init()
    await a.setTaskFlags('T-09', { zeakFallback: true, fallbackReason: 'cap_exceeded' })
    const b = new Brain(dir, null)
    await b.init()
    const flags = await b.getTaskFlags('T-09')
    assert.equal(flags.zeakFallback, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
