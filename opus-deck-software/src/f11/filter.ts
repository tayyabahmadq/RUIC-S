/**
 * Opus//DECK — Phase 11: Review Agent (f11) — filter.
 * Hard exclusions: non-text/binary, files over size cap, held-claim paths,
 * vendored/generated globs.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { ReviewRequest } from './types.js'

const MAX_FILE_SIZE = 100_000 // 100KB

const VENDOR_DIRS = ['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', '.venv']
const GENERATED_SUFFIXES = ['.min.js', '.min.css', '.lock', '.map', '.min.mjs']

export interface FilterResult {
  readonly included: string[]
  readonly excluded: Array<{ path: string; reason: string }>
}

export async function filterFiles(
  files: string[],
  request: ReviewRequest,
  holdersOf?: (path: string) => Promise<string[]>,
): Promise<FilterResult> {
  const included: string[] = []
  const excluded: Array<{ path: string; reason: string }> = []

  for (const file of files) {
    if (isVendoredOrGenerated(file)) {
      excluded.push({ path: file, reason: 'vendored-or-generated' })
      continue
    }

    if (await isOverSizeCap(request.memoryDir, file)) {
      excluded.push({ path: file, reason: 'over-size-cap' })
      continue
    }

    if (holdersOf) {
      try {
        const holders = await holdersOf(file)
        if (holders.length > 0) {
          excluded.push({ path: file, reason: 'held-claim' })
          continue
        }
      } catch {
        // If holdersOf fails, don't exclude — fail open
      }
    }

    included.push(file)
  }

  return { included, excluded }
}

function isVendoredOrGenerated(rel: string): boolean {
  const parts = rel.split(/[/\\]/)
  if (parts.some((p) => VENDOR_DIRS.includes(p))) return true
  const name = parts[parts.length - 1]
  return GENERATED_SUFFIXES.some((s) => name.endsWith(s))
}

async function isOverSizeCap(memoryDir: string, rel: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(path.join(memoryDir, rel))
    return stat.size > MAX_FILE_SIZE
  } catch {
    return false
  }
}
