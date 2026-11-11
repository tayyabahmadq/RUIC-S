// Opus//DECK App — bridge type probe (R13/R11 method: mutation probe).
//
// Proves that the bridge contract is typed in BOTH directions with zero `any`,
// by mutating a THROWAWAY COPY of `src/` and confirming TypeScript rejects a
// wrong payload shape on each side:
//
//   1. control   — the untouched copy typechecks clean (exit 0);
//   2. probe     — two files are added (one wrong renderer -> main invoke
//                  payload, one wrong main -> renderer event payload) and tsc
//                  must fail on BOTH;
//   3. restore   — the probe files are removed and the copy typechecks clean.
//
// The real `src/` tree is never touched. The copy lives inside the app root so
// `node_modules` (typescript, electron, @types/node) resolves by walking up.

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = path.join(root, '.probe-tmp')
const tsc = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js')

const PROBE_RENDERER_TO_MAIN = `// PROBE: renderer -> main invoke payload is missing required fields.
import type { DeckInvokeCommand } from './shared/bridge-types'
const bad: DeckInvokeCommand = { type: 'run', payload: { memoryDir: 'm' } }
void bad
`

const PROBE_PREVIEW_COMMAND = `// PROBE: renderer -> main preview command payload has an invalid action.
import type { DeckInvokeCommand } from './shared/bridge-types'
const bad: DeckInvokeCommand = { type: 'preview', payload: { action: 'delete', runId: 'r' } }
void bad
`

const PROBE_MAIN_TO_RENDERER = `// PROBE: main -> renderer event payload has the wrong shape for its type.
import type { DeckEvent } from './shared/bridge-types'
const bad: DeckEvent = {
  id: 'e1',
  type: 'token.use',
  payload: { runId: 'r', severity: 'critical' },
  at: '2026-01-01T00:00:00.000Z',
}
void bad
`

const PROBE_PREVIEW_STATE = `// PROBE: main -> renderer preview.state payload has the wrong shape.
import type { DeckEvent } from './shared/bridge-types'
const bad: DeckEvent = {
  id: 'e2',
  type: 'preview.state',
  payload: { runId: 'r', open: 'yes', currentFile: null, files: [] },
  at: '2026-01-01T00:00:00.000Z',
}
void bad
`

function runTsc(label) {
  const result = spawnSync(process.execPath, [tsc, '-p', path.join(tmp, 'tsconfig.json'), '--noEmit'], {
    cwd: tmp,
    encoding: 'utf8',
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { label, status: result.status ?? 1, output }
}

rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
cpSync(path.join(root, 'src'), path.join(tmp, 'src'), { recursive: true })
cpSync(path.join(root, 'tsconfig.json'), path.join(tmp, 'tsconfig.json'))

const control = runTsc('control')
console.log(`[probe] control tsc exit=${control.status} (expected 0)`)
if (control.output.trim() !== '') console.log(control.output.trim())
if (control.status !== 0) {
  console.error('[probe] FAIL: untouched copy did not typecheck clean')
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}

writeFileSync(path.join(tmp, 'src', '__probe_renderer_to_main.ts'), PROBE_RENDERER_TO_MAIN, 'utf8')
writeFileSync(path.join(tmp, 'src', '__probe_preview_command.ts'), PROBE_PREVIEW_COMMAND, 'utf8')
writeFileSync(path.join(tmp, 'src', '__probe_main_to_renderer.ts'), PROBE_MAIN_TO_RENDERER, 'utf8')
writeFileSync(path.join(tmp, 'src', '__probe_preview_state.ts'), PROBE_PREVIEW_STATE, 'utf8')

const probe = runTsc('probe')
console.log(`[probe] mutated tsc exit=${probe.status} (expected non-zero)`)
console.log('----- tsc output (mutated copy) -----')
console.log(probe.output.trim())
console.log('-------------------------------------')

const sawRendererToMain = probe.output.includes('__probe_renderer_to_main.ts')
const sawPreviewCommand = probe.output.includes('__probe_preview_command.ts')
const sawMainToRenderer = probe.output.includes('__probe_main_to_renderer.ts')
const sawPreviewState = probe.output.includes('__probe_preview_state.ts')
const failed =
  probe.status === 0 ||
  !sawRendererToMain ||
  !sawPreviewCommand ||
  !sawMainToRenderer ||
  !sawPreviewState

rmSync(path.join(tmp, 'src', '__probe_renderer_to_main.ts'), { force: true })
rmSync(path.join(tmp, 'src', '__probe_preview_command.ts'), { force: true })
rmSync(path.join(tmp, 'src', '__probe_main_to_renderer.ts'), { force: true })
rmSync(path.join(tmp, 'src', '__probe_preview_state.ts'), { force: true })

const restored = runTsc('restored')
console.log(`[probe] restored tsc exit=${restored.status} (expected 0)`)

rmSync(tmp, { recursive: true, force: true })

if (failed) {
  console.error(
    `[probe] FAIL: tsc did not reject both sides (renderer->main=${sawRendererToMain}, main->renderer=${sawMainToRenderer})`,
  )
  process.exit(1)
}
if (restored.status !== 0) {
  console.error('[probe] FAIL: copy did not return to clean after removing probes')
  process.exit(1)
}

console.log('[probe] PASS: tsc catches a wrong payload shape in BOTH directions')
