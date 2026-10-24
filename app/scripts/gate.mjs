// Opus//DECK App — phase gate.
//
// Runs the six gate items in order, QUOTING the raw output of each, and exits
// non-zero if any item fails:
//
//   1. ENGINE DIFF ZERO  — every engine file hash matches the frozen baseline
//                          manifest (same file set, same contents, same
//                          aggregate SHA-256). Nothing under the engine was
//                          touched all phase.
//   2. ENGINE SUITE      — the frozen engine still passes 126/126 (run WITHOUT
//                          rebuilding: node --test over its existing dist/).
//   3. APP BUILD         — tsc strict over main + preload + renderer + shared.
//   4. APP NODE TESTS    — bridge-contract / reconstruction / keys.
//   5. BRIDGE TYPE PROBE — tsc rejects a wrong payload shape in BOTH directions.
//   6. ELECTRON CONTRACT — REAL Electron: renderer-reconstructed state equals
//                          the host's directly-computed state (cold + mid-run).
//
// The engine workspace is read-only here; no step writes to it.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const engineRoot = path.resolve(root, '..', 'opus-deck-software')
const baselinePath = path.join(root, 'scripts', 'engine-baseline.txt')

// The expected aggregate is the phase-C1 freeze, REGENERATED after each
// sanctioned engine micro-phase (E1 transport realism + findings merge; E2
// remediation persistence + leader adapter termination; E3 compactor adapter
// termination; E3-repair f11 review-agent termination) — see app/DECISIONS.log
// [E1-RF], [E2-B3], [E3-B2] and [E3R-B1].
const EXPECTED_AGGREGATE = '46B641F2CBAB3A47B7A89C0ABC458978A462E600F7CF3FE718B622B7614E173B'
const EXPECTED_ENGINE_TESTS = 136
const EXPECTED_APP_TESTS = 10

const failures = []
let index = 0

function heading(title) {
  index += 1
  console.log(`\n${'='.repeat(78)}`)
  console.log(`GATE ${index}: ${title}`)
  console.log('='.repeat(78))
}

function ok(label) {
  console.log(`[PASS] ${label}`)
}

function fail(label) {
  failures.push(label)
  console.log(`[FAIL] ${label}`)
}

function sha256Upper(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase()
}

/** Every engine file (relative, leading `\`, backslash separators), excluding
 *  `node_modules` and the build output `dist`. */
