/**
 * GATE 0 — the real deck-run (no scripted transports).
 *
 * Boots the actual DeckHost with the actual transport factory and REAL
 * Ollama models, then runs:
 *   Leg 1: a trivial brief — Laya should route local; contract written,
 *          compaction fired, learning cycled.
 *   Leg 2: a heavy brief — Laya decomposes; leader plans; crew executes;
 *          failures must hand off, not die.
 *
 * Exit code 0 = Gate 0 legs passed; 1 = a leg failed (events printed).
 * Run with: npx electron scripts/gate0.cjs
 */
const path = require('node:path')
const fs = require('node:fs')

const appRoot = path.resolve(__dirname, '..')
const { loadEngine } = require(path.join(appRoot, 'dist', 'engine', 'engine-load.js'))
const { DeckHost } = require(path.join(appRoot, 'dist', 'main', 'deck-host.js'))
const { buildEngineTransport } = require(path.join(appRoot, 'dist', 'main', 'transport-factory.js'))

const LOCAL = (id, model) => ({
  id,
  provider: 'openai-compatible',
  endpoint: 'http://localhost:11434/v1',
  model,
  contextWindowTokens: 32768,
})

function crew(leadModel) {
  return {
    lead: LOCAL('lead', leadModel),
    engineers: [LOCAL('eng-1', 'qwen2.5-coder:1.5b'), LOCAL('eng-2', 'qwen2.5-coder:1.5b')],
    security: [LOCAL('sec-1', 'qwen2.5-coder:1.5b'), LOCAL('sec-2', 'qwen2.5-coder:1.5b')],
  }
}

function makeHost(label) {
  const engine = loadEngine()
  const journalDir = path.join(require('node:os').tmpdir(), `ruic-gate0-${label}`)
  fs.mkdirSync(journalDir, { recursive: true })
  const events = []
  let resolveDone
  const done = new Promise((r) => { resolveDone = r })
  const host = new DeckHost({
    engine,
    journalDir,
    transportFactory: (config, loaded) => buildEngineTransport(config, loaded),
    runIdFactory: () => `gate0-${label}-${String(gateSeq++)}`,
  })
  host.subscribe((batch) => {
    for (const e of batch.events) {
      events.push(e)
      if (e.type === 'presence.update' || e.type === 'token.use' || e.type === 'preview.state') continue
      if (e.type === 'task.failed') console.log(`    ^ task failed — see TRY BOX`)
      const p = e.payload || {}
      const detail = ['run.started','run.failed','task.failed','task.parse_failed','laya.routed','finding.raised','worker.retired'].includes(e.type)
        ? JSON.stringify(p).slice(0, 200)
        : ''
      console.log(`  [${e.type}] ${detail}`)
      if (e.type === 'run.completed' || e.type === 'run.failed') resolveDone({ type: e.type, events })
    }
  })
  return { host, done }
}

let gateSeq = (Date.now() % 100000) * 10

async function runLeg(label, brief, goals, leadModel) {
  console.log(`\n=== GATE 0 LEG: ${label} ===`)
  const { host, done } = makeHost(label)
  const result = await host.invoke({
    type: 'run',
    payload: {
      memoryDir: path.join(require('node:os').tmpdir(), `ruic-gate0-${label}-${gateSeq}-commons`),
      outputDir: path.join(require('node:os').tmpdir(), `ruic-gate0-${label}-output`),
      brief,
      goalState: goals,
      crew: crew(leadModel),
    },
  })
  console.log(`  invoke: ${JSON.stringify(result).slice(0, 140)}`)
  const outcome = await Promise.race([
    done,
    new Promise((r) => setTimeout(() => r({ type: 'timeout' }), 10 * 60 * 1000)),
  ])
  const st = host.expectedState()
  console.log(`  outcome: ${outcome.type} · phase: ${st.phase} · tasks: ${st.tasks.map((t) => `${t.id}:${t.status}`).join(', ')} · findings: ${st.findings.length} · tokens: ${st.tokenSpend}`)
  const routing = st.routingNotes
  for (const note of routing) console.log(`  note: ${note}`)
  return { outcome, st }
}

;(async () => {
  let ok1 = false, ok2 = false
  // LEG 1 — trivial, fully local (lead is also local so the review agent
  // can run keyless; Laya should route this local before planning anyway).
  {
    const { outcome, st } = await runLeg(
      'trivial',
      'write a readme for a calculator app',
      ['readme exists', 'mentions features'],
      'qwen2.5-coder:1.5b',
    )
    ok1 = outcome.type === 'run.completed' && st.phase === 'completed'
    console.log(`  LEG1: ${ok1 ? 'PASS' : 'FAIL'}`)
  }
  // LEG 2 — heavy: Laya decomposes; the 1.5b planner/executors will strain,
  // and any failures must hand off, not kill the run.
  {
    const { outcome, st } = await runLeg(
      'heavy',
      'refactor the auth architecture: redesign the session token schema, migrate the login and logout routes to a keystore-backed signing flow, and update the middleware guards across the whole api',
      ['auth flow documented', 'routes compile'],
      'qwen2.5-coder:1.5b',
    )
    ok2 = outcome.type === 'run.completed' && st.phase === 'completed'
    console.log(`  LEG2: ${ok2 ? 'PASS' : 'FAIL'}`)
  }
  console.log(`\n=== GATE 0: ${ok1 && ok2 ? 'PASS (both legs)' : ok1 ? 'PARTIAL (leg 1 only)' : 'FAIL'} ===`)
  process.exit(ok1 && ok2 ? 0 : 1)
})().catch((err) => {
  console.error('GATE 0 crashed:', err)
  process.exit(1)
})
