/**
 * Phase 8 smoke test — security audit gate.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanAll, gateBlocked, remediateFindings, RULES } from './index.js'

const auditors = ['sec-1', 'sec-2']

test('scanAll raises findings on dirty artifacts', () => {
  const report = scanAll(
    [{ path: 'src/app.ts', code: 'const API_TOKEN = "sk-prod-9f3a2b1cdeadbeef42";\neval(input);\n' }],
    auditors,
  )
  assert.ok(report.findings.length >= 1)
  assert.ok(report.findings.some((f) => f.ruleId === 'SEC-001'))
  assert.ok(report.findings.some((f) => f.ruleId === 'SEC-004'))
})

test('clean file produces no findings', () => {
  const report = scanAll([{ path: 'src/app.ts', code: 'export const a = 1;\n' }], auditors)
  assert.strictEqual(report.findings.length, 0)
  assert.strictEqual(gateBlocked(report.findings), false)
})

test('eval() (no strategy) escalates, not advisory', async () => {
  const code = 'const x = eval(input);\n'
  const report = scanAll([{ path: 'src/app.ts', code }], auditors)
  assert.ok(report.findings.some((f) => f.ruleId === 'SEC-001'))

  const result = await remediateFindings(
    report.findings,
    {
      bus: { enqueue: async () => ({ taskId: 'x', accepted: true }) },
      now: () => '2026-01-01T00:00:00.000Z',
    },
    { maxRounds: 2 },
  )
  const esc = result.escalations.find((e) => e.reason === 'no-patch-strategy')
  assert.ok(esc, 'SEC-001 escalated with no-patch-strategy')
  assert.ok(result.advisories.every((a) => a.blocking === false))
})

test('patchable finding produces a remediation task', async () => {
  const code = 'const API_TOKEN = "sk-prod-9f3a2b1cdeadbeef42";\n'
  const report = scanAll([{ path: 'src/app.ts', code }], auditors)
  const sec004 = report.findings.find((f) => f.ruleId === 'SEC-004')
  assert.ok(sec004, 'SEC-004 finding present')
  const result = await remediateFindings(
    report.findings,
    { bus: { enqueue: async () => ({ taskId: 'x', accepted: true }) }, now: () => '2026-01-01T00:00:00.000Z' },
    { maxRounds: 2 },
  )
  assert.ok(result.tasks.some((t) => t.ruleId === 'SEC-004' && t.patchStrategy === 'env-var'))
})
