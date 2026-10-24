/**
 * FreeLLM failover loop — a broken/silent free model must never stall the
 * goal: the request routes to the next free model in the pool until one
 * answers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEngineTransport } from '../main/transport-factory'
import type { DeckConfigInput, BridgeModelRef } from '../shared/bridge-types'

type Chunk = { type: string; text?: string; finishReason?: string }
type TransportLike = { complete(req: unknown): AsyncGenerator<Chunk, void, undefined> }

function crew(): DeckConfigInput['crew'] {
  const local = (id: string, model: string): BridgeModelRef => ({
    id,
    provider: 'openai-compatible',
    endpoint: 'http://localhost:11434/v1',
    model,
    contextWindowTokens: 32768,
  })
  return {
    lead: { id: 'lead', provider: 'openai-compatible', model: 'gpt-5', contextWindowTokens: 128000 },
    engineers: [local('eng-1', 'broken-model')],
    security: [local('sec-1', 'ok-model'), local('sec-2', 'quiet-model')],
  }
}

function fakeEngine(behaviors: Record<string, () => TransportLike>): never {
  const registry = {
    register: () => undefined,
    list: () => [],
    healthCheck: async () => ({ ok: true, latencyMs: 1 }),
    createTransport: (id: string) => behaviors[id](),
  }
  return {
    engineRoot: 'C:\tmp-ruic-test',
    ModelRegistry: function () { return registry },
  } as never
}

function makeTransport(script: Array<Chunk | Error>): TransportLike {
  return {
    async *complete(): AsyncGenerator<Chunk, void, undefined> {
      for (const step of script) {
        if (step instanceof Error) throw step
        yield step
      }
    },
  }
}

async function collect(gen: AsyncIterable<Chunk>): Promise<{ text: string; chunks: number }> {
  let text = ''
  let chunks = 0
  for await (const c of gen) {
    chunks += 1
    if (c.type === 'text' && typeof c.text === 'string') text += c.text
  }
  return { text, chunks }
}

const REQ = { modelId: 'eng-1', messages: [{ role: 'user', content: 'go' }] } as never

test('freellm: a broken model routes to the next free model in the pool', async () => {
  let engCalls = 0
  let sec1Calls = 0
  const engine = fakeEngine({
    'eng-1': () => makeTransport([new Error('model crashed')]),
    'sec-1': () => {
      sec1Calls += 1
      return makeTransport([{ type: 'text', text: 'saved by ' }, { type: 'text', text: 'the pool' }, { type: 'done', finishReason: 'stop' }])
    },
    'sec-2': () => { sec1Calls += 100; return makeTransport([{ type: 'text', text: 'never' }]) },
  })
  void engCalls
  const { transport } = buildEngineTransport({ crew: crew() } as DeckConfigInput, engine)
  const { text } = await collect(transport.complete(REQ))
  assert.equal(text, 'saved by the pool')
  assert.equal(sec1Calls, 1)
})

test('freellm: a SILENT model (no text) also routes onward', async () => {
  const engine = fakeEngine({
    'eng-1': () => makeTransport([{ type: 'usage', finishReason: 'x' }, { type: 'done', finishReason: 'stop' }]),
    'sec-1': () => makeTransport([{ type: 'text', text: 'second model answered.' }, { type: 'done', finishReason: 'stop' }]),
    'sec-2': () => makeTransport([{ type: 'text', text: 'third' }]),
  })
  const { transport } = buildEngineTransport({ crew: crew() } as DeckConfigInput, engine)
  const { text } = await collect(transport.complete(REQ))
  assert.equal(text, 'second model answered.')
})

test('freellm: pool exhaustion surfaces a precise error, never hangs', async () => {
  const engine = fakeEngine({
    'eng-1': () => makeTransport([new Error('down 1')]),
    'sec-1': () => makeTransport([new Error('down 2')]),
    'sec-2': () => makeTransport([new Error('down 3')]),
  })
  const { transport } = buildEngineTransport({ crew: crew() } as DeckConfigInput, engine)
  await assert.rejects(async () => {
    for await (const _c of transport.complete(REQ)) void _c
  }, /FreeLLM pool exhausted/)
})
