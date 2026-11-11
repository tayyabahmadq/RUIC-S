// Opus//DECK App — Electron bridge-contract runner (gate item 3).
//
// Spawns the local Electron binary against the compiled contract test entry
// (`dist/test/electron/main.js`) once per mode, then asserts the verdict file
// the test wrote: renderer-reconstructed state == host expected state.

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = require('electron')
const entry = path.join(root, 'dist', 'test', 'electron', 'main.js')

const modes = process.argv.slice(2).filter((a) => a === 'cold' || a === 'midrun')
const selected = modes.length > 0 ? modes : ['cold', 'midrun']

let failures = 0
for (const mode of selected) {
  const resultPath = path.join(os.tmpdir(), `deck-contract-${mode}-${process.pid}.json`)
  rmSync(resultPath, { force: true })

  console.log(`[electron-contract] mode=${mode}: launching ${electronPath}`)
  const run = spawnSync(
    electronPath,
    ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', entry],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 180000,
      env: {
        ...process.env,
        DECK_CONTRACT_MODE: mode,
        DECK_CONTRACT_RESULT: resultPath,
        ELECTRON_ENABLE_LOGGING: '',
      },
    },
  )

  if (run.stdout) console.log(run.stdout.trim())
  if (run.stderr) console.error(run.stderr.trim())
  if (run.error) console.error(`[electron-contract] spawn error: ${run.error.message}`)

  let verdict = null
  try {
    verdict = JSON.parse(readFileSync(resultPath, 'utf8'))
  } catch {
    verdict = null
  }
  rmSync(resultPath, { force: true })

  const ok = run.status === 0 && verdict !== null && verdict.matches === true
  if (!ok) failures += 1
  console.log(`[electron-contract] mode=${mode} exit=${run.status} verdict=${JSON.stringify(verdict)}`)
  console.log(`[electron-contract] mode=${mode} -> ${ok ? 'PASS' : 'FAIL'}`)
}

if (failures > 0) {
  console.error(`[electron-contract] FAIL: ${failures} mode(s) did not match`)
  process.exit(1)
}
console.log('[electron-contract] PASS: renderer-reconstructed state == expected state (cold + mid-run)')
