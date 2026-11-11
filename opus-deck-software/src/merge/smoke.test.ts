/**
 * Phase 9 smoke test — merge & build engine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { merge, checkReadiness, loadClaims } from './index.js'

function seedMemory(root: string): string {
  const memoryDir = path.join(root, 'COMMONS')
  fs.mkdirSync(path.join(memoryDir, 'STATE'), { recursive: true })
  fs.mkdirSync(path.join(memoryDir, 'WORKSPACE'), { recursive: true })
  fs.mkdirSync(path.join(memoryDir, 'DELTA'), { recursive: true })
  fs.writeFileSync(path.join(memoryDir, 'WORKSPACE', 'app.ts'), 'export const a = 1;\n', 'utf8')
  fs.writeFileSync(path.join(memoryDir, 'STATE', 'tasks.json'), JSON.stringify([]), 'utf8')
  fs.writeFileSync(path.join(memoryDir, 'STATE', 'presence.json'), JSON.stringify({ updated: new Date().toISOString(), entries: [] }), 'utf8')
  fs.writeFileSync(path.join(memoryDir, 'STATE', 'findings.json'), JSON.stringify([]), 'utf8')
  return memoryDir
}

test('merge: clean merge writes MANIFEST.json and OVERRIDES.log', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-phase9-'))
  try {
    const memoryDir = seedMemory(root)
    const outputDir = path.join(root, 'OUTPUT')
    const manifest = await merge(memoryDir, outputDir)
    assert.ok(manifest.totalFiles >= 1)
    assert.ok(fs.existsSync(path.join(outputDir, 'MANIFEST.json')))
    assert.ok(fs.existsSync(path.join(outputDir, 'OVERRIDES.log')))
    assert.ok(fs.existsSync(path.join(outputDir, 'app.ts')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('merge: unresolved critical findings block with GATE_FAILED', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-phase9-'))
  try {
    const memoryDir = seedMemory(root)
    fs.writeFileSync(path.join(memoryDir, 'STATE', 'findings.json'), JSON.stringify([
      { id: 'F-1', severity: 'critical', path: 'src/app.ts', line: 1, detector: 'sec-1', resolved: false },
    ]), 'utf8')
    const outputDir = path.join(root, 'OUTPUT')
    await assert.rejects(merge(memoryDir, outputDir), (err: any) => err.code === 'GATE_FAILED')
    assert.ok(!fs.existsSync(path.join(outputDir, 'MANIFEST.json')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('merge: live tasks.json claim blocks (dangling-locks)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-phase9-'))
  try {
    const memoryDir = seedMemory(root)
    fs.writeFileSync(path.join(memoryDir, 'STATE', 'tasks.json'), JSON.stringify([
      { kind: 'claim', claimId: 'c1', modelId: 'eng-1', path: 'src/app.ts', createdAt: 1 },
    ]), 'utf8')
    const claims = await loadClaims(memoryDir)
    assert.strictEqual(claims.length, 1)
    const checks = await checkReadiness(memoryDir)
    const dangling = checks.find((c) => c.id === 'dangling-locks')!
    assert.strictEqual(dangling.passed, false)
    assert.ok(dangling.detail!.includes('eng-1'))
    const outputDir = path.join(root, 'OUTPUT')
    await assert.rejects(merge(memoryDir, outputDir), (err: any) => err.code === 'GATE_FAILED')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
