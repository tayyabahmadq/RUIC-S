/**
 * Phase 3 (integration roadmap): gate severity configuration.
 *
 * R5: ONE source, resolved ONCE at wiring —
 *   explicitly-passed runtime config -> STATE/config.json -> default "critical"
 * — and ONE injected value driving BOTH consumers:
 *   - the folder-09 merge gate's severity-thresholded blocking, and
 *   - the folder-08 audit escalation threshold.
 *
 * The headline fixture: failOn="high" makes a high-severity unresolved finding
 * block merge AND escalate, while the default failOn="critical" does neither —
 * proven through the same injected value in both cases.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initOpusDeck } from '../config/bootstrap.js'
import { CommonsError } from '../config/errors.js'
import { wireOpusDeck } from './index.js'
import { DEFAULT_FAIL_ON, gateConfigPath, resolveGateSeverity } from './severity-config.js'
import { remediateFindings } from '../audit/index.js'

// --- fixtures ---------------------------------------------------------------

/** SEC-003 (SQL by concatenation): severity high, NO patch strategy. */
const HIGH_FINDING = {
  id: 'FND-HIGH-0001',
  ruleId: 'SEC-003' as const,
  severity: 'high' as const,
  path: 'src/app.ts',
  line: 2,
  detectorModelId: 'sec-1',
  resolved: false,
  evidence: 'query = "SELECT * FROM users WHERE id = " + id',
  message: 'SQL by concatenation',
  auditorCount: 1,
  blocking: true,
}

function crewModel(id: string, model: string) {
  return { id, provider: 'custom' as const, model, contextWindowTokens: 4096 }
}

interface Harness {
  root: string
  memoryDir: string
  outputDir: string
  wired: Awaited<ReturnType<typeof wireOpusDeck>>
}

async function harness(
  prefix: string,
  wire: { gate?: { failOn: 'critical' | 'high' | 'medium' | 'low' } } = {},
  options: { configJson?: string; findings?: readonly unknown[] } = {},
): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const memoryDir = path.join(root, 'COMMONS')
  const outputDir = path.join(root, 'OUTPUT')
  const runtime = initOpusDeck({
    memoryDir, outputDir, brief: 'build an app', goalState: ['app builds'],
    crew: {
      lead: crewModel('lead', 'lead-model'),
      engineers: [crewModel('eng-1', 'eng-model')],
      security: [crewModel('sec-1', 'sec-model'), crewModel('sec-2', 'sec-model-2')],
    },
  })
  // Boot-time sources the gate reads: an optional STATE/config.json and the
  // finding under test. tasks.json is the claim authority (array form).
  fs.writeFileSync(path.join(memoryDir, 'STATE', 'tasks.json'), JSON.stringify([]), 'utf8')
  if (options.configJson !== undefined) {
    fs.writeFileSync(gateConfigPath(memoryDir), options.configJson, 'utf8')
  }
  if (options.findings !== undefined) {
    // f09 persists findings as { id, severity, path, line, detector, resolved };
    // the f08 finding fixture uses detectorModelId — map it at the boundary.
    const f09Rows = (options.findings as readonly any[]).map((f) => ({
      id: f.id, severity: f.severity, path: f.path, line: f.line,
      detector: f.detectorModelId, resolved: f.resolved,
    }))
    fs.writeFileSync(path.join(memoryDir, 'STATE', 'findings.json'), JSON.stringify(f09Rows), 'utf8')
  }
  const wired = await wireOpusDeck(runtime, {
    transport: { async *complete() { yield { type: 'text', text: '[]' } } } as any,
    leadModelId: 'lead',
    auditorModelIds: ['sec-1', 'sec-2'],
    ...(wire.gate === undefined ? {} : { gate: wire.gate }),
  })
  return { root, memoryDir, outputDir, wired }
}

function scratchBus(): { bus: any; executed: any[] } {
  const executed: any[] = []
  return {
    executed,
    bus: {
      enqueue: async (task: any) => { executed.push(task); return { taskId: task.id, accepted: true } },
      awaitSettlement: async (receipt: any) => ({ taskId: receipt.taskId, ok: true }),
    },
  }
}

