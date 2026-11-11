/**
 * Phase 7 smoke test — crew runner with stubbed deps.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, getPromptTokenBudget, setPromptTokenBudget } from './assemble-prompt.js'
import { runCrew } from './pool.js'
import { WorkingSetLru } from './lru.js'
import type { CrewDependencies, EventBus, Task } from './types.js'

test('buildPrompt five slots; budget overflow emits compaction.requested on injected bus', () => {
  const emitted: unknown[] = []
  const bus: EventBus = { emit: (...args) => { emitted.push(args) }, on: () => {}, once: () => {}, off: () => {} }
  setPromptTokenBudget(10)
  try {
    const prompt = buildPrompt({
      task: { id: 'T-01', locks: ['src/app.ts'], description: 'do it' },
      brief: 'b',
      digest: 'd',
      presence: [],
      workingSet: [{ path: 'x.ts', startLine: 1, endLine: 2 }],
      bus,
    })
    assert.ok(emitted.length === 1, 'compaction.requested emitted on injected bus')
    assert.ok(prompt.includes('[content omitted]'), 'slot 5 trimmed to pointers')
  } finally {
    setPromptTokenBudget(4000)
  }
})

test('buildPrompt under budget does not emit', () => {
  const emitted: unknown[] = []
  const bus: EventBus = { emit: (...args) => { emitted.push(args) }, on: () => {}, once: () => {}, off: () => {} }
  const prompt = buildPrompt({
    task: { id: 'T-01', locks: ['src/app.ts'], description: 'do it' },
    brief: 'b',
    digest: 'd',
    presence: [],
    workingSet: [],
    bus,
  })
  assert.strictEqual(emitted.length, 0)
  assert.ok(prompt.includes('## 5. Working Set'))
  assert.ok(!prompt.includes('[content omitted]'))
})

test('buildPrompt carries the execution protocol section in both budget branches', () => {
  const bus: EventBus = { emit: () => {}, on: () => {}, once: () => {}, off: () => {} }
  const args = {
    task: { id: 'T-01', locks: ['src/app.ts'], description: 'do it' },
    brief: 'b',
    digest: 'd',
    presence: [],
    bus,
  }
  // Full branch (default budget): protocol present, slots intact.
  const full = buildPrompt({ ...args, workingSet: [{ path: 'x.ts', startLine: 1, endLine: 2 }] })
  assert.ok(full.includes('## 6. Execution Protocol'), 'protocol section present (full branch)')
  assert.ok(full.indexOf('## 6.') > full.indexOf('## 5.'), 'protocol follows the working set')
  assert.ok(full.includes('Rabbit hole rule'), 'rabbit-hole rule present')

  // Trimmed branch (budget overflow): protocol is fixed content, not trimmed.
  setPromptTokenBudget(10)
  try {
    const trimmed = buildPrompt({ ...args, workingSet: [{ path: 'x.ts', startLine: 1, endLine: 2 }] })
    assert.ok(trimmed.includes('[content omitted]'), 'slot 5 trimmed')
    assert.ok(trimmed.includes('## 6. Execution Protocol'), 'protocol section present (trimmed branch)')
  } finally {
    setPromptTokenBudget(4000)
  }
})

test('runCrew completes tasks via stub transport', async () => {
  const events: unknown[] = []
  const bus: EventBus = { emit: (...args) => { events.push(args) }, on: () => {}, once: () => {}, off: () => {} }
  const deps: CrewDependencies = {
    bus,
    commons: { write: () => {} },
    transport: {
      // R21 (E1): stubs emit the FULL realistic phase-02 chunk grammar —
      // text, then usage, then done — exactly like a real adapter.
      async *stream() {
        yield { type: 'text', text: JSON.stringify({ intent: 'write', path: 'src/out.ts', added: ['x'], atLine: 1, removedLineCount: 0 }) }
        yield { type: 'usage', inputTokens: 12, outputTokens: 34 }
        yield { type: 'done', finishReason: 'stop' }
      },
    },
    locks: {},
    queue: undefined,
  }
  const result = await runCrew([{ modelId: 'eng-1' }], [
    { id: 'T-01', locks: ['src/out.ts'], description: 'do it' },
  ], { dependencies: deps })
  assert.ok(result.workers[0].completedTaskIds.length >= 1, 'task completed')
  assert.ok(events.some((e) => Array.isArray(e) && e[0] === 'task.completed'), 'task.completed emitted')
})

test('WorkingSetLru caps at capacity', () => {
  const lru = new WorkingSetLru(2)
  lru.record('m', { path: 'a.ts', startLine: 1, endLine: 1 })
  lru.record('m', { path: 'b.ts', startLine: 1, endLine: 1 })
  lru.record('m', { path: 'c.ts', startLine: 1, endLine: 1 })
  assert.strictEqual(lru.size('m'), 2)
})
