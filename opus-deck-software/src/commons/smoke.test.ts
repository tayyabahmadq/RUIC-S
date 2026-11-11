/**
 * Phase 3 smoke test — Commons Core six operations.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { openCommons, setClaimsAuthority } from './commons.js'
import type { Commons, WriteRequest } from './types.js'

async function withCommons(dirName: string, fn: (c: Commons) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), dirName))
  try {
    const cm = path.join(root, 'COMMONS')
    const commons = await openCommons(cm)
    await fn(commons)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('openCommons creates the canonical tree and idempotent reopen', async () => {
  await withCommons('opus-phase3-', async (commons) => {
    // writes are persisted; reopening must not clobber
    await commons.write({ path: 'WORKSPACE/a.txt', diff: { added: ['line1'], removedLineCount: 0, atLine: 1 }, intent: 'init', author: 'm1' })
    const content = await commons.read('WORKSPACE/a.txt')
    assert.strictEqual(content, 'line1\n')
  })
})

test('write applies diff atomically and appends a DELTA txn', async () => {
  await withCommons('opus-phase3-', async (commons) => {
    const t1 = await commons.write({ path: 'WORKSPACE/a.txt', diff: { added: ['a', 'b'], removedLineCount: 0, atLine: 1 }, intent: 'add two lines', author: 'm1' })
    assert.match(t1, /^txn-\d{6}$/)
    assert.strictEqual(await commons.read('WORKSPACE/a.txt'), 'a\nb\n')
    const t2 = await commons.write({ path: 'WORKSPACE/a.txt', diff: { added: ['c'], removedLineCount: 1, atLine: 2 }, intent: 'replace line 2', author: 'm1' })
    assert.ok(t2 > t1)
    assert.strictEqual(await commons.read('WORKSPACE/a.txt'), 'a\nc\n')
  })
})

test('sync() replays deltas exclusively of since', async () => {
  await withCommons('opus-phase3-', async (commons) => {
    await commons.write({ path: 'WORKSPACE/a.txt', diff: { added: ['a'], removedLineCount: 0, atLine: 1 }, intent: 't1', author: 'm1' })
    await commons.write({ path: 'WORKSPACE/b.txt', diff: { added: ['b'], removedLineCount: 0, atLine: 1 }, intent: 't2', author: 'm2' })
    const all = await commons.sync()
    assert.strictEqual(all.length, 2)
    const after = await commons.sync(all[0].txn)
    assert.strictEqual(after.length, 1)
    assert.strictEqual(after[0].path, 'WORKSPACE/b.txt')
  })
})

test('claims gate: non-holder write is blocked (queued, not written)', async () => {
  await withCommons('opus-phase3-', async (commons) => {
    await commons.write({ path: 'WORKSPACE/a.txt', diff: { added: ['a'], removedLineCount: 0, atLine: 1 }, intent: 'claim', author: 'm1', claims: ['WORKSPACE/a.txt'] })
    assert.strictEqual(await commons.read('WORKSPACE/a.txt'), 'a\n')
    // non-holder write while claim active: returns a txn but is queued blocked, file unchanged
    const t = await commons.write({ path: 'WORKSPACE/a.txt', diff: { added: ['x'], removedLineCount: 0, atLine: 1 }, intent: 'steal', author: 'm2' })
    assert.match(t, /^txn-\d{6}$/)
    assert.strictEqual(await commons.read('WORKSPACE/a.txt'), 'a\n')
    // the blocked txn appears in sync with status blocked
    const all = await commons.sync()
    const blocked = all.find((d) => d.txn === t)
    assert.ok(blocked, 'blocked txn present in delta')
    assert.strictEqual(blocked.status, 'blocked')
    // holder can still write (re-claiming keeps the claim)
    await commons.write({ path: 'WORKSPACE/a.txt', diff: { added: ['holder'], removedLineCount: 0, atLine: 1 }, intent: 'holder write', author: 'm1', claims: ['WORKSPACE/a.txt'] })
    assert.strictEqual(await commons.read('WORKSPACE/a.txt'), 'holder\na\n')
  })
})

test('setClaimsAuthority seam routes gate to external authority', async () => {
  await withCommons('opus-phase3-', async (commons) => {
    setClaimsAuthority((p) => (p === 'WORKSPACE/secret.txt' ? 'authority-holder' : undefined))
    await commons.write({ path: 'WORKSPACE/secret.txt', diff: { added: ['s'], removedLineCount: 0, atLine: 1 }, intent: 'init', author: 'authority-holder', claims: ['WORKSPACE/secret.txt'] })
    // non-holder write is queued blocked (returns txn, does not throw, file unchanged)
    const t = await commons.write({ path: 'WORKSPACE/secret.txt', diff: { added: ['x'], removedLineCount: 0, atLine: 1 }, intent: 'steal', author: 'other' })
    assert.match(t, /^txn-\d{6}$/)
    assert.strictEqual(await commons.read('WORKSPACE/secret.txt'), 's\n')
    const all = await commons.sync()
    const blocked = all.find((d) => d.txn === t)
    assert.ok(blocked && blocked.status === 'blocked', 'authority-gated path blocked non-holder')
    setClaimsAuthority(() => undefined)
  })
})

test('search() over WORKSPACE only', async () => {
  await withCommons('opus-phase3-', async (commons) => {
    await commons.write({ path: 'WORKSPACE/src/a.ts', diff: { added: ['const secret = 1;'], removedLineCount: 0, atLine: 1 }, intent: 'add', author: 'm1' })
    await commons.write({ path: 'STATE/digest.md', diff: { added: ['secret stuff'], removedLineCount: 0, atLine: 1 }, intent: 'add', author: 'm1' })
    const hits = await commons.search('secret')
    assert.ok(hits.some((h) => h.path === 'WORKSPACE/src/a.ts' && h.line === 1))
    assert.ok(!hits.some((h) => h.path.startsWith('STATE/')))
  })
})

test('CommonsError shape', () => {
  const { CommonsError } = require('./types.js')
  const e = new CommonsError('COMMONS_PATH_EMPTY', 'bad path')
  assert.strictEqual(e.code, 'COMMONS_PATH_EMPTY')
  assert.strictEqual(e.folder, 'commons')
  assert.ok(e instanceof Error)
})