// ---------------------------------------------------------------------------
// 1. Resolution precedence (R5)
// ---------------------------------------------------------------------------

test('R5 precedence: default is "critical" (= shipped behavior)', () => {
  assert.strictEqual(DEFAULT_FAIL_ON, 'critical')
  assert.strictEqual(resolveGateSeverity(), 'critical')
  assert.strictEqual(resolveGateSeverity({ memoryDir: path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()) }), 'critical')
})

test('R5 precedence: STATE/config.json supplies the value when nothing is passed explicitly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-sev-file-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    fs.mkdirSync(path.dirname(gateConfigPath(memoryDir)), { recursive: true })
    fs.writeFileSync(gateConfigPath(memoryDir), JSON.stringify({ gate: { failOn: 'high' } }), 'utf8')
    assert.strictEqual(resolveGateSeverity({ memoryDir }), 'high')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('R5 precedence: an explicitly-passed runtime config beats STATE/config.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-sev-explicit-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    fs.mkdirSync(path.dirname(gateConfigPath(memoryDir)), { recursive: true })
    fs.writeFileSync(gateConfigPath(memoryDir), JSON.stringify({ gate: { failOn: 'low' } }), 'utf8')
    assert.strictEqual(resolveGateSeverity({ memoryDir, explicit: 'medium' }), 'medium')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('R5: an invalid STATE/config.json fails fast with a precise error (file + key + expected vs found)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-sev-invalid-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const file = gateConfigPath(memoryDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })

    fs.writeFileSync(file, JSON.stringify({ gate: { failOn: 'hgh' } }), 'utf8')
    try {
      resolveGateSeverity({ memoryDir })
      throw new Error('E_EXPECTED_FAILURE')
    } catch (err) {
      assert.ok(err instanceof CommonsError, `expected CommonsError, got ${String(err)}`)
      assert.strictEqual((err as CommonsError).code, 'gate-config.invalid')
      const message = (err as CommonsError).message
      assert.ok(message.includes(file), `names the file: ${message}`)
      assert.ok(message.includes('gate.failOn'), `names the key: ${message}`)
      assert.ok(message.includes('expected one of critical|high|medium|low'), `states what was expected: ${message}`)
      assert.ok(message.includes('"hgh"'), `states what was found: ${message}`)
    }

    fs.writeFileSync(file, JSON.stringify({ gate: {} }), 'utf8')
    try {
      resolveGateSeverity({ memoryDir })
      throw new Error('E_EXPECTED_FAILURE')
    } catch (err) {
      assert.ok(err instanceof CommonsError)
      assert.ok((err as CommonsError).message.includes('gate.failOn'), 'a missing failOn is named precisely')
    }

    fs.writeFileSync(file, '{ not json', 'utf8')
    try {
      resolveGateSeverity({ memoryDir })
      throw new Error('E_EXPECTED_FAILURE')
    } catch (err) {
      assert.ok(err instanceof CommonsError)
      assert.strictEqual((err as CommonsError).code, 'gate-config.invalid')
      assert.ok((err as CommonsError).message.includes(file))
    }

    // boot: wireOpusDeck surfaces the same failure (an invalid file aborts boot)
    const invalidBootRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-sev-boot-'))
    try {
      const bootMemory = path.join(invalidBootRoot, 'COMMONS')
      const runtime = initOpusDeck({
        memoryDir: bootMemory, outputDir: path.join(invalidBootRoot, 'OUTPUT'), brief: 'x', goalState: ['y'],
        crew: {
          lead: crewModel('lead', 'lead-model'),
          engineers: [crewModel('eng-1', 'eng-model')],
          security: [crewModel('sec-1', 'sec-model'), crewModel('sec-2', 'sec-model-2')],
        },
      })
      fs.mkdirSync(path.dirname(gateConfigPath(bootMemory)), { recursive: true })
      fs.writeFileSync(gateConfigPath(bootMemory), JSON.stringify({ gate: { failOn: 42 } }), 'utf8')
      await assert.rejects(
        () => wireOpusDeck(runtime, { transport: { async *complete() { yield { type: 'text', text: '[]' } } } as any, leadModelId: 'lead', auditorModelIds: ['sec-1', 'sec-2'] }),
        (err: unknown) => err instanceof CommonsError && err.code === 'gate-config.invalid' && err.message.includes('gate.failOn'),
        'boot aborts on an invalid gate severity config',
      )
    } finally {
      fs.rmSync(invalidBootRoot, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. The fixture — ONE injected value drives BOTH consumers
// ---------------------------------------------------------------------------

test('fixture: failOn="high" — a high-severity finding blocks merge AND escalates (one injected value)', async () => {
  const { root, memoryDir, outputDir, wired } = await harness('opus-sev-high-', { gate: { failOn: 'high' } }, { findings: [HIGH_FINDING] })
  try {
    // THE single injected value
    assert.strictEqual(wired.gate.failOn, 'high')

    // consumer 1 — merge gate: the high-severity unresolved finding blocks
    await assert.rejects(
      () => wired.merge(memoryDir, outputDir),
      (err: any) => err.code === 'GATE_FAILED',
      'failOn=high: a high-severity unresolved finding blocks merge',
    )
    assert.ok(!fs.existsSync(path.join(outputDir, 'MANIFEST.json')), 'no MANIFEST when the gate blocks')

    // consumer 2 — audit escalation threshold: the same value escalates it
    const { bus } = scratchBus()
    const result = await wired.remediateFindings(
      [HIGH_FINDING as any],
      { bus, artifacts: wired.f08.artifactStore, escalations: wired.f08.escalationQueue },
      { maxRounds: 2 },
    )
    assert.strictEqual(result.escalations.length, 1, 'failOn=high: the high-severity finding escalates')
    assert.strictEqual(result.escalations[0].reason, 'no-patch-strategy')
    assert.strictEqual(result.escalations[0].severity, 'high')
    assert.strictEqual(result.advisories.length, 0, 'nothing falls below the threshold')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fixture: default failOn="critical" — the SAME high-severity finding does NOT block merge and does NOT escalate', async () => {
  const { root, memoryDir, outputDir, wired } = await harness('opus-sev-critical-', {}, { findings: [HIGH_FINDING] })
  try {
    assert.strictEqual(wired.gate.failOn, 'critical', 'the default is the shipped behavior')

    // consumer 1 — merge gate: a high-severity finding is below the threshold
    const manifest = await wired.merge(memoryDir, outputDir)
    assert.ok(manifest.totalFiles >= 0, 'merge proceeds at failOn=critical')
    assert.ok(fs.existsSync(path.join(outputDir, 'MANIFEST.json')), 'MANIFEST written when the gate is not blocked')

    // consumer 2 — audit escalation threshold: advisory, never escalated
    const { bus, executed } = scratchBus()
    const result = await wired.remediateFindings(
      [HIGH_FINDING as any],
      { bus, artifacts: wired.f08.artifactStore, escalations: wired.f08.escalationQueue },
      { maxRounds: 2 },
    )
    assert.strictEqual(result.escalations.length, 0, 'failOn=critical: a high-severity finding does not escalate')
    assert.strictEqual(executed.length, 0, 'and nothing is remediated')
    assert.deepStrictEqual(result.advisories.map((a) => a.findingId), [HIGH_FINDING.id], 'it surfaces as a non-blocking advisory instead')
    assert.strictEqual(result.advisories[0].blocking, false)

    // a per-call value cannot split the two consumers: the wired surface carries
    // no per-call failOn (it is resolved once at boot), so the high finding
    // stays below the injected 'critical' threshold and nothing escalates.
    const overridden = await wired.remediateFindings(
      [HIGH_FINDING as any],
      { bus, artifacts: wired.f08.artifactStore, escalations: wired.f08.escalationQueue },
      { maxRounds: 2 },
    )
    assert.strictEqual(overridden.escalations.length, 0, 'the injected value is authoritative (single source)')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fixture: STATE/config.json drives BOTH consumers with the same value (file-sourced injection)', async () => {
  const { root, memoryDir, outputDir, wired } = await harness(
    'opus-sev-file-driven-',
    {},
    { configJson: JSON.stringify({ gate: { failOn: 'high' } }), findings: [HIGH_FINDING] },
  )
  try {
    assert.strictEqual(wired.gate.failOn, 'high', 'the value came from STATE/config.json, resolved at boot')

    await assert.rejects(
      () => wired.merge(memoryDir, outputDir),
      (err: any) => err.code === 'GATE_FAILED',
      'the merge gate blocks on the file-sourced value',
    )

    const { bus } = scratchBus()
    const result = await wired.remediateFindings(
      [HIGH_FINDING as any],
      { bus, artifacts: wired.f08.artifactStore, escalations: wired.f08.escalationQueue },
      { maxRounds: 2 },
    )
    assert.strictEqual(result.escalations.length, 1, 'the escalation threshold reads the same file-sourced value')
    assert.strictEqual(result.escalations[0].severity, 'high')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('explicit runtime config overrides STATE/config.json for BOTH consumers', async () => {
  const { root, memoryDir, outputDir, wired } = await harness(
    'opus-sev-override-',
    { gate: { failOn: 'critical' } },
    { configJson: JSON.stringify({ gate: { failOn: 'high' } }), findings: [HIGH_FINDING] },
  )
  try {
    assert.strictEqual(wired.gate.failOn, 'critical', 'explicit beats file')

    const manifest = await wired.merge(memoryDir, outputDir)
    assert.ok(fs.existsSync(path.join(outputDir, 'MANIFEST.json')), 'merge proceeds under the explicit value')
    assert.ok(manifest.totalFiles >= 0)

    const { bus } = scratchBus()
    const result = await wired.remediateFindings(
      [HIGH_FINDING as any],
      { bus, artifacts: wired.f08.artifactStore, escalations: wired.f08.escalationQueue },
      { maxRounds: 2 },
    )
    assert.strictEqual(result.escalations.length, 0, 'the escalation threshold follows the explicit value too')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Shipped behavior at the default (regression guard)
// ---------------------------------------------------------------------------

test('shipped behavior preserved at the default: a critical unresolved finding still blocks merge and still escalates', async () => {
  const criticalFinding = { ...HIGH_FINDING, id: 'FND-CRIT-0001', ruleId: 'SEC-001' as const, severity: 'critical' as const, evidence: 'eval(input)' }
  const { root, memoryDir, outputDir, wired } = await harness('opus-sev-crit-guard-', {}, { findings: [criticalFinding] })
  try {
    assert.strictEqual(wired.gate.failOn, 'critical')
    await assert.rejects(
      () => wired.merge(memoryDir, outputDir),
      (err: any) => err.code === 'GATE_FAILED',
      'a critical finding blocks merge at the default (shipped behavior)',
    )
    const { bus } = scratchBus()
    const result = await wired.remediateFindings(
      [criticalFinding as any],
      { bus, artifacts: wired.f08.artifactStore, escalations: wired.f08.escalationQueue },
      { maxRounds: 2 },
    )
    assert.strictEqual(result.escalations.length, 1, 'a critical finding still escalates at the default')
    assert.strictEqual(result.escalations[0].reason, 'no-patch-strategy')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('shipped behavior preserved when called directly: audit defaults to the same threshold', async () => {
  const { bus } = scratchBus()
  const result = await remediateFindings([HIGH_FINDING as any], { bus } as any, { maxRounds: 2 })
  assert.strictEqual(result.escalations.length, 0, 'without an injected value the audit default is "critical"')
  assert.deepStrictEqual(result.advisories.map((a) => a.findingId), [HIGH_FINDING.id])
})