function walkEngineFiles() {
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = path.join(dir, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}\\${entry.name}`
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile()) out.push(`\\${rel}`)
    }
  }
  walk(engineRoot, '')
  return out
}

/* ------------------------------------------------------------------ *
 * GATE 1 — engine diff zero
 * ------------------------------------------------------------------ */

function gateEngineDiff() {
  heading('ENGINE DIFF ZERO (frozen baseline manifest)')

  const raw = readFileSync(baselinePath)
  let baseline = raw.toString('utf8')
  if (baseline.charCodeAt(0) === 0xfeff) baseline = baseline.slice(1)
  // Normalise line endings, drop the trailing newline: the canonical text the
  // aggregate is taken over.
  const lines = baseline.split(/\r?\n/).filter((line) => line.length > 0)
  const canonical = lines.join('\n')

  const entries = lines.map((line) => {
    const split = line.lastIndexOf(' ')
    return { rel: line.slice(0, split), hash: line.slice(split + 1) }
  })

  const manifests = new Set(entries.map((e) => e.rel))
  const onDisk = walkEngineFiles()
  const diskSet = new Set(onDisk)

  const missing = [...manifests].filter((rel) => !diskSet.has(rel))
  const extra = onDisk.filter((rel) => !manifests.has(rel))

  const mismatched = []
  const regenerated = entries.map(({ rel, hash }) => {
    const diskPath = path.join(engineRoot, ...rel.replace(/^\\/, '').split('\\'))
    let actual = ''
    try {
      actual = sha256Upper(readFileSync(diskPath, 'utf8'))
    } catch {
      actual = '<unreadable>'
    }
    if (actual !== hash) mismatched.push({ rel, expected: hash, actual })
    return `${rel} ${actual}`
  })

  const regeneratedText = regenerated.join('\n')
  const actualAggregate = sha256Upper(regeneratedText)
  const baselineAggregate = sha256Upper(canonical)

  console.log(`engine root        : ${engineRoot}`)
  console.log(`baseline manifest  : ${baselinePath}`)
  console.log(`files in manifest  : ${entries.length}`)
  console.log(`files on disk      : ${onDisk.length}`)
  console.log(`baseline aggregate : ${baselineAggregate}`)
  console.log(`disk aggregate     : ${actualAggregate}`)
  console.log(`expected aggregate : ${EXPECTED_AGGREGATE}`)

  if (baselineAggregate !== EXPECTED_AGGREGATE) {
    fail(`baseline manifest no longer aggregates to ${EXPECTED_AGGREGATE}`)
  }
  if (missing.length > 0) {
    console.log(`missing files      : ${missing.join(', ')}`)
    fail(`${missing.length} engine file(s) present in the baseline are missing on disk`)
  }
  if (extra.length > 0) {
    console.log(`extra files        : ${extra.join(', ')}`)
    fail(`${extra.length} file(s) exist under the engine that are not in the baseline`)
  }
  if (mismatched.length > 0) {
    for (const m of mismatched) console.log(`  ${m.rel}: expected ${m.expected} got ${m.actual}`)
    fail(`${mismatched.length} engine file(s) have changed content`)
  }
  if (regeneratedText !== canonical) {
    fail('regenerated manifest text differs from the baseline text')
  }
  if (
    missing.length === 0 &&
    extra.length === 0 &&
    mismatched.length === 0 &&
    actualAggregate === EXPECTED_AGGREGATE &&
    regeneratedText === canonical
  ) {
    ok(`${entries.length} engine files byte-identical; aggregate ${actualAggregate}`)
  }
}

/* ------------------------------------------------------------------ *
 * Test-count helpers
 * ------------------------------------------------------------------ */

function parseTapCounts(output) {
  const counts = {}
  const re = /^# (tests|pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$/gm
  let match
  while ((match = re.exec(output)) !== null) counts[match[1]] = Number(match[2])
  return counts
}

function runNodeTest(label, cwd, glob, expectedCount) {
  console.log(`$ node --test --test-reporter=tap "${glob}"   (cwd: ${cwd})`)
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', glob], {
    cwd,
    encoding: 'utf8',
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  console.log('----- output -----')
  console.log(output.trimEnd())
  console.log('------------------')

  const counts = parseTapCounts(output)
  console.log(`${label}: tests=${counts.tests ?? '?'} pass=${counts.pass ?? '?'} fail=${counts.fail ?? '?'}`)
  if (run.status !== 0) fail(`${label}: node --test exited ${run.status}`)
  if (counts.fail !== 0) fail(`${label}: ${counts.fail ?? 'unknown'} failing test(s)`)
  if (expectedCount !== null && counts.pass !== expectedCount) {
    fail(`${label}: expected ${expectedCount} passing, saw ${counts.pass ?? '?'}`)
  }
  if (run.status === 0 && counts.fail === 0 && (expectedCount === null || counts.pass === expectedCount)) {
    ok(`${label}: ${counts.pass} passing, 0 failing`)
  }
}

function runScript(label, script, expectedNote) {
  console.log(`$ node ${script}   (cwd: ${root})`)
  const run = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  console.log('----- output -----')
  console.log(output.trimEnd())
  console.log('------------------')
  if (run.status !== 0) fail(`${label}: exited ${run.status}`)
  else ok(`${label}: ${expectedNote}`)
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

gateEngineDiff()

heading('ENGINE SUITE (frozen, no rebuild)')
runNodeTest('engine suite', engineRoot, 'dist/**/*.test.js', EXPECTED_ENGINE_TESTS)

heading('ESCAPE TESTS (real Electron, all four vectors contained)')
runScript('escape tests', path.join('scripts', 'run-escape-tests.mjs'), 'PASS')

heading('APP BUILD (tsc strict: main + preload + renderer + shared + tests)')
runScript('app build', path.join('scripts', 'build.mjs'), 'dist/ emitted clean')

heading('APP NODE TESTS (bridge contract, reconstruction, keys)')
runNodeTest('app node tests', root, 'dist/test/*.test.js', EXPECTED_APP_TESTS)

heading('BRIDGE TYPE PROBE (tsc rejects a wrong payload shape both ways)')
runScript('bridge type probe', path.join('scripts', 'probe-bridge-types.mjs'), 'probe PASS')

heading('ELECTRON CONTRACT (real main process, cold + mid-run)')
runScript('electron contract', path.join('scripts', 'run-electron-contract.mjs'), 'PASS')

console.log(`\n${'='.repeat(78)}`)
if (failures.length === 0) {
  console.log('GATE RESULT: PASS (all 7 items)')
  console.log('='.repeat(78))
  process.exit(0)
}
console.log(`GATE RESULT: FAIL (${failures.length} item(s))`)
for (const f of failures) console.log(`  - ${f}`)
console.log('='.repeat(78))
process.exit(1)
