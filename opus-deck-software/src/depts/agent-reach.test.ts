/**
 * Common-S tests — Dept 2: the Agent-Reach collector.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentReachCollector } from './agent-reach.js'
import { collectTopic, GitHubCollector, createSerialQueue } from './data-collection.js'
import type { Collector } from './data-collection.js'
import { Brain } from '../state/index.js'
import type { CollectedItem } from './data-collection.js'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ruic-agentreach-'))
}

function events(): { list: Array<{ event: string; payload: unknown }>; sink: { emit: (e: string, p: unknown) => void } } {
  const list: Array<{ event: string; payload: unknown }> = []
  return { list, sink: { emit: (event, payload) => list.push({ event, payload }) } }
}

/** Fake child_process.spawn: emits the given stdout then exits with `code`. */
function fakeSpawn(outputs: Array<{ code: number; stdout: string }>): typeof import('child_process').spawn {
  let call = 0
  return ((bin: string, args: readonly string[]) => {
    const idx = Math.min(call++, outputs.length - 1)
    const out = outputs[idx]
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter | null
      stderr: EventEmitter | null
      kill(): void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => undefined
    process.nextTick(() => {
      child.stdout?.emit('data', Buffer.from(out?.stdout ?? ''))
      child.emit('close', out?.code ?? 0)
    })
    return child as never
  }) as unknown as typeof import('child_process').spawn
}

test('agent-reach: missing CLI degrades to a miss report, never throws', async () => {
  const { sink, list } = events()
  const collector = new AgentReachCollector({
    events: sink,
    // ENOENT path: spawn throws synchronously
    spawnImpl: (() => { throw new Error('spawn agent-reach ENOENT') }) as never,
  })
  const items = await collector.collect('bilibili trending')
  assert.equal(items.length, 0)
  assert.ok(list.some((e) => e.event === 'collector.agentreach_miss'))
})

test('agent-reach: parses structured output from a productive channel', async () => {
  const { sink } = events()
  const stdout = JSON.stringify([
    { title: 'Ruic engine', url: 'https://github.com/tayyabahmadq/RUics', body: 'Common-S orchestration system' },
    { title: 'second', content: 'another result body' },
  ])
  const collector = new AgentReachCollector({
    events: sink,
    channels: ['github'],
    availability: { available: true, detail: 'cli ready' },
    spawnImpl: fakeSpawn([{ code: 0, stdout }]),
  })
  const items = await collector.collect('ruic')
  assert.equal(items.length, 2)
  assert.equal(items[0]!.source, 'agent-reach:github:https://github.com/tayyabahmadq/RUics')
  assert.ok(items[1]!.body.length > 0)
})

test('agent-reach: JSON parse failure falls back to markdown block parsing', async () => {
  const { sink } = events()
  const markdown = '## Result One\n\nlong enough body text to pass the twenty char gate here\n\n## Result Two\n\nanother long enough block for parsing to keep it'
  const collector = new AgentReachCollector({
    events: sink,
    availability: { available: true, detail: 'cli ready' },
    spawnImpl: fakeSpawn([{ code: 0, stdout: markdown }]),
  })
  const items = await collector.collect('query')
  assert.equal(items.length, 2)
  assert.equal(items[0]!.source, 'agent-reach:websearch')
})

test('agent-reach: a failing channel falls through to the next one', async () => {
  const { sink } = events()
  const collector = new AgentReachCollector({
    events: sink,
    channels: ['bilibili', 'github'],
    availability: { available: true, detail: 'cli ready' },
    spawnImpl: fakeSpawn([
      { code: 1, stdout: '' },                       // bilibili: session expired
      { code: 0, stdout: '[{"title":"ok","body":"via github channel"}]' },
    ]),
  })
  const items = await collector.collect('ruic')
  assert.equal(items.length, 1)
  assert.ok(items[0]!.source.startsWith('agent-reach:github'))
})

test('dept2: fan-out chain tries free budget before browser time', async () => {
  const dir = tmpDir()
  try {
    const brain = new Brain(dir, null)
    await brain.init()
    const order: string[] = []
    const github: Collector = { name: 'github', collect: async () => { order.push('github'); return [] } }
    const reach: Collector = { name: 'agent-reach', collect: async () => { order.push('agent-reach'); return [{ title: 't', body: 'b', source: 'agent-reach:websearch' }] } }
    const events2 = events()
    const result = await collectTopic('ruic deep dive', {
      brain, collectors: [github, reach], events: events2.sink,
    })
    assert.deepEqual(order, ['github', 'agent-reach'])
    assert.equal(result.items.length, 1)
    assert.ok(events2.list.some((e) => e.event === 'collector.collected' && (e.payload as { via: string }).via === 'agent-reach'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dept2: the serial queue holds across collectors (one browsing agent)', async () => {
  const enqueue = createSerialQueue()
  let inFlight = 0
  let maxInFlight = 0
  const job = async (): Promise<CollectedItem[]> => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 10))
    inFlight -= 1
    return [{ title: 't', body: 'b', source: 'x' }]
  }
  await Promise.all([enqueue(job), enqueue(job), enqueue(job)])
  assert.equal(maxInFlight, 1)
})

test('dept2: GitHub misses still reach Agent-Reach through the shared queue', async () => {
  const dir = tmpDir()
  try {
    const brain = new Brain(dir, null)
    await brain.init()
    const enqueue = createSerialQueue()
    let browserJobs = 0
    const github = new GitHubCollector({
      maxRequests: 1,
      fetchImpl: (async () => new Response('rate limited', { status: 403 })) as unknown as typeof fetch,
    })
    const reach = new AgentReachCollector({
      events: { emit: () => undefined },
      enqueue,
      availability: { available: true, detail: 'cli ready' },
      spawnImpl: fakeSpawn([{ code: 0, stdout: '[{"title":"r","body":"agent reach result"}]' }]),
    })
    const reachCollect = reach.collect.bind(reach)
    reach.collect = (topic: string) => { browserJobs += 1; return reachCollect(topic) }
    const result = await collectTopic('ruic', {
      brain, collectors: [github, reach], events: { emit: () => undefined },
    })
    assert.equal(browserJobs, 1)
    assert.equal(result.items.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
