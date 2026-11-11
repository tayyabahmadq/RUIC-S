/**
 * Phase 6 smoke test — Leader with stubbed deps.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Leader } from './leader.js'
import { ReviewQueue } from './review.js'
import type { CompletionRequest, CompletionResponse, Commons, Conflict, Conflicts, Crew, Claims, PlanInput, Task, Transport, VerificationResult } from './types.js'

class StubTransport implements Transport {
  calls: CompletionRequest[] = []
  async completion(request: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(request)
    const prompt = request.messages.map((m) => m.content).join('\n')
    if (prompt.includes('CRITERION_VERIFICATION')) {
      const criterion = prompt.match(/Criterion:\s*(.+)/)?.[1] ?? 'unspecified'
      return { text: JSON.stringify({ satisfied: !criterion.toLowerCase().includes('fail'), evidence: `src/app.ts:1 — ${criterion}` }), modelId: request.modelId }
    }
    const tasks = [{ id: 'T-01', path: 'src/app.ts', description: 'Implement the app', acceptance: ['compiles cleanly'] }]
    return { text: JSON.stringify(tasks), modelId: request.modelId }
  }
}

class StubCommons implements Commons {
  private store = new Map<string, unknown>()
  private files = new Map<string, string>()
  async read<T>(key: string): Promise<T | undefined> { return this.store.get(key) as T | undefined }
  async write(key: string, value: unknown): Promise<void> { this.store.set(key, value) }
  async append(key: string, entry: unknown): Promise<void> { const cur = (await this.read<unknown[]>(key)) ?? []; cur.push(entry); this.store.set(key, cur) }
  async listWorkspace(): Promise<any[]> { return [...this.files.keys()].map((p) => ({ path: p, size: 0, mtime: new Date().toISOString() })) }
  async readWorkspace(p: string): Promise<string> { return this.files.get(p) ?? '' }
  async writeWorkspace(p: string, c: string): Promise<void> { this.files.set(p, c) }
  addWorkspace(p: string, c: string): void { this.files.set(p, c) }
}

class StubClaims implements Claims {
  private claims = new Map<string, { taskId: string; path: string; engineerId: string }>()
  async holdersOf(path: string): Promise<string[]> { return [...this.claims.values()].filter((c) => c.path === path).map((c) => c.engineerId) }
  async claim(taskId: string, path: string, engineerId: string): Promise<void> { this.claims.set(taskId, { taskId, path, engineerId }) }
  async release(taskId: string): Promise<void> { this.claims.delete(taskId) }
  async listClaims(): Promise<any[]> { return [...this.claims.values()] }
}

class StubConflicts implements Conflicts {
  private conflicts = new Map<string, Conflict>()
  private n = 0
  async record(path: string, taskId: string, heldBy: string[]): Promise<string> {
    const id = `C-${String(++this.n).padStart(2, '0')}`
    const c: Conflict = { id, path, taskId, heldBy: [...heldBy] }
    this.conflicts.set(id, c)
    return id
  }
  async list(): Promise<Conflict[]> { return [...this.conflicts.values()] }
  async resolve(id: string, resolution: 'rerouted' | 'split', detail?: string): Promise<void> {
    const c = this.conflicts.get(id)
    if (c) { c.resolution = resolution; c.resolvedAt = new Date().toISOString(); c.detail = detail }
  }
}

class StubBus {
  events: Array<{ type: string; payload: unknown }> = []
  private handlers = new Map<string, Array<(p: unknown) => void>>()
  async emit(type: string, payload: unknown): Promise<string> { this.events.push({ type, payload }); for (const h of this.handlers.get(type) ?? []) h(payload); return 'evt-1' }
  async subscribe(type: string, handler: (p: unknown) => void): Promise<void> { const s = this.handlers.get(type) ?? []; s.push(handler); this.handlers.set(type, s) }
  async published(): Promise<any[]> { return [...this.events] }
}

function crew(): Crew { return { lead: 'lead', engineers: ['eng-1'] } }

test('plan -> route -> verify -> signOff end-to-end', async () => {
  const transport = new StubTransport()
  const commons = new StubCommons()
  commons.addWorkspace('src/app.ts', 'export const app = 1;\n')
  const claims = new StubClaims()
  const conflicts = new StubConflicts()
  const bus = new StubBus()
  const leader = new Leader({ transport, commons, claims, conflicts, bus })

  const input: PlanInput = { brief: 'build an app', goalState: 'app builds', crew: crew() }
  const tasks = await leader.plan(input)
  assert.strictEqual(tasks.length, 1)
  assert.strictEqual(tasks[0].path, 'src/app.ts')

  await leader.route()
  const pending = await leader.reviewQueue.listPending()
  assert.strictEqual(pending.length, 0)

  const results = await leader.verify(['app builds'])
  assert.strictEqual(results.length, 1)
  assert.strictEqual(results[0].satisfied, true)

  const signOff = await leader.signOff()
  assert.strictEqual(signOff.fileCount, 1)
  assert.strictEqual(signOff.checksum.length, 64)

  const published = await bus.published()
  assert.ok(published.some((e) => e.type === 'run.completed'), 'run.completed emitted')
})

test('route never assigns a claimed path; records a conflict', async () => {
  const transport = new StubTransport()
  const commons = new StubCommons()
  const claims = new StubClaims()
  await claims.claim('T-01', 'src/app.ts', 'eng-1')
  const conflicts = new StubConflicts()
  const bus = new StubBus()
  const leader = new Leader({ transport, commons, claims, conflicts, bus })
  await leader.plan({ brief: 'b', goalState: 'g', crew: crew() })
  await leader.route()
  const conflictsList = await conflicts.list()
  assert.strictEqual(conflictsList.length, 1, 'a conflict recorded for claimed path')
})

test('ReviewQueue veto produces a routed follow-up task', async () => {
  const transport = new StubTransport()
  const commons = new StubCommons()
  const claims = new StubClaims()
  const conflicts = new StubConflicts()
  const bus = new StubBus()
  const leader = new Leader({ transport, commons, claims, conflicts, bus })
  await leader.plan({ brief: 'b', goalState: 'g', crew: crew() })
  const decision = await leader.reviewQueue.decide({ workerId: 'eng-1', touched: ['a.ts', 'b.ts'], rationale: 'multi-file' })
  assert.strictEqual(decision.status, 'pending')
  const vetoed = await leader.reviewQueue.veto(decision.id, 'needs rework')
  assert.strictEqual(vetoed.status, 'vetoed')
  assert.ok(vetoed.followUpTaskId, 'veto produced follow-up task')
  assert.ok(vetoed.followUpTaskId!.startsWith('T-'), 'follow-up task id is a real task id')
})

test('plan prompt carries the reasoning protocol in the user message (persona-safe)', async () => {
  const transport = new StubTransport()
  const leader = new Leader({ transport, commons: new StubCommons(), claims: new StubClaims(), conflicts: new StubConflicts(), bus: new StubBus() })
  await leader.plan({ brief: 'build an app', goalState: 'app builds', crew: crew() })
  const call = transport.calls.find((c) => c.messages.some((m) => m.content.includes('TASK_DECOMPOSITION')))
  assert.ok(call, 'a plan call went out')
  const userMsg = call!.messages.find((m) => m.content.includes('TASK_DECOMPOSITION'))!
  assert.ok(userMsg.content.includes('REASONING PROTOCOL'), 'deliberation protocol present')
  assert.ok(userMsg.content.includes('recommendation, not a survey'), 'commit-to-one guidance present')
  assert.ok(userMsg.content.includes('file:line'), 'verifiable acceptance guidance present')
  // The protocol rides the user message so it survives a persona system-prompt
  // override; the system message keeps the JSON-only output contract verbatim.
  const systemMsg = call!.messages.find((m) => m.role === 'system')!
  assert.ok(systemMsg.content.includes('ONLY a JSON array'), 'output contract unchanged')
  assert.ok(!systemMsg.content.includes('REASONING PROTOCOL'), 'protocol never rides the system prompt (persona-safe channel)')
})

test('verify prompt carries evidence discipline; Criterion line stays first for parsing', async () => {
  const transport = new StubTransport()
  const commons = new StubCommons()
  commons.addWorkspace('src/app.ts', 'export const app = 1;\n')
  const leader = new Leader({ transport, commons, claims: new StubClaims(), conflicts: new StubConflicts(), bus: new StubBus() })
  await leader.plan({ brief: 'build an app', goalState: 'app builds', crew: crew() })
  await leader.verify(['app builds'])
  const call = transport.calls.find((c) => c.messages.some((m) => m.content.includes('CRITERION_VERIFICATION')))
  assert.ok(call, 'a verify call went out')
  const userMsg = call!.messages.find((m) => m.content.includes('CRITERION_VERIFICATION'))!
  assert.ok(userMsg.content.includes('VERIFICATION PROTOCOL'), 'protocol present')
  assert.ok(userMsg.content.includes('never guess a pass'), 'faithful-outcome rule present')
  assert.ok(userMsg.content.includes('A claim without a citation is satisfied: false'), 'factuality rule present')
  // The criterion must remain the FIRST Criterion: line so the existing
  // Criterion-regex consumers (tests, future parsers) keep working.
  const secondLine = userMsg.content.split('\n')[1] ?? ''
  assert.ok(secondLine.startsWith('Criterion: app builds'), 'Criterion line precedes the protocol')
  // The protocol rides the user message only — never the system prompt.
  const systemMsg = call!.messages.find((m) => m.role === 'system')!
  assert.ok(!systemMsg.content.includes('VERIFICATION PROTOCOL'), 'protocol never rides the system prompt (persona-safe channel)')
})
