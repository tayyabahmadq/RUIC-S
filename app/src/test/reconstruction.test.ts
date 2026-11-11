/**
 * Opus//DECK App — Renderer reconstruction test (R16 hard requirement).
 *
 * Loads the REAL compiled renderer script (`dist/renderer/app.js`) into a VM
 * with only `BT` (the shared bridge contract module) injected — exactly what
 * `index.html` does — and proves the renderer's OWN reducer is equivalent to
 * the shared `reconstructState`, including under the duplicate delivery that a
 * "subscribe first, then replay" boot produces.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vm from 'node:vm'
import * as BT from '../shared/bridge-types'
import { canonical } from './scripted'

const APP_JS = path.join(__dirname, '..', 'renderer', 'app.js')

interface RendererInternals {
  reconstructState(events: readonly unknown[]): unknown
  appliedEventCount(): number
}

function loadRenderer(): RendererInternals {
  const code = fs.readFileSync(APP_JS, 'utf8')
  const sandbox: Record<string, unknown> = { BT, console }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'renderer/app.js' })
  const internals = sandbox['__deckInternals__']
  assert.ok(internals !== undefined, 'renderer exposed __deckInternals__')
  return internals as RendererInternals
}

/** A full run's worth of bridge events, exercising every stateful branch. */
function makeEvents(): BT.DeckEvent[] {
  const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()
  let seq = 0
  const ev = <K extends BT.BridgeEventName>(type: K, payload: BT.BridgeEventPayloads[K]): BT.DeckEvent =>
    ({ id: `e${++seq}`, type, payload, at: at(seq) }) as BT.DeckEvent

  return [
    ev('run.started', { runId: 'run-1', brief: 'b', goalState: ['g'] }),
    ev('phase.change', { runId: 'run-1', phase: 'planning' }),
    ev('presence.update', { runId: 'run-1', modelId: 'lead', role: 'lead', status: 'planning' }),
    ev('phase.change', { runId: 'run-1', phase: 'building' }),
    ev('task.claimed', { runId: 'run-1', taskId: 'T-01', file: 'src/app.ts', holder: 'eng-1' }),
    ev('presence.update', { runId: 'run-1', modelId: 'eng-1', role: 'engineer', status: 'working', taskId: 'T-01' }),
    ev('token.use', { runId: 'run-1', inputTokens: 120, outputTokens: 80 }),
    ev('task.completed', { runId: 'run-1', taskId: 'T-01' }),
    ev('phase.change', { runId: 'run-1', phase: 'auditing' }),
    ev('finding.raised', { runId: 'run-1', findingId: 'FND-1', severity: 'critical', path: 'src/app.ts', line: 1, message: 'Hardcoded secret' }),
    ev('finding.raised', { runId: 'run-1', findingId: 'FND-2', severity: 'low', path: 'src/app.ts', line: 2, message: 'Minor' }),
    ev('phase.change', { runId: 'run-1', phase: 'patching' }),
    ev('finding.resolved', { runId: 'run-1', findingId: 'FND-1' }),
    ev('phase.change', { runId: 'run-1', phase: 'reviewing' }),
    ev('review.requested', { runId: 'run-1', fileCount: 1, bundleCount: 1 }),
    ev('review.completed', { runId: 'run-1', requests: 2, findings: 0, dropped: 0, reflections: 0 }),
    ev('phase.change', { runId: 'run-1', phase: 'merging' }),
    ev('run.completed', { runId: 'run-1', checksum: 'abc', fileCount: 1 }),
  ]
}

describe('Renderer reconstruction (R16)', () => {
  it('renderer reducer == shared reducer for a full run', () => {
    const events = makeEvents()
    const renderer = loadRenderer()
    assert.equal(canonical(renderer.reconstructState(events)), canonical(BT.reconstructState(events)))
  })

  it('duplicate delivery (subscribe + replay overlap) does not double-count', () => {
    const events = makeEvents()
    const renderer = loadRenderer()
    const doubled = [...events, ...events]

    const rendererState = renderer.reconstructState(doubled)
    assert.equal(canonical(rendererState), canonical(BT.reconstructState(events)))

    const state = BT.reconstructState(events)
    assert.equal(state.tokenSpend, 200, 'usage counted exactly once')
    assert.equal(state.tasks.length, 1)
    assert.equal(state.findings.length, 2)
    assert.equal(state.findings[0]?.severity, 'critical', 'findings are severity-sorted')
    assert.equal(state.findings[0]?.resolved, true)
    assert.equal(state.phase, 'completed')
  })

  it('a tail-only stream (run.started dropped) still reduces consistently', () => {
    const events = makeEvents()
    const tail = events.filter((event) => event.type !== 'run.started')
    const renderer = loadRenderer()
    // Both reducers agree on the same partial stream, whatever it contains.
    assert.equal(canonical(renderer.reconstructState(tail)), canonical(BT.reconstructState(tail)))
  })
})
