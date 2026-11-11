/**
 * Phase 2 smoke test — model registry & transport against an in-process mock SSE server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { ModelRegistry, keystoreFileName } from './registry.js'

function mockSseServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ port: addr.port, close: () => server.close() })
    })
  })
}

test('keystoreFileName sanitizes unsafe ids', () => {
  assert.strictEqual(keystoreFileName('a/b:c'), 'a__b__c')
  assert.strictEqual(keystoreFileName('normal-id'), 'normal-id')
})

test('ModelRegistry register/get/list/healthCheck', async () => {
  const registry = new ModelRegistry({ keystoreDir: './keystores' })
  registry.register({
    id: 'mock-model',
    provider: 'custom',
    endpoint: 'http://localhost:1',
    model: 'mock',
    contextWindowTokens: 4096,
  })
  assert.strictEqual(registry.get('mock-model').id, 'mock-model')
  assert.strictEqual(registry.list().length, 1)

  let threw = false
  try { registry.get('nope') } catch { threw = true }
  assert.ok(threw)

  // health check with missing key -> ok:false, no throw
  const hc = await registry.healthCheck('mock-model')
  assert.strictEqual(hc.ok, false)
  assert.ok(hc.detail!.includes('API_KEY_MISSING'))
})

test('createTransport throws API_KEY_MISSING when no key configured', () => {
  const registry = new ModelRegistry({ keystoreDir: './keystores' })
  registry.register({
    id: 'nokey',
    provider: 'custom',
    endpoint: 'http://localhost:1',
    model: 'nokey',
    contextWindowTokens: 4096,
  })
  let threw = false
  try { registry.createTransport('nokey') } catch (e: any) { threw = true; assert.strictEqual(e.code, 'API_KEY_MISSING') }
  assert.ok(threw)
})

test('validateCompletionRequest rejects bad input', () => {
  const { validateCompletionRequest } = require('./transport.js')
  let threw = false
  try { validateCompletionRequest({}) } catch (e: any) { threw = true; assert.strictEqual(e.code, 'INVALID_REQUEST') }
  assert.ok(threw)
})
