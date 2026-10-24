/**
 * Common-S tests — Laya routing, Zeak gates, Dept 2 collection.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Brain } from '../state/index.js'
import { classify, route } from './laya.js'
import { zeakWrap, pruneRequest, hasCompleteUnit, reEscalationModel, newSpend } from '../zeak/zeak.js'
import type { Transport, CompletionRequest, TransportChunk } from '../transport/types.js'
import { collectTopic, GitHubCollector, BrowserCollector } from '../depts/data-collection.js'
import type { CollectedItem, Collector } from '../depts/data-collection.js'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ruic-commons-'))
}

/* ---------------- Laya (Dept 1) ---------------- */

test('laya: trivial brief routes local (free)', async () => {
  const dir = tmpDir()
  try {
    const brain = new Brain(dir, null)
    await brain.init()
    const decision = await route(
      { brief: 'fix a small typo in the readme label text', goalState: ['typo fixed'] },
      brain, 0,
    )
    assert.equal(decision.decision, 'local')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('laya: architectural brief decomposes', () => {
  const decision = classify(
    { brief: 'redesign the database schema and auth architecture for the distributed pipeline, migrate all services', goalState: ['a', 'b', 'c', 'd', 'e'] },
    { openHandoffs: 0, digestTokens: 0 },
  )
  assert.equal(decision.decision, 'decompose')
})

test('laya: open handoffs in the Brain push toward decomposition', async () => {
  const dir = tmpDir()
  try {
    const brain = new Brain(dir, null)
    await brain.init()
    await brain.writeContract({
      taskId: 'T-01', status: 'handed_off', owner: 'eng-1',
      remaining: ['finish the parser'],
    })
    const decision = await route(
      { brief: 'continue the work: update a css style and a log line', goalState: ['done'] },
      brain, 0,
    )
    // Even a small brief with open handoffs goes heavy — work changes hands
    // through Dept 4, not silently.
    assert.equal(decision.decision, 'decompose')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------------- Zeak (Tier 4) ---------------- */

function fakeTransport(respond: (req: CompletionRequest) => TransportChunk[]): Transport {
  return {
    async *complete(req: CompletionRequest): AsyncGenerator<TransportChunk, void, undefined> {
      for (const chunk of respond(req)) yield chunk
    },
  }
}

const REQ: CompletionRequest = {
  modelId: 'lead',
  system: 'sys',
  messages: [{ role: 'user', content: 'do the thing' }],
}

test('zeak: over-cap falls back to local AND is loud (event + durable flag)', async () => {
  const dir = tmpDir()
  try {
    const brain = new Brain(dir, null)
    await brain.init()
    const events: Array<{ event: string; payload: unknown }> = []
    const paid = fakeTransport(() => [{ type: 'text', text: 'heavy answer' }, { type: 'done', finishReason: 'stop' }])
    const local = fakeTransport(() => [{ type: 'text', text: 'local answer' }, { type: 'done', finishReason: 'stop' }])
    const paidCalls: CompletionRequest[] = []
    let call = 0
    const registry: Transport = {
      async *complete(req) {
        call += 1
        if (req.modelId === 'lead') { paidCalls.push(req); yield* paid.complete(req) }
        else yield* local.complete(req)
      },
    }
    const gated = zeakWrap(registry, {
      budgets: { departments: { engineering: 1 }, escalations: 1 }, // 1 token cap: instant fallback
      brain,
      events: { emit: (event, payload) => events.push({ event, payload }) },
      fallbackModelId: 'eng-1',
    }, () => 'engineering', () => 'T-01')
    const out: TransportChunk[] = []
    for await (const chunk of gated.complete({ ...REQ, modelId: 'lead' })) out.push(chunk)
    // The fallback SERVED the request from the local model.
    assert.equal((out[0] as { text: string }).text, 'local answer')
    // The fallback is LOUD: event emitted...
    assert.ok(events.some((e) => e.event === 'zeak.fallback'))
    // ...and durably flagged in the Brain so Security can re-escalate.
    const flags = await brain.getTaskFlags('T-01')
    assert.equal(flags.zeakFallback, true)
    void call
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('zeak: Security rejection re-escalates a fallback task exactly once', async () => {
  const dir = tmpDir()
  try {
    const brain = new Brain(dir, null)
    await brain.init()
    await brain.setTaskFlags('T-05', { zeakFallback: true, fallbackReason: 'cap_exceeded' })
    const events: Array<{ event: string; payload: unknown }> = []
    const emitter = { emit: (event: string, payload: unknown) => events.push({ event, payload }) }
    const budgets = { departments: {}, escalations: 1 }
    const spend = newSpend()
    const first = await reEscalationModel(brain, 'T-05', 'lead', budgets, emitter, spend)
    assert.equal(first, 'lead')
    // Budget spent: the second rejection is denied — downgrade never loops.
    const second = await reEscalationModel(brain, 'T-05', 'lead', budgets, emitter, spend)
    assert.equal(second, null)
    assert.ok(events.some((e) => e.event === 'zeak.escalation'))
    assert.ok(events.some((e) => e.event === 'zeak.escalation_denied'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('zeak: early-stop only fires on a COMPLETE unit (never mid-structure)', () => {
  const midStructure: TransportChunk[] = [{ type: 'text', text: 'function foo() { const x' }]
  assert.equal(hasCompleteUnit(midStructure), false)
  const complete: TransportChunk[] = [{ type: 'text', text: 'function foo() { return 1 }\n' }]
  assert.equal(hasCompleteUnit(complete), true)
})

test('zeak: pruner drops trailing empty messages, never content', () => {
  const pruned = pruneRequest({
    ...REQ,
    messages: [...REQ.messages, { role: 'user', content: '   ' }],
  })
  assert.equal(pruned.messages.length, 1)
})

/* ---------------- Dept 2: Data Collection ---------------- */

test('dept2: cache-gate serves repeat research from the Brain for free', async () => {
  const dir = tmpDir()
  try {
    const brain = new Brain(dir, (text) => {
      const v = new Array(8).fill(0)
      for (const ch of text.toLowerCase()) v[ch.charCodeAt(0) % 8] += 1
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
      return Promise.resolve(v.map((x) => x / norm))
    })
    await brain.init()
    let calls = 0
    const collector: Collector = {
      name: 'counting',
      collect: async () => {
        calls += 1
        return [{ title: 't', body: 'qwen local executor serves the build', source: 'test' }]
      },
    }
    const events: string[] = []
    const first = await collectTopic('qwen local executor serves the build', {
      brain, collector, events: { emit: (e) => events.push(e) },
    })
    assert.equal(first.servedFromCache, false)
    assert.equal(calls, 1)
    const second = await collectTopic('qwen local executor serves the build', {
      brain, collector, events: { emit: (e) => events.push(e) },
    })
    assert.equal(second.servedFromCache, true)
    assert.equal(calls, 1) // the collector never fired again
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dept2: GitHub collector treats a 403 as a spent budget (back off)', async () => {
  let requests = 0
  const collector = new GitHubCollector({
    maxRequests: 3,
    fetchImpl: (async () => {
      requests += 1
      return new Response('rate limited', { status: 403 })
    }) as unknown as typeof fetch,
  })
  const first = await collector.collect('ruic')
  assert.equal(first.length, 0)
  const second = await collector.collect('ruic')
  assert.equal(second.length, 0)
  // After the 403 the budget is spent: no further network calls at all.
  const used = collector.requestsUsed()
  await collector.collect('ruic')
  assert.equal(collector.requestsUsed(), used)
  assert.ok(used >= 1)
  void requests
})

test('dept2: browser collector serializes (one agent at a time) and degrades gracefully', async () => {
  const dir = tmpDir()
  try {
    const brain = new Brain(dir, null)
    await brain.init()
    let inFlight = 0
    let maxInFlight = 0
    let launches = 0
    const browser = new BrowserCollector({
      events: { emit: () => undefined },
      launch: async () => {
        launches += 1
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 15))
        inFlight -= 1
        return [{ title: 'page', body: 'obscura browsing result', source: 'obscura' }] as CollectedItem[]
      },
    })
    await Promise.all([browser.collect('a'), browser.collect('b'), browser.collect('c')])
    assert.equal(maxInFlight, 1)
    // A failed launch degrades to a miss report, never a throw.
    const failing = new BrowserCollector({ events: { emit: () => undefined }, launch: async () => null })
    const items = await failing.collect('x')
    assert.equal(items.length, 0)
    void brain
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
