/**
 * Phase 4 smoke test — compactor (stubbed transport, commons, bus).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Compactor } from './compactor.js'
import type { CompactionResult, CompactorOptions, Commons, EventBus, LlmRequest, LlmResponse, Transport } from './types.js'

class StubCommons implements Commons {
  private files = new Map<string, string>()
  seed(path: string, content: string): void { this.files.set(path, content) }
  async read(p: string): Promise<string> {
    const v = this.files.get(p)
    if (v === undefined) throw new Error('missing ' + p)
    return v
  }
  async exists(p: string): Promise<boolean> { return this.files.has(p) }
  async write(p: string, c: string): Promise<void> { this.files.set(p, c) }
  async append(p: string, c: string): Promise<void> { this.files.set(p, (this.files.get(p) ?? '') + c) }
  async list(dir: string): Promise<string[]> {
    const prefix = dir.endsWith('/') ? dir : dir + '/'
    return [...this.files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).sort()
  }
}

class StubBus implements EventBus {
  private handlers = new Map<string, Array<(p: unknown) => void>>()
  events: Array<{ type: string; payload: unknown }> = []
  subscribe(type: string, handler: (p: unknown) => void): void {
    const s = this.handlers.get(type) ?? []; s.push(handler); this.handlers.set(type, s)
  }
  emit(type: string, payload: unknown): void | Promise<void> {
    this.events.push({ type, payload })
    for (const h of this.handlers.get(type) ?? []) h(payload)
  }
}

class StubTransport implements Transport {
  async chat(_req: LlmRequest): Promise<LlmResponse> {
    return { text: 'ARCH\n- compressed arch\n\nIFACE\n- compressed iface\n\nOPEN\n- open risk\n\nSETTLED\n- settled\n\nPINS\n- pin me', model: 'stub' }
  }
}

async function makeCompactor(opts?: CompactorOptions) {
  const commons = new StubCommons()
  commons.seed('STATE/digest.md', '# Digest\n\nARCH\n- old arch detail here\n\nPINS\n- pin me\n')
  const bus = new StubBus()
  const transport = new StubTransport()
  const compactor = new Compactor({ transport, commons, bus }, opts)
  return { compactor, commons, bus, transport }
}

test('compact() runs once and produces compaction.done', async () => {
  const { compactor, commons, bus } = await makeCompactor()
  // seed a digest over the default budget (2000 tokens ~ 8000 chars)
  commons.seed('STATE/digest.md', '# Digest\n\n' + 'x '.repeat(9000))
  const result = await compactor.compact()
  assert.strictEqual(result.ran, true)
  assert.ok(typeof result.afterTokens === 'number' && result.afterTokens < 2000)
  assert.strictEqual(result.demotedToArchive, 1)
  const done = bus.events.find((e) => e.type === 'compaction.done')
  assert.ok(done, 'compaction.done emitted')
  const payload = done.payload as CompactionResult
  assert.strictEqual(payload.ran, true)
  // digest replaced
  const digest = await commons.read('STATE/digest.md')
  assert.ok(digest.includes('ARCH'))
  // archive created
  const archive = await commons.list('ARCHIVE')
  assert.ok(archive.some((f) => f.startsWith('ARCHIVE/digest@v')))
  // PINS survive
  assert.ok(digest.includes('pin me'), 'PINS survived compaction')
})

test('compact() is idempotent when unchanged', async () => {
  const { compactor } = await makeCompactor()
  const r1 = await compactor.compact()
  assert.strictEqual(r1.ran, true)
  const r2 = await compactor.compact()
  assert.strictEqual(r2.ran, false)
  assert.strictEqual(r2.beforeTokens, 0)
})

test('compact(force=true) bypasses fingerprint', async () => {
  const { compactor } = await makeCompactor()
  await compactor.compact()
  const r = await compactor.compact(true)
  assert.strictEqual(r.ran, true)
})

test('reduceWorkingSet drops LRU ranges under budget', async () => {
  const { compactor } = await makeCompactor()
  const reduction = compactor.reduceWorkingSet([
    { path: 'a.ts', startLine: 1, endLine: 10, lastUsed: 1 },
    { path: 'b.ts', startLine: 1, endLine: 10, lastUsed: 100 },
  ], 150)
  assert.strictEqual(reduction.kept.length, 1)
  assert.strictEqual(reduction.kept[0].path, 'b.ts')
  assert.strictEqual(reduction.dropped.length, 1)
  assert.strictEqual(reduction.dropped[0].pointer, '-> a.ts:1-10 (demoted by compactor; re-read on demand)')
})

test('unpin removes a pin', async () => {
  const { compactor, commons } = await makeCompactor()
  await compactor.compact()
  const removed = await compactor.unpin('pin me')
  assert.strictEqual(removed, 1)
  const digest = await commons.read('STATE/digest.md')
  assert.ok(!digest.includes('pin me'), 'pin removed')
})
