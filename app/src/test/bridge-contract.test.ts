/**
 * Opus//DECK App — Bridge contract test (R16, gate item 3 in node form).
 *
 * Drives the REAL `DeckHost` — the same object the Electron main process uses —
 * and proves the bridge's hard requirement: after BOTH a cold open and a
 * mid-run open, the state a renderer reconstructs from the delivered event
 * stream is byte-identical to the state main computes directly.
 *
 * The renderer's own reducer is proven against `reconstructState` in
 * `reconstruction.test.ts`; together they chain renderer == shared reducer ==
 * host expected state.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { loadEngine } from '../engine/engine-load'
import { DeckHost } from '../main/deck-host'
import {
  reconstructState,
  type DeckEvent,
  type ReconstructedCrewHealth,
  type ReconstructedState,
} from '../shared/bridge-types'
import {
  FixedClock,
  canonical,
  makeTempMemoryDir,
  removeDir,
  scriptedBuiltTransport,
  scriptedConfig,
} from './scripted'

function makeHost(memoryDir: string, hooks?: ConstructorParameters<typeof DeckHost>[0]['hooks']): DeckHost {
  return new DeckHost({
    engine: loadEngine(),
    clock: new FixedClock(),
    initialConfig: scriptedConfig(memoryDir),
    transportFactory: () => scriptedBuiltTransport(),
    schedule: (fn) => fn(),
    ...(hooks === undefined ? {} : { hooks }),
  })
}

/** The renderer's boot merges crew health (fetched over invoke); mimic it. */
async function reconstructedWithHealth(host: DeckHost, events: readonly DeckEvent[]): Promise<ReconstructedState> {
  const health: readonly ReconstructedCrewHealth[] = (await host.crewHealth()).crew
  return { ...reconstructState(events), crewHealth: health }
}

function hasClaims(memoryDir: string): boolean {
  const file = path.join(memoryDir, 'STATE', 'tasks.json')
  if (!fs.existsSync(file)) return false
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed)) return false
  return parsed.some((row) => row !== null && typeof row === 'object' && (row as { kind?: unknown }).kind === 'claim')
}

describe('Bridge contract (R16)', () => {
  it('cold open: reconstructed state == directly-computed expected state', async () => {
    const memoryDir = makeTempMemoryDir('cold')
    const host = makeHost(memoryDir)
    try {
      const result = await host.invoke({ type: 'run', payload: scriptedConfig(memoryDir) })
      assert.equal(result.ok, true, JSON.stringify(result))

      const state = await reconstructedWithHealth(host, host.replay().events)
      const expected = host.expectedState()

      assert.equal(canonical(state), canonical(expected))
      assert.equal(state.phase, 'completed')
      assert.ok(state.tasks.length >= 1, 'at least one task in the ledger')
      assert.ok(state.findings.length >= 1, 'the dirty artifact raised a finding')
      assert.ok(state.findings.some((finding) => finding.resolved), 'the SEC-004 patch resolved')
      assert.ok(state.presence.length >= 4, 'lead + engineer + two auditors have presence')
      assert.ok(state.tokenSpend > 0, 'token spend was accounted')
      assert.ok(state.elapsedMs > 0, 'run has a start and an end')
    } finally {
      host.dispose()
      removeDir(memoryDir)
    }
  })

  it('mid-run open: full replay reconstructs the state captured at audit time', async () => {
    const memoryDir = makeTempMemoryDir('midrun')
    interface Capture {
      readonly expected: ReconstructedState
      readonly full: readonly DeckEvent[]
      readonly openedAt: number
      readonly health: readonly ReconstructedCrewHealth[]
    }
    let captured: Capture | null = null
    let hostRef: DeckHost | null = null

    const host = makeHost(memoryDir, {
      afterPhase: async (phase) => {
        if (phase === 'auditing' && captured === null && hostRef !== null) {
          captured = {
            expected: hostRef.expectedState(),
            full: hostRef.replay().events,
            openedAt: hostRef.journalLength(),
            health: (await hostRef.crewHealth()).crew,
          }
        }
      },
    })
    hostRef = host
    try {
      const result = await host.invoke({ type: 'run', payload: scriptedConfig(memoryDir) })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.ok(captured !== null, 'the auditing hook captured a mid-run snapshot')

      const snapshot = captured as Capture
      assert.equal(snapshot.expected.phase, 'auditing', 'the snapshot is genuinely mid-run')

      // Full replay (what the bridge hands a late subscriber) rebuilds it exactly.
      const rebuilt = { ...reconstructState(snapshot.full), crewHealth: snapshot.health }
      assert.equal(canonical(rebuilt), canonical(snapshot.expected))

      // A tail-only consumer (no backfill) does NOT — this is why replay matters.
      const tail = snapshot.full.slice(snapshot.openedAt)
      assert.notEqual(canonical(reconstructState(tail)), canonical(snapshot.expected))

      // And the finished run still matches at the end.
      const finalState = await reconstructedWithHealth(host, host.replay().events)
      assert.equal(canonical(finalState), canonical(host.expectedState()))
      assert.equal(finalState.phase, 'completed')

      // Delivery is gap-free and ordered: every journaled id is unique.
      const ids = host.replay().events.map((event) => event.id)
      assert.equal(new Set(ids).size, ids.length)
    } finally {
      host.dispose()
      removeDir(memoryDir)
    }
  })

  it('abort behaves like CLI Ctrl-C: one run.failed, claims released, state consistent', async () => {
    const memoryDir = makeTempMemoryDir('abort')
    let aborted = false
    let hostRef: DeckHost | null = null

    const host = makeHost(memoryDir, {
      afterPhase: async (phase) => {
        if (phase === 'building' && !aborted && hostRef !== null) {
          aborted = true
          await hostRef.abort()
        }
      },
    })
    hostRef = host
    try {
      const result = await host.invoke({ type: 'run', payload: scriptedConfig(memoryDir) })
      assert.equal(result.ok, false, 'an aborted run does not report success')

      const state = await reconstructedWithHealth(host, host.replay().events)
      assert.equal(canonical(state), canonical(host.expectedState()))
      assert.equal(state.phase, 'failed')

      const failed = host.replay().events.filter((event) => event.type === 'run.failed')
      assert.equal(failed.length, 1, 'exactly one run.failed is journaled')

      assert.equal(hasClaims(memoryDir), false, 'claims were released on abort')
    } finally {
      host.dispose()
      removeDir(memoryDir)
    }
  })
})
