/**
 * Phase 5 smoke test — presence, claims & locks (stubbed CommonsApi).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getConfig } from './index.js'
import {
  setCommons,
  upsert,
  snapshot,
  acquire,
  release,
  releaseAll,
  holdersOf,
  syncSince,
  drainQueue,
  queueDepth,
  configure,
  resetConfig,
} from './index.js'
import type { CommonsApi, SyncResult, TaskRecord } from './types.js'

function makeStub(): CommonsApi {
  const tasks: TaskRecord[] = []
  const presence: any[] = []
  let digest = ''
  let head = 0
  const deltas: any[] = []
  return {
    sync(): SyncResult { return { head, deltas: [...deltas] } },
    readTasks(): TaskRecord[] { return [...tasks] },
    writeTasks(rows: TaskRecord[]): void { tasks.length = 0; tasks.push(...rows) },
    readPresence(): any[] { return [...presence] },
    writePresence(entries: any[]): void { presence.length = 0; presence.push(...entries) },
    readDigest(): string { return digest },
  } as unknown as CommonsApi
}

async function withCoord(fn: () => Promise<void>) {
  setCommons(makeStub())
  try { await fn() } finally { setCommons(null) }
}

test('upsert/snapshot presence, pruning on staleness', async () => {
  await withCoord(async () => {
    const now = Date.now()
    const e = upsert('eng-1', { taskId: 'T-01', file: 'a.ts', lastSyncAt: now })
    assert.strictEqual(e.modelId, 'eng-1')
    assert.strictEqual(e.file, 'a.ts')
    const snap = snapshot()
    assert.strictEqual(snap.length, 1)
    assert.strictEqual(snap[0].taskId, 'T-01')
  })
})

test('acquire/release/holderOf claims', async () => {
  await withCoord(async () => {
    const now = Date.now()
    upsert('eng-1', { taskId: 'T-01', lastSyncAt: now })
    const r = acquire('eng-1', ['src/a.ts'])
    assert.strictEqual(r, 'granted')
    assert.deepStrictEqual(holdersOf('src/a.ts'), ['eng-1'])
    // re-acquire idempotent
    assert.strictEqual(acquire('eng-1', ['src/a.ts']), 'granted')
    // another model blocked
    upsert('eng-2', { taskId: 'T-02', lastSyncAt: now })
    const blocked = acquire('eng-2', ['src/a.ts'])
    assert.deepStrictEqual(blocked, { queuedBehind: 'eng-1' })
    assert.strictEqual(queueDepth(), 1)
    release('eng-1', ['src/a.ts'])
    assert.deepStrictEqual(holdersOf('src/a.ts'), [])
    // the queued conflict persists until drained (leader re-routes)
    assert.strictEqual(queueDepth(), 1)
    const drained = drainQueue()
    assert.strictEqual(drained.length, 1)
    assert.strictEqual(drained[0].modelId, 'eng-2')
    assert.strictEqual(queueDepth(), 0)
  })
})

test('releaseAll returns removed count', async () => {
  await withCoord(async () => {
    upsert('eng-1', { taskId: 'T-01', lastSyncAt: Date.now() })
    acquire('eng-1', ['src/a.ts', 'src/b.ts'])
    assert.strictEqual(releaseAll('eng-1'), 2)
    assert.deepStrictEqual(holdersOf('src/a.ts'), [])
    assert.deepStrictEqual(holdersOf('src/b.ts'), [])
    assert.strictEqual(releaseAll('eng-1'), 0)
  })
})

test('syncSince filters to held paths + digest + presence', async () => {
  const tasks: any[] = [{ kind: 'claim', claimId: 'c1', modelId: 'eng-1', path: 'src/a.ts', createdAt: 1 }]
  const presence = [{ modelId: 'eng-1', lastSyncAt: Date.now() }]
  const deltas = [
    { txnId: 1, kind: 'file', path: 'src/a.ts', modelId: 'eng-1' },
    { txnId: 2, kind: 'file', path: 'src/b.ts', modelId: 'eng-2' },
    { txnId: 3, kind: 'digest', value: 'digest content' },
    { txnId: 4, kind: 'presence', value: presence },
  ]
  setCommons({
    sync(): any { return { head: 4, deltas } },
    readTasks(): any[] { return tasks },
    writeTasks() {},
    readPresence(): any[] { return presence },
    writePresence() {},
    readDigest(): string { return 'digest content' },
  } as any)
  try {
    const out = syncSince('eng-1', 0)
    const kinds = out.map((d) => d.kind)
    assert.ok(kinds.includes('file'), 'held path delta included')
    assert.ok(kinds.includes('digest'), 'digest row included')
    assert.ok(kinds.includes('presence'), 'presence row included')
    assert.ok(!out.some((d) => d.path === 'src/b.ts'), 'unheld path excluded')
    // cursor advances
    const out2 = syncSince('eng-1', 4)
    assert.strictEqual(out2.length, 0)
  } finally {
    setCommons(null)
  }
})

test('configure/getConfig/resetConfig', () => {
  configure({ stalenessMs: 60000 })
  assert.strictEqual(getConfig().stalenessMs, 60000)
  resetConfig()
  assert.strictEqual(getConfig().stalenessMs, 120000)
})
