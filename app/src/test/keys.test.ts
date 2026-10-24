/**
 * Opus//DECK App — Keys / surface test (R19, R16).
 *
 * Proves the renderer-facing bridge does not widen:
 *   - the exposed object is exactly { events: { subscribe, replay }, invoke };
 *   - the registered IPC channel set is exactly three;
 *   - no key material, no `apiKeyEnv` and no environment access is reachable
 *     through any surface the renderer can see;
 *   - a smuggled `apiKeyEnv` (or any unknown field) is stripped in main before
 *     it can round-trip back to the renderer;
 *   - key resolution keeps the documented folder-02 order in main.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildBridge, type DeckPreloadIpc } from '../preload/bridge'
import { DECK_CHANNEL_NAMES } from '../shared/channels'
import { loadEngine } from '../engine/engine-load'
import type { EngineModelRef } from '../engine/engine-contract'
import { DeckHost } from '../main/deck-host'
import type { DeckConfigInput, DeckConfigView } from '../shared/bridge-types'
import {
  SCRIPTED_KEYSTORE_IDS,
  SCRIPTED_MODEL_KEY,
  SCRIPTED_MODEL_KEY_ENV,
  SCRIPTED_SECRET,
  makeTempMemoryDir,
  removeDir,
  scriptedBuiltTransport,
  scriptedConfig,
} from './scripted'

class FakeIpc implements DeckPreloadIpc {
  readonly invokeChannels: string[] = []
  readonly sentChannels: string[] = []
  readonly onChannels: string[] = []

  async invoke(channel: string, payload: unknown): Promise<unknown> {
    this.invokeChannels.push(channel)
    return { ok: true, data: { echo: payload } }
  }
  sendSync(channel: string): unknown {
    this.sentChannels.push(channel)
    return { events: [], replayBase: 0, at: '' }
  }
  on(channel: string, _handler: (event: unknown, payload: unknown) => void): void {
    this.onChannels.push(channel)
  }
  off(_channel: string, _handler: (event: unknown, payload: unknown) => void): void {
    // no-op
  }
}

function makeHost(memoryDir: string): DeckHost {
  return new DeckHost({
    engine: loadEngine(),
    initialConfig: scriptedConfig(memoryDir),
    transportFactory: () => scriptedBuiltTransport(),
    schedule: (fn) => fn(),
  })
}

describe('Bridge surface (R19/R16)', () => {
  it('exposes exactly events {subscribe, replay} + invoke, and exactly three channels', async () => {
    const ipc = new FakeIpc()
    const bridge = buildBridge(ipc)

    assert.deepEqual(Object.keys(bridge).sort(), ['events', 'invoke'])
    assert.deepEqual(Object.keys(bridge.events).sort(), ['replay', 'subscribe'])
    assert.equal(typeof bridge.invoke, 'function')
    assert.equal(typeof bridge.events.subscribe, 'function')
    assert.equal(typeof bridge.events.replay, 'function')

    // No environment / process / require escape hatch on the object graph.
    const serialized = Object.keys(bridge as unknown as Record<string, unknown>)
    assert.equal(serialized.includes('env'), false)
    assert.equal(serialized.includes('process'), false)
    assert.equal(serialized.includes('require'), false)

    assert.equal(DECK_CHANNEL_NAMES.length, 3, 'exactly three IPC channels exist')
    assert.deepEqual([...DECK_CHANNEL_NAMES].sort(), ['deck:events:batch', 'deck:events:replay', 'deck:invoke'])

    const unsubscribe = bridge.events.subscribe(() => undefined)
    bridge.events.replay()
    await bridge.invoke({ type: 'crewHealth', payload: {} })

    assert.deepEqual(ipc.onChannels, ['deck:events:batch'])
    assert.deepEqual(ipc.sentChannels, ['deck:events:replay'])
    assert.deepEqual(ipc.invokeChannels, ['deck:invoke'])
    unsubscribe()
  })

  it('no surface the renderer can see carries model key material or apiKeyEnv', async () => {
    const memoryDir = makeTempMemoryDir('keys-surfaces')
    const keystoreDir = path.join(memoryDir, 'keystores')
    fs.mkdirSync(keystoreDir, { recursive: true })
    // Genuine MODEL-ACCESS key material exists in main for the whole run: the
    // env var (folder-02 first) and a per-model keystore file (the fallback).
    // If ANY bridge surface ever echoed it, the absence assertion below fails.
    const previous = process.env[SCRIPTED_MODEL_KEY_ENV]
    process.env[SCRIPTED_MODEL_KEY_ENV] = SCRIPTED_MODEL_KEY
    for (const id of SCRIPTED_KEYSTORE_IDS) {
      fs.writeFileSync(path.join(keystoreDir, id), `${SCRIPTED_MODEL_KEY}\n`, 'utf8')
    }

    const host = makeHost(memoryDir)
    try {
      const result = await host.invoke({ type: 'run', payload: scriptedConfig(memoryDir) })
      assert.equal(result.ok, true, JSON.stringify(result))

      const surfaces: unknown[] = [
        host.replay(),
        host.configView(),
        await host.crewHealth(),
        host.expectedState(),
      ]
      for (const surface of surfaces) {
        const json = JSON.stringify(surface)
        assert.equal(json.includes(SCRIPTED_MODEL_KEY), false, 'model key material must never cross the bridge')
        assert.equal(json.includes(SCRIPTED_MODEL_KEY_ENV), false, 'the key env-var name must not cross the bridge')
        assert.equal(json.includes('apiKeyEnv'), false, 'no apiKeyEnv field on the bridge')
        assert.equal(json.includes('keystore'), false, 'no keystore path on the bridge')
      }

      // Distinct from credential leakage: the audited artifact's OWN hardcoded
      // secret is the audit target and MUST be quoted back to the operator in the
      // findings feed — that is the product working, not a leak.
      assert.ok(
        host.expectedState().findings.some((finding) => finding.message.includes(SCRIPTED_SECRET)),
        'the finding feed quotes the offending line the audit flagged',
      )

      // The engine DID hold that artifact secret (the run wrote it) and the
      // patcher rewrote the literal to read an env var.
      const written = fs.readFileSync(path.join(memoryDir, 'WORKSPACE', 'src', 'app.ts'), 'utf8')
      assert.equal(written.includes('process.env'), true, 'the artifact was patched to read an env var')
    } finally {
      host.dispose()
      removeDir(memoryDir)
      if (previous === undefined) delete process.env[SCRIPTED_MODEL_KEY_ENV]
      else process.env[SCRIPTED_MODEL_KEY_ENV] = previous
    }
  })

  it('a smuggled apiKeyEnv / unknown field is stripped before it round-trips', async () => {
    const memoryDir = makeTempMemoryDir('keys-taint')
    const host = makeHost(memoryDir)
    try {
      const base = scriptedConfig(memoryDir)
      const taintedLead = {
        ...base.crew.lead,
        apiKeyEnv: 'DECK_SMUGGLED_ENV',
        evil: SCRIPTED_SECRET,
      }
      const smuggled = {
        ...base,
        crew: { ...base.crew, lead: taintedLead },
      } as unknown as DeckConfigInput

      const result = await host.invoke({ type: 'config', payload: { action: 'set', config: smuggled } })
      assert.equal(result.ok, true, JSON.stringify(result))
      if (!result.ok) return

      const view = result.data as DeckConfigView
      const out = JSON.stringify(view)
      assert.equal(out.includes('apiKeyEnv'), false)
      assert.equal(out.includes('DECK_SMUGGLED_ENV'), false)
      assert.equal(out.includes(SCRIPTED_SECRET), false)
      assert.equal(out.includes('evil'), false)
      assert.equal(view.crew.lead.id, 'lead', 'the declared fields still round-trip')
    } finally {
      host.dispose()
      removeDir(memoryDir)
    }
  })

  it('key resolution keeps folder-02 order in main: apiKeyEnv env var, then keystore file', () => {
    const engine = loadEngine()
    const dir = makeTempMemoryDir('keys-registry')
    const envName = 'DECK_TEST_API_KEY'
    try {
      fs.writeFileSync(path.join(dir, 'lead'), 'file-key-0123456789\n', 'utf8')
      const registry = new engine.ModelRegistry({ keystoreDir: dir })
      const ref: EngineModelRef = {
        id: 'lead',
        provider: 'custom',
        endpoint: 'https://api.example.com/v1',
        model: 'lead-model',
        apiKeyEnv: envName,
        contextWindowTokens: 4096,
      }
      registry.register(ref)

      delete process.env[envName]
      assert.equal(registry.resolveApiKey('lead'), 'file-key-0123456789', 'keystore file is used when env is unset')

      process.env[envName] = 'env-key-0987654321'
      try {
        assert.equal(registry.resolveApiKey('lead'), 'env-key-0987654321', 'env var wins over the keystore file')
      } finally {
        delete process.env[envName]
      }
    } finally {
      removeDir(dir)
    }
  })
})
