/**
 * Phase 9: internal filesystem helpers.
 */
import * as fs from 'fs'
import * as path from 'path'

export async function pathExists(file: string): Promise<boolean> {
  try { await fs.promises.access(file); return true } catch { return false }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true })
}

export function normalizeRel(rel: string): string {
  return rel.split(path.sep).join('/')
}

export function countLoc(text: string): number {
  if (text === '') return 0
  return text.split('\n').length
}

export async function walkFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      for (const sub of await walkFiles(full)) results.push(path.join(e.name, sub).split(path.sep).join('/'))
    } else if (e.isFile()) {
      results.push(e.name)
    }
  }
  return results
}
