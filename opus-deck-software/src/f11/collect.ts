/**
 * Opus//DECK — Phase 11: Review Agent (f11) — collect.
 * Builds the deterministic file list from WORKSPACE (or explicit paths).
 */
import * as fs from 'fs'
import * as path from 'path'
import type { ReviewRequest } from './types.js'

export async function collectFiles(memoryDir: string, explicitFiles?: string[]): Promise<string[]> {
  if (explicitFiles && explicitFiles.length > 0) {
    return [...explicitFiles].sort()
  }

  const workspaceDir = path.join(memoryDir, 'WORKSPACE')
  if (!(await dirExists(workspaceDir))) return []

  const relFiles = await walkFiles(workspaceDir)
  return relFiles.map((rel) => path.join('WORKSPACE', rel).split(path.sep).join('/')).sort()
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await fs.promises.access(dir)
    return true
  } catch {
    return false
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      for (const sub of await walkFiles(full)) {
        results.push(path.join(e.name, sub).split(path.sep).join('/'))
      }
    } else if (e.isFile()) {
      results.push(e.name)
    }
  }
  return results
}
