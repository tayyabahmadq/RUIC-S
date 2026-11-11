// Re-freeze tool: regenerate the engine baseline manifest + aggregate after a
// SANCTIONED engine phase (Common-S v2). Mirrors gate.mjs's walk/hash exactly.
import { readFileSync, writeFileSync, readdirSync } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const engineRoot = path.resolve(root, '..', 'opus-deck-software')
const sha256Upper = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase()

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

const parts = []
for (const rel of walkEngineFiles()) {
  const segments = rel.replace(/^\\/, '').split('\\')
  const content = readFileSync(path.join(engineRoot, ...segments), 'utf8')
  parts.push(`${rel} ${sha256Upper(content)}`)
}
writeFileSync(path.join(root, 'scripts', 'engine-baseline.txt'), parts.join('\n') + '\n')
console.log('baseline regenerated:', parts.length, 'files')
console.log('new aggregate:', sha256Upper(parts.join('\n')))
