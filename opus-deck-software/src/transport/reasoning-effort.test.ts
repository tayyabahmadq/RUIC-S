/**
 * Reasoning-effort integration test — the opt-in thinking knob from the
 * system_prompts_leaks integration (Claude Code reasoning_effort scale +
 * Anthropic output_config.effort per the leaked claude-api skill).
 *
 * Two invariants:
 * 1. When ModelRef.reasoningEffort is set, each adapter puts it on the wire.
 * 2. When unset, the wire body is byte-identical to the shipped shape —
 *    no reasoning field ever appears.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAiCompatibleTransport } from './adapters/openai-compatible.js'
import { AnthropicTransport } from './adapters/anthropic.js'
import { CustomTransport } from './adapters/custom.js'
import type { FetchLike, FetchInit, FetchResponse, ModelRef } from './types.js'

interface CapturedCall {
  url: string
  init: FetchInit
}

/** Fetch stub: captures the request, returns an immediately-completed SSE body. */
function stubFetch(calls: CapturedCall[]): FetchLike {
  return async (url: string, init: FetchInit): Promise<FetchResponse> => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
        }),
      },
      text: async () => '',
    }
  }
}

function baseRef(extra: Partial<ModelRef> = {}): ModelRef {
  return {
    id: 'm',
    provider: 'openai-compatible',
    endpoint: 'http://127.0.0.1:1',
    model: 'm',
    contextWindowTokens: 4096,
    ...extra,
  }
}

function sentBody(calls: CapturedCall[]): Record<string, unknown> {
  return JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
}

const REQ = { modelId: 'm', messages: [{ role: 'user' as const, content: 'hi' }] }

test('openai-compatible adapter: reasoning_effort goes on the wire when configured', async () => {
  const calls: CapturedCall[] = []
  const t = new OpenAiCompatibleTransport({ ref: baseRef({ reasoningEffort: 'high' }), apiKey: 'k', fetch: stubFetch(calls) })
  for await (const _chunk of t.complete(REQ)) { /* drain */ }
  assert.strictEqual(sentBody(calls).reasoning_effort, 'high')
})

test('openai-compatible adapter: no reasoning field when reasoningEffort is unset', async () => {
  const calls: CapturedCall[] = []
  const t = new OpenAiCompatibleTransport({ ref: baseRef(), apiKey: 'k', fetch: stubFetch(calls) })
  for await (const _chunk of t.complete(REQ)) { /* drain */ }
  assert.ok(!('reasoning_effort' in sentBody(calls)), 'shaped wire body is unchanged without the knob')
})

test('anthropic adapter: effort goes inside output_config, never a thinking budget', async () => {
  const calls: CapturedCall[] = []
  const t = new AnthropicTransport({ ref: baseRef({ provider: 'anthropic', reasoningEffort: 'xhigh' }), apiKey: 'k', fetch: stubFetch(calls) })
  for await (const _chunk of t.complete(REQ)) { /* drain */ }
  const body = sentBody(calls)
  assert.deepStrictEqual(body.output_config, { effort: 'xhigh' })
  assert.ok(!('thinking' in body), 'thinking is adaptive on current models — budget_tokens is a 400')
  assert.ok(!JSON.stringify(body).includes('budget_tokens'), 'budget_tokens must never appear anywhere on the wire')
  assert.ok(calls[0].url.endsWith('/v1/messages'))
})

test('anthropic adapter: no output_config when reasoningEffort is unset', async () => {
  const calls: CapturedCall[] = []
  const t = new AnthropicTransport({ ref: baseRef({ provider: 'anthropic' }), apiKey: 'k', fetch: stubFetch(calls) })
  for await (const _chunk of t.complete(REQ)) { /* drain */ }
  assert.ok(!('output_config' in sentBody(calls)))
})

test('custom adapter: OpenAI-style reasoning_effort goes on the wire when configured', async () => {
  const calls: CapturedCall[] = []
  const t = new CustomTransport({ ref: baseRef({ provider: 'custom', reasoningEffort: 'max' }), apiKey: 'k', fetch: stubFetch(calls) })
  for await (const _chunk of t.complete(REQ)) { /* drain */ }
  assert.strictEqual(sentBody(calls).reasoning_effort, 'max')
})

test('custom adapter: no reasoning field when reasoningEffort is unset', async () => {
  const calls: CapturedCall[] = []
  const t = new CustomTransport({ ref: baseRef({ provider: 'custom' }), apiKey: 'k', fetch: stubFetch(calls) })
  for await (const _chunk of t.complete(REQ)) { /* drain */ }
  assert.ok(!('reasoning_effort' in sentBody(calls)))
})

test('config: reasoningEffort validates and resolves on crew models', () => {
  const { resolveOpusDeckConfig } = require('../config/index.js')
  const resolved = resolveOpusDeckConfig({
    memoryDir: './COMMONS',
    outputDir: './OUTPUT',
    brief: 'b',
    goalState: ['g'],
    crew: {
      lead: { id: 'lead', provider: 'custom', model: 'm', contextWindowTokens: 4096, reasoningEffort: 'xhigh' },
      engineers: [{ id: 'e', provider: 'custom', model: 'm', contextWindowTokens: 4096 }],
      security: [
        { id: 's1', provider: 'custom', model: 'm', contextWindowTokens: 4096 },
        { id: 's2', provider: 'custom', model: 'm', contextWindowTokens: 4096 },
      ],
    },
  })
  assert.strictEqual(resolved.crew.lead.reasoningEffort, 'xhigh')
  assert.strictEqual(resolved.crew.engineers[0].reasoningEffort, undefined)
})

test('config: an invalid reasoningEffort is rejected as config.invalid', () => {
  const { resolveOpusDeckConfig } = require('../config/index.js')
  let threw = false
  try {
    resolveOpusDeckConfig({
      memoryDir: './COMMONS',
      outputDir: './OUTPUT',
      brief: 'b',
      goalState: ['g'],
      crew: {
        lead: { id: 'lead', provider: 'custom', model: 'm', contextWindowTokens: 4096, reasoningEffort: 'extreme' },
        engineers: [{ id: 'e', provider: 'custom', model: 'm', contextWindowTokens: 4096 }],
        security: [
          { id: 's1', provider: 'custom', model: 'm', contextWindowTokens: 4096 },
          { id: 's2', provider: 'custom', model: 'm', contextWindowTokens: 4096 },
        ],
      },
    })
  } catch (err) {
    threw = true
    const e = err as { code?: string; message?: string }
    assert.strictEqual(e.code, 'config.invalid')
    assert.ok(String(e.message).includes('crew.lead.reasoningEffort'), 'the error names the precise field path')
    assert.ok(String(e.message).includes('extreme'), 'the error names the offending value')
  }
  assert.ok(threw, 'expected config.invalid to throw')
})
