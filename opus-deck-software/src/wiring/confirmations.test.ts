/**
 * Phase 4 (integration roadmap): single-use confirmation tokens.
 *
 * Covers the four distinct outcomes the audit trail must be able to tell apart
 * (round-trip / expired / replayed / wrong-scope), the per-process boundary
 * (R7), the veto -> confirmation -> follow-up-task pairing through the real
 * composition root, and the multi-file remediation batch gate.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'node:path'
import { initOpusDeck } from '../config/bootstrap.js'
import { wireOpusDeck } from './index.js'
import {
  createConfirmant, createRemediationBatchGate, ConfirmationError,
  DEFAULT_CONFIRMATION_TTL_MS,
} from './confirmations.js'
import { REVIEW_VETO_ACTION, REVIEW_VETO_SCOPE } from '../leader/index.js'
import type { Confirmant } from './confirmations.js'
import type { RemediationTask } from '../audit/types.js'

// --- harness ---------------------------------------------------------------

interface Recorded { type: string; payload: any }

function harness(startIso = '2026-10-17T00:00:00.000Z', opts?: { secret?: string }): {
  confirmant: Confirmant
  events: Recorded[]
  setClock: (iso: string) => void
  of: (type: string) => Recorded[]
} {
  const events: Recorded[] = []
  let clock = Date.parse(startIso)
  const confirmant = createConfirmant({
    sink: { emit: (type, payload) => { events.push({ type, payload: payload as any }) } },
    now: () => clock,
    ...(opts?.secret === undefined ? {} : { secret: opts.secret }),
  })
  return {
    confirmant,
    events,
    setClock: (iso: string) => { clock = Date.parse(iso) },
    of: (type: string) => events.filter((e) => e.type === type),
  }
}

function expectRejection(confirmant: Confirmant, token: string, scope: string): ConfirmationError {
  try {
    confirmant.consume(token, scope)
  } catch (err) {
    assert.ok(err instanceof ConfirmationError, `expected ConfirmationError, got ${String(err)}`)
    return err
  }
  throw new Error('E_EXPECTED_REJECTION: consume() succeeded but a rejection was expected')
}

// --- 1. round trip ---------------------------------------------------------

test('token round trip: issue -> consume -> the action proceeds exactly once', () => {
  const { confirmant, events } = harness()
  const issued = confirmant.issue('export.bulk-delete', { action: 'bulk-delete', subject: 'run-42' })

  assert.match(issued.token, /^CFM1\./, 'token is a CFM1 token')
  assert.ok(issued.nonce.length >= 16, 'nonce is present')
  assert.ok(issued.confirmationId.startsWith('CFM-'), 'confirmation id is stable')
  assert.strictEqual(
    issued.expiresAtMs - Date.parse(issued.issuedAt),
    DEFAULT_CONFIRMATION_TTL_MS,
    'default expiry is 15 minutes (R7)',
  )
  assert.strictEqual(confirmant.ledger().length, 1)
  assert.strictEqual(confirmant.ledger()[0].status, 'issued')

  const receipt = confirmant.consume(issued.token, 'export.bulk-delete')
  assert.strictEqual(receipt.confirmationId, issued.confirmationId)
  assert.strictEqual(receipt.scope, issued.scope)
  assert.strictEqual(receipt.nonce, issued.nonce)
  assert.strictEqual(receipt.subject, 'run-42')
  assert.ok(Date.parse(receipt.consumedAt) >= Date.parse(issued.issuedAt))

  const confirmed = confirmant.confirmedActions()
  assert.strictEqual(confirmed.length, 1, 'exactly one confirmed action')
  assert.strictEqual(confirmed[0].confirmationId, issued.confirmationId)

  const emitted = events.filter((e) => e.type === 'action.confirmed')
  assert.strictEqual(emitted.length, 1, 'action.confirmed emitted once')
  assert.strictEqual(emitted[0].payload.confirmationId, issued.confirmationId)
  assert.strictEqual(emitted[0].payload.scope, 'export.bulk-delete')
  assert.strictEqual(events.filter((e) => e.type === 'action.rejected').length, 0, 'no rejections on the happy path')
})

// --- 2. expiry -------------------------------------------------------------

test('expired token is rejected with its own code (CONFIRMATION_EXPIRED)', () => {
  const { confirmant, events, setClock } = harness()
  const issued = confirmant.issue('review.veto:follow-up', { ttlMs: 60_000 })
  setClock('2026-10-17T00:02:00.000Z') // 2 minutes later, TTL was 1

  const err = expectRejection(confirmant, issued.token, 'review.veto:follow-up')
  assert.strictEqual(err.code, 'CONFIRMATION_EXPIRED')
  assert.strictEqual(err.reason, 'expired')
  assert.strictEqual(err.detail.tokenScope, 'review.veto:follow-up')

  const rejected = events.filter((e) => e.type === 'action.rejected')
  assert.strictEqual(rejected.length, 1)
  assert.strictEqual(rejected[0].payload.reason, 'expired')
  assert.strictEqual(rejected[0].payload.code, 'CONFIRMATION_EXPIRED')

  assert.strictEqual(confirmant.confirmedActions().length, 0, 'nothing was confirmed')
  const record = confirmant.byId(issued.confirmationId)
  assert.ok(record !== undefined && record.status === 'rejected', 'ledger records the refusal')
  assert.strictEqual(record.consumedAt, undefined, 'an expired token is never burned as consumed')
})

// --- 3. replay -------------------------------------------------------------

test('replay is rejected with its own code (CONFIRMATION_REPLAYED)', () => {
  const { confirmant, events } = harness()
  const issued = confirmant.issue('remediation.batch:deadbeefdeadbeef', { action: 'remediate-batch' })

  confirmant.consume(issued.token, 'remediation.batch:deadbeefdeadbeef') // first use is allowed
  const err = expectRejection(confirmant, issued.token, 'remediation.batch:deadbeefdeadbeef')

  assert.strictEqual(err.code, 'CONFIRMATION_REPLAYED')
  assert.strictEqual(err.reason, 'replayed')
  assert.ok(err.detail.consumedAt !== undefined, 'the burn time is in the audit detail')

  const rejected = events.filter((e) => e.type === 'action.rejected')
  assert.strictEqual(rejected.length, 1)
  assert.strictEqual(rejected[0].payload.reason, 'replayed')
  assert.strictEqual(rejected[0].payload.code, 'CONFIRMATION_REPLAYED')

  assert.strictEqual(confirmant.confirmedActions().length, 1, 'still exactly one confirmed action')
  assert.strictEqual(events.filter((e) => e.type === 'action.confirmed').length, 1, 'no second confirmation')
})

// --- 4. wrong scope --------------------------------------------------------

test('wrong scope is rejected with its own code (CONFIRMATION_WRONG_SCOPE)', () => {
  const { confirmant, events } = harness()
  const issued = confirmant.issue('remediation.batch:aaaabbbbccccdddd', { action: 'remediate-batch' })

  const err = expectRejection(confirmant, issued.token, 'export.bulk-delete')

  assert.strictEqual(err.code, 'CONFIRMATION_WRONG_SCOPE')
  assert.strictEqual(err.reason, 'wrong-scope')
  assert.strictEqual(err.detail.requestedScope, 'export.bulk-delete')
  assert.strictEqual(err.detail.tokenScope, 'remediation.batch:aaaabbbbccccdddd')

  const rejected = events.filter((e) => e.type === 'action.rejected')
  assert.strictEqual(rejected.length, 1)
  assert.strictEqual(rejected[0].payload.reason, 'wrong-scope')
  assert.strictEqual(rejected[0].payload.code, 'CONFIRMATION_WRONG_SCOPE')
  assert.strictEqual(rejected[0].payload.requestedScope, 'export.bulk-delete')
  assert.strictEqual(rejected[0].payload.tokenScope, 'remediation.batch:aaaabbbbccccdddd')

  // A scope mismatch must NOT burn the token: the right action can still use it.
  const receipt = confirmant.consume(issued.token, 'remediation.batch:aaaabbbbccccdddd')
  assert.strictEqual(receipt.confirmationId, issued.confirmationId)
  assert.strictEqual(confirmant.confirmedActions().length, 1)
})

test('the three required failure modes carry three distinct codes', () => {
  const codes = new Set<string>()
  const reasons = new Set<string>()

  {
    const { confirmant, setClock } = harness()
    const issued = confirmant.issue('scope.a', { ttlMs: 1 })
    setClock('2026-10-17T01:00:00.000Z')
    const err = expectRejection(confirmant, issued.token, 'scope.a')
    codes.add(err.code); reasons.add(err.reason)
  }
  {
    const { confirmant } = harness()
    const issued = confirmant.issue('scope.a')
    confirmant.consume(issued.token, 'scope.a')
    const err = expectRejection(confirmant, issued.token, 'scope.a')
    codes.add(err.code); reasons.add(err.reason)
  }
  {
    const { confirmant } = harness()
    const issued = confirmant.issue('scope.a')
    const err = expectRejection(confirmant, issued.token, 'scope.b')
    codes.add(err.code); reasons.add(err.reason)
  }

  assert.deepEqual([...codes].sort(), [
    'CONFIRMATION_EXPIRED', 'CONFIRMATION_REPLAYED', 'CONFIRMATION_WRONG_SCOPE',
  ], 'expired / replayed / wrong-scope are three distinct codes — never a generic invalid-token')
  assert.deepEqual([...reasons].sort(), ['expired', 'replayed', 'wrong-scope'])
})

// --- 5. per-process boundary (R7) ------------------------------------------

test('R7: tokens are per-process — a foreign key is malformed, not wrong-scope', () => {
  const mine = harness('2026-10-17T00:00:00.000Z', { secret: 'process-a-secret' }).confirmant
  const theirs = harness('2026-10-17T00:00:00.000Z', { secret: 'process-b-secret' }).confirmant

  const issuedByA = mine.issue('review.veto:follow-up')
  const err = expectRejection(theirs, issuedByA.token, 'review.veto:follow-up')

  assert.strictEqual(err.code, 'CONFIRMATION_MALFORMED')
  assert.strictEqual(err.reason, 'malformed')
  assert.strictEqual(err.detail.reason, 'foreign-key')
  assert.notEqual(mine.keyId, theirs.keyId, 'each process has its own signing key')

  const tampered = `${issuedByA.token.slice(0, -4)}AAAA`
  const tamperErr = expectRejection(mine, tampered, 'review.veto:follow-up')
  assert.strictEqual(tamperErr.code, 'CONFIRMATION_MALFORMED', 'a tampered signature never verifies')
  assert.strictEqual(expectRejection(mine, 'not-a-token', 'x').code, 'CONFIRMATION_MALFORMED', 'bad shape is malformed')
})

// --- 6. veto pairing (end-to-end through the composition root) -------------

function crewModel(id: string, model: string) {
  return { id, provider: 'custom' as const, model, contextWindowTokens: 4096 }
}

function mockTransport() {
  return {
    async *complete(): AsyncIterable<{ type: 'text'; text: string }> {
      const req = arguments[0] as { messages: { content: string }[] }
      const prompt = req.messages.map((m) => m.content).join('\n')
      if (prompt.includes('TASK_DECOMPOSITION')) {
        yield { type: 'text', text: JSON.stringify([{ id: 'T-01', path: 'src/app.ts', description: 'do it', acceptance: ['ok'] }]) }
      } else {
        yield { type: 'text', text: JSON.stringify({ intent: 'write', path: 'src/app.ts', added: ['export const app = 1;'], atLine: 1, removedLineCount: 0 }) }
      }
    },
  }
}

test('veto pairing: the follow-up task carries a reference that resolves to exactly one confirmed action', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-confirm-veto-'))
  try {
    const memoryDir = path.join(root, 'COMMONS')
    const runtime = initOpusDeck({
      memoryDir, outputDir: path.join(root, 'OUTPUT'), brief: 'build an app', goalState: ['app builds'],
      crew: {
        lead: crewModel('lead', 'lead-model'),
        engineers: [crewModel('eng-1', 'eng-model')],
        security: [crewModel('sec-1', 'sec-model'), crewModel('sec-2', 'sec-model-2')],
      },
    })
    const wired = await wireOpusDeck(runtime, {
      transport: mockTransport() as any, leadModelId: 'lead', auditorModelIds: ['sec-1', 'sec-2'],
    })
    await wired.leader.plan({ brief: 'build an app', goalState: 'app builds', crew: { lead: 'lead', engineers: ['eng-1'] } })
    await wired.leader.route()

    const pending = await wired.reviewQueue.decide({
      workerId: 'sec-1', touched: ['src/a.ts', 'src/b.ts'], rationale: 'multi-file finding',
    })
    assert.strictEqual(pending.status, 'pending')

    // v1 policy: auto-issue-and-record. The caller supplies NO token — the veto
    // stays unattended (regression: no manual intervention by default).
    const vetoed = await wired.reviewQueue.veto(pending.id, 'eval requires manual rewrite')

    assert.strictEqual(vetoed.status, 'vetoed')
    assert.ok(vetoed.followUpTaskId!.startsWith('T-'), 'follow-up task id is a real task id')
    const ref = vetoed.confirmationRef
    assert.ok(ref !== undefined && ref.startsWith('CFM-'), 'the decision records a confirmation reference')

    // the task record itself carries the reference
    const stored = JSON.parse(fs.readFileSync(path.join(memoryDir, 'STATE', 'leader-06', 'tasks.json'), 'utf8')) as any[]
    const followUp = stored.find((t) => t.id === vetoed.followUpTaskId)
    assert.ok(followUp !== undefined, 'follow-up task is persisted in leader:tasks')
    assert.strictEqual(followUp.confirmationRef, ref, 'the task record carries the confirmation reference')

    // the reference resolves to EXACTLY one confirmed action
    const resolved = wired.confirmations.confirmedActions().filter((a) => a.confirmationId === ref)
    assert.strictEqual(resolved.length, 1, 'exactly one confirmed action backs this task')
    assert.strictEqual(resolved[0].scope, REVIEW_VETO_SCOPE)
    assert.strictEqual(resolved[0].action, REVIEW_VETO_ACTION)
    assert.strictEqual(resolved[0].subject, pending.id, 'the confirmed action names the decision')
    assert.ok(wired.confirmations.byId(ref) !== undefined, 'the reference resolves in the ledger')

    const confirmedEvents = wired.hub.published().filter((e) => e.type === 'action.confirmed')
    assert.strictEqual(confirmedEvents.length, 1, 'one action.confirmed on the shared hub')
    assert.strictEqual((confirmedEvents[0].payload as any).confirmationId, ref)

    // a second veto is a second action: a second reference, never a shared one
    const second = await wired.reviewQueue.decide({ workerId: 'sec-2', touched: ['src/c.ts', 'src/d.ts'], rationale: 'other' })
    const vetoed2 = await wired.reviewQueue.veto(second.id, 'second veto')
    assert.notEqual(vetoed2.confirmationRef, ref, 'each veto confirms exactly one action')
    assert.strictEqual(wired.confirmations.confirmedActions().length, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// --- 7. multi-file remediation batches --------------------------------------

const DIRTY_A = 'const API_TOKEN = "sk-prod-9f3a2b1cdeadbeef42";\n'
const DIRTY_B = 'const CLIENT_SECRET = "sk-prod-00112233445566aa";\n'

async function batchHarness(autoIssue: boolean): Promise<{
  wired: Awaited<ReturnType<typeof wireOpusDeck>>
  memoryDir: string
  root: string
  executed: RemediationTask[]
  findings: readonly any[]
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-confirm-batch-'))
  const memoryDir = path.join(root, 'COMMONS')
  const runtime = initOpusDeck({
    memoryDir, outputDir: path.join(root, 'OUTPUT'), brief: 'build an app', goalState: ['app builds'],
    crew: {
      lead: crewModel('lead', 'lead-model'),
      engineers: [crewModel('eng-1', 'eng-model')],
      security: [crewModel('sec-1', 'sec-model'), crewModel('sec-2', 'sec-model-2')],
    },
  })
  const wired = await wireOpusDeck(runtime, {
    transport: mockTransport() as any, leadModelId: 'lead', auditorModelIds: ['sec-1', 'sec-2'],
    confirmationAutoIssue: autoIssue,
  })
  for (const [rel, code] of [['src/a.ts', DIRTY_A], ['src/b.ts', DIRTY_B]] as const) {
    const full = path.join(memoryDir, 'WORKSPACE', ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, code, 'utf8')
  }
  const executed: RemediationTask[] = []
  const findings = wired.scan(
    [{ path: 'src/a.ts', code: DIRTY_A }, { path: 'src/b.ts', code: DIRTY_B }],
    ['sec-1', 'sec-2'],
  ).findings
  return { wired, memoryDir, root, executed, findings }
}

test('multi-file remediation batch: an unconfirmed batch executes nothing and escalates', async () => {
  const { wired, root, executed, findings } = await batchHarness(false)
  try {
    assert.ok(wired.remediationBatchScope(findings) !== null, 'two files => a confirmation scope exists')

    const result = await wired.remediateFindings(
      findings,
      {
        bus: {
          enqueue: async (t: RemediationTask) => { executed.push(t); return { taskId: t.id, accepted: true } },
          awaitSettlement: async (r: { taskId: string }) => ({ taskId: r.taskId, ok: true }),
        },
        artifacts: wired.f08.artifactStore,
        escalations: wired.f08.escalationQueue,
      },
      { maxRounds: 2 },
    )

    assert.strictEqual(executed.length, 0, 'nothing was enqueued: the batch executes only against a consumed confirmation')
    assert.strictEqual(result.tasks.length, 0)
    const unconfirmed = result.escalations.filter((e) => e.reason === 'batch-unconfirmed')
    assert.ok(unconfirmed.length >= 2, 'each finding escalates with batch-unconfirmed')
    assert.match(unconfirmed[0].detail, /E_BATCH_UNCONFIRMED/, 'the escalation carries the confirmation failure')
    assert.strictEqual(wired.confirmations.confirmedActions().length, 0, 'nothing was confirmed')
    assert.strictEqual(result.batchAuthorization, undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('multi-file remediation batch: a confirmed batch runs once, and the token cannot be reused', async () => {
  const { wired, root, executed, findings } = await batchHarness(false)
  try {
    const scope = wired.remediationBatchScope(findings)!
    const issued = wired.confirmations.issue(scope, { action: 'remediate-batch', subject: 'caller-driven' })
    const deps = {
      bus: {
        enqueue: async (t: RemediationTask) => { executed.push(t); return { taskId: t.id, accepted: true } },
        awaitSettlement: async (r: { taskId: string }) => ({ taskId: r.taskId, ok: true }),
      },
      artifacts: wired.f08.artifactStore,
      escalations: wired.f08.escalationQueue,
    }

    const first = await wired.remediateFindings(findings, deps, { maxRounds: 1, confirmationToken: issued.token })
    assert.ok(executed.length > 0, 'the confirmed batch executes')
    assert.strictEqual(first.batchAuthorization?.autoIssued, false, 'the caller token was used, not an auto-issue')
    assert.strictEqual(first.batchAuthorization?.scope, scope)
    assert.strictEqual(wired.confirmations.byId(first.batchAuthorization!.confirmationId)?.status, 'confirmed')

    // second attempt with the same (now burned) token
    const before = executed.length
    const second = await wired.remediateFindings(findings, deps, { maxRounds: 1, confirmationToken: issued.token })
    assert.strictEqual(executed.length, before, 'a replayed token executes nothing')
    const replayed = second.escalations.filter((e) => e.reason === 'batch-unconfirmed')
    assert.ok(replayed.length >= 1)
    assert.match(replayed[0].detail, /CONFIRMATION_REPLAYED/, 'the audit trail says replay, not "invalid token"')
    assert.strictEqual(wired.confirmations.confirmedActions().length, 1, 'one confirmation, two attempts')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('regression: a single-file batch needs no confirmation (the dirty smoke path is untouched)', async () => {
  const { wired, root, executed, findings } = await batchHarness(false)
  try {
    const single = findings.filter((f) => f.path === 'src/a.ts')
    assert.strictEqual(wired.remediationBatchScope(single), null, 'one file => no confirmation required')

    const result = await wired.remediateFindings(
      single,
      {
        bus: {
          enqueue: async (t: RemediationTask) => { executed.push(t); return { taskId: t.id, accepted: true } },
          awaitSettlement: async (r: { taskId: string }) => ({ taskId: r.taskId, ok: true }),
        },
        artifacts: wired.f08.artifactStore,
        escalations: wired.f08.escalationQueue,
      },
      { maxRounds: 2 },
    )
    assert.ok(result.tasks.length > 0, 'single-file remediation still runs unattended')
    assert.strictEqual(result.batch, undefined, 'no batch confirmation was involved')
    assert.strictEqual(wired.confirmations.confirmedActions().length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('gate policy: auto-issue-and-record keeps shipped batch flows unattended', () => {
  const { confirmant, events } = harness()
  const gate = createRemediationBatchGate(confirmant)
  const request = { paths: ['src/a.ts', 'src/b.ts'], findingIds: ['F1', 'F2'] }
  const scope = gate.scopeFor(request)

  const auth = gate.authorize(request)
  assert.strictEqual(auth.scope, scope)
  assert.strictEqual(auth.autoIssued, true)
  assert.strictEqual(confirmant.confirmedActions().length, 1, 'the batch was confirmed and recorded')
  assert.strictEqual(events.filter((e) => e.type === 'action.confirmed').length, 1)

  const strict = createRemediationBatchGate(confirmant, { autoIssue: false })
  assert.throws(() => strict.authorize(request), /E_BATCH_UNCONFIRMED/, 'strict mode demands a caller token')

  const otherScope = { paths: ['src/c.ts', 'src/d.ts'], findingIds: ['F3', 'F4'] }
  const preissued = createRemediationBatchGate(confirmant, { token: confirmant.issue(gate.scopeFor(otherScope)).token })
  assert.throws(() => preissued.authorize(request), (err: any) => err.code === 'CONFIRMATION_WRONG_SCOPE')
})
