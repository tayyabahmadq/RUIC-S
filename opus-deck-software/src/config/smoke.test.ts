/**
 * Phase 1 smoke test — config & event bus.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initOpusDeck } from './bootstrap.js'

test('initOpusDeck returns a runtime with resolved config, version and working bus', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-phase1-'))
  try {
    const runtime = initOpusDeck({
      memoryDir: path.join(root, 'COMMONS'),
      outputDir: path.join(root, 'OUTPUT'),
      brief: 'build a thing',
      goalState: ['it builds'],
      crew: {
        lead: { id: 'lead', provider: 'custom', model: 'lead-m', contextWindowTokens: 4096 },
        engineers: [{ id: 'eng-1', provider: 'custom', model: 'eng-m', contextWindowTokens: 4096 }],
        security: [
          { id: 'sec-1', provider: 'custom', model: 'sec-m', contextWindowTokens: 4096 },
          { id: 'sec-2', provider: 'custom', model: 'sec-m2', contextWindowTokens: 4096 },
        ],
      },
    })

    assert.ok(runtime.bus)
    assert.strictEqual(runtime.config.budgets.digestTokens, 2000)
    assert.strictEqual(runtime.config.budgets.promptTokens, 6000)
    assert.strictEqual(runtime.config.crew.security.length, 2)
    assert.strictEqual(typeof runtime.version, 'string')

    // bus emits and forwards to sink
    let captured = null
    runtime.bus.on('run.started', (p) => { captured = p })
    runtime.bus.emit('run.started', { runId: 'r1', brief: 'b', goalState: ['g'] })
    assert.deepStrictEqual(captured, { runId: 'r1', brief: 'b', goalState: ['g'] })

    await runtime.shutdown()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolveOpusDeckConfig fills budget defaults and absolutizes paths', () => {
  const { resolveOpusDeckConfig } = require('./index.js')
  const resolved = resolveOpusDeckConfig({
    memoryDir: './COMMONS',
    outputDir: './OUTPUT',
    brief: 'b',
    goalState: ['g'],
    crew: {
      lead: { id: 'lead', provider: 'custom', model: 'm', contextWindowTokens: 4096 },
      engineers: [{ id: 'e', provider: 'custom', model: 'm', contextWindowTokens: 4096 }],
      security: [
        { id: 's1', provider: 'custom', model: 'm', contextWindowTokens: 4096 },
        { id: 's2', provider: 'custom', model: 'm', contextWindowTokens: 4096 },
      ],
    },
  })
  assert.strictEqual(resolved.budgets.digestTokens, 2000)
  assert.strictEqual(resolved.budgets.promptTokens, 6000)
  assert.ok(path.isAbsolute(resolved.memoryDir))
  assert.ok(path.isAbsolute(resolved.outputDir))
})

test('invalid config throws a single CommonsError listing ALL invalid fields', () => {
  const { resolveOpusDeckConfig } = require('./index.js')
  const { ConfigCommonsError } = require('../index.js')
  let threw = false
  try {
    resolveOpusDeckConfig({
      memoryDir: '',
      outputDir: '',
      brief: '',
      goalState: [],
      crew: { lead: { id: '', provider: 'custom', model: '', contextWindowTokens: 0 }, engineers: [], security: [] },
    })
  } catch (err) {
    threw = true
    const e = err as { code?: string; message?: string; detail?: string }
    assert.ok(e.code === 'config.invalid')
    assert.ok(String(e.message).includes('memoryDir'), 'lists memoryDir')
    assert.ok(String(e.message).includes('outputDir'), 'lists outputDir')
    assert.ok(String(e.message).includes('brief'), 'lists brief')
    assert.ok(String(e.message).includes('goalState'), 'lists goalState')
    assert.ok(String(e.message).includes('engineers'), 'lists engineers')
    assert.ok(String(e.message).includes('security'), 'lists security')
  }
  assert.ok(threw, 'expected config.invalid to throw')
})

test('canonical COMMONS path constants are bare relative segments', () => {
  const {
    BRIEF, DECISIONS, DIGEST, PRESENCE, TASKS, FINDINGS,
    WORKSPACE, DELTA, ARCHIVE, TXN_LOG,
  } = require('./index.js')
  assert.strictEqual(BRIEF, 'BRIEF.md')
  assert.strictEqual(DECISIONS, 'DECISIONS.log')
  assert.strictEqual(DIGEST, 'STATE/digest.md')
  assert.strictEqual(PRESENCE, 'STATE/presence.json')
  assert.strictEqual(TASKS, 'STATE/tasks.json')
  assert.strictEqual(FINDINGS, 'STATE/findings.json')
  assert.strictEqual(WORKSPACE, 'WORKSPACE')
  assert.strictEqual(DELTA, 'DELTA')
  assert.strictEqual(ARCHIVE, 'ARCHIVE')
  assert.strictEqual(TXN_LOG, 'DELTA/txn.jsonl')
  // directory segments carry no trailing slash
  assert.ok(!WORKSPACE.endsWith('/') && !WORKSPACE.endsWith('\\'))
  assert.ok(!DELTA.endsWith('/') && !DELTA.endsWith('\\'))
  assert.ok(!ARCHIVE.endsWith('/') && !ARCHIVE.endsWith('\\'))
})

test('initOpusDeck creates the canonical COMMONS tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-phase1-tree-'))
  try {
    initOpusDeck({
      memoryDir: path.join(root, 'COMMONS'),
      outputDir: path.join(root, 'OUTPUT'),
      brief: 'b',
      goalState: ['g'],
      crew: {
        lead: { id: 'lead', provider: 'custom', model: 'm', contextWindowTokens: 4096 },
        engineers: [{ id: 'e', provider: 'custom', model: 'm', contextWindowTokens: 4096 }],
        security: [
          { id: 's1', provider: 'custom', model: 'm', contextWindowTokens: 4096 },
          { id: 's2', provider: 'custom', model: 'm', contextWindowTokens: 4096 },
        ],
      },
    })
    const cm = path.join(root, 'COMMONS')
    assert.ok(fs.existsSync(path.join(cm, 'BRIEF.md')))
    assert.ok(fs.existsSync(path.join(cm, 'DECISIONS.log')))
    assert.ok(fs.existsSync(path.join(cm, 'STATE', 'digest.md')))
    assert.ok(fs.existsSync(path.join(cm, 'STATE', 'presence.json')))
    assert.ok(fs.existsSync(path.join(cm, 'STATE', 'tasks.json')))
    assert.ok(fs.existsSync(path.join(cm, 'STATE', 'findings.json')))
    assert.ok(fs.existsSync(path.join(cm, 'DELTA', 'txn.jsonl')))
    assert.ok(fs.existsSync(path.join(cm, 'WORKSPACE')))
    assert.ok(fs.existsSync(path.join(cm, 'DELTA')))
    assert.ok(fs.existsSync(path.join(cm, 'ARCHIVE')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
