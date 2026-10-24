// Opus//DECK App — Escape test runner (gate item 3).
//
// Spawns the local Electron binary against the escape test entry
// (src/test/electron/escape.test.js), which creates a sandboxed BrowserView,
// loads a hostile page, and verifies that all four escape vectors are blocked:
//
//   a. require/process/window.__deckBridge__ are all undefined
//   b. new windows / navigation away are blocked
//   c. IPC channels are unreachable
//   d. fetch/XHR to network fails
//
// The verdict is written to DECK_ESCAPE_RESULT as JSON; the process exits 0
// on pass, non-zero on fail.

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = require('electron')
const entry = path.join(root, 'dist', 'test', 'electron', 'escape.test.js')

const resultPath = path.join(os.tmpdir(), `deck-escape-${process.pid}.json`)
rmSync(resultPath, { force: true })

console.log('[escape-tests] launching Electron escape tests')
const run = spawnSync(
  electronPath,
  ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', entry],
  {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    env: {
      ...process.env,
      DECK_ESCAPE_RESULT: resultPath,
      ELECTRON_ENABLE_LOGGING: '',
    },
  }
)

if (run.stdout) console.log(run.stdout.trim())
if (run.stderr) console.error(run.stderr.trim())
if (run.error) console.error(`[escape-tests] spawn error: ${run.error.message}`)

let verdict = null
try {
  verdict = JSON.parse(readFileSync(resultPath, 'utf8'))
} catch {
  verdict = null
}
rmSync(resultPath, { force: true })

const ok = run.status === 0 && verdict !== null && verdict.pass === true
if (!ok) {
  console.error(`[escape-tests] FAIL: escape tests did not pass`)
  console.error(`  exit code: ${run.status}`)
  console.error(`  verdict: ${JSON.stringify(verdict)}`)
  process.exit(1)
}
console.log(`[escape-tests] PASS: all escape vectors contained`)
console.log(`  details: ${JSON.stringify(verdict)}`)
