// Opus//DECK App — build.
//
// Emits `dist/` from `src/` with the project's own TypeScript (strict, zero
// `any` at the bridge), then copies the two non-TS renderer assets next to
// their compiled siblings. No bundler: the renderer is a plain script and the
// shared contract is loaded as a CommonJS file through an HTML prelude.

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')

rmSync(distDir, { recursive: true, force: true })

const tsc = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js')
const build = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
})
if (build.status !== 0) {
  console.error('[build] tsc failed')
  process.exit(build.status ?? 1)
}

const rendererOut = path.join(distDir, 'renderer')
mkdirSync(rendererOut, { recursive: true })
for (const asset of ['index.html', 'style.css', 'prelude.js', 'bind-bt.js']) {
  copyFileSync(path.join(root, 'src', 'renderer', asset), path.join(rendererOut, asset))
}

console.log('[build] dist/ emitted (main + preload + renderer + shared + tests)')
