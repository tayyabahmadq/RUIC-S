/**
 * Opus//DECK — Phase 11: Review Agent (f11) — bundle.
 * Groups files into review bundles — same-stem test/file pairs, dir-sibling
 * config grouping; token-budgeted with the f04 estimateTokens seam.
 */
import * as path from 'path'
import type { ReviewBundle, ReviewCriterion } from './types.js'
import { estimateTokens } from '../compactor/index.js'

const BUNDLE_TOKEN_CAP = 4000

export function bundleFiles(
  files: string[],
  criteria: ReviewCriterion[],
  estimateTokensFn: (text: string) => number = estimateTokens,
): ReviewBundle[] {
  const groups = groupFiles(files)

  const bundles: ReviewBundle[] = []
  let bundleIndex = 0

  for (const group of groups) {
    const groupText = group.join('\n')
    const groupTokens = estimateTokensFn(groupText)

    if (groupTokens <= BUNDLE_TOKEN_CAP) {
      bundles.push(makeBundle(++bundleIndex, group, criteria, estimateTokensFn))
    } else {
      // Split group across multiple bundles
      let current: string[] = []
      let currentTokens = 0

      for (const file of group) {
        const fileText = `### ${file}\n`
        const fileTokens = estimateTokensFn(fileText)

        if (currentTokens + fileTokens > BUNDLE_TOKEN_CAP && current.length > 0) {
          bundles.push(makeBundle(++bundleIndex, current, criteria, estimateTokensFn))
          current = [file]
          currentTokens = fileTokens
        } else {
          current.push(file)
          currentTokens += fileTokens
        }
      }

      if (current.length > 0) {
        bundles.push(makeBundle(++bundleIndex, current, criteria, estimateTokensFn))
      }
    }
  }

  // Coverage guarantee: every input file must appear in at least one bundle.
  assertCoverage(files, bundles)

  return bundles
}

export function assertCoverage(files: string[], bundles: ReviewBundle[]): void {
  const bundledFiles = new Set(bundles.flatMap((b) => b.files))
  const missing = files.filter((f) => !bundledFiles.has(f))
  if (missing.length > 0) {
    throw new Error(
      `Bundle coverage failure: ${missing.length} file(s) not in any bundle: ${missing.join(', ')}`,
    )
  }
}

function makeBundle(index: number, files: string[], criteria: ReviewCriterion[], estimateTokensFn: (text: string) => number): ReviewBundle {
  const text = files.join('\n')
  return {
    id: `BND-${String(index).padStart(6, '0')}`,
    files: [...files],
    tokenEstimate: estimateTokensFn(text),
    criteria: [...criteria],
  }
}

function groupFiles(files: string[]): string[][] {
  const groups: string[][] = []
  const used = new Set<string>()

  // Same-stem test/file pairs: app.ts + app.test.ts
  for (const file of files) {
    if (used.has(file)) continue
    const stem = getStem(file)
    const pair = files.filter((f) => getStem(f) === stem && !used.has(f))
    if (pair.length > 1) {
      pair.forEach((f) => used.add(f))
      groups.push([...pair].sort())
    }
    // Single files are handled by the second loop below
  }

  // Remaining: dir-sibling config grouping, then individual files
  for (const file of files) {
    if (used.has(file)) continue
    used.add(file)

    const dir = path.dirname(file)
    const siblings = files.filter(
      (f) => path.dirname(f) === dir && !used.has(f) && isConfigFile(f),
    )
    if (siblings.length > 0) {
      siblings.forEach((f) => used.add(f))
      groups.push([file, ...siblings].sort())
    } else {
      groups.push([file])
    }
  }

  return groups
}

function getStem(file: string): string {
  const base = path.basename(file)
  return base.replace(/\.(test|spec|min)\.\w+$/, '').replace(/\.\w+$/, '')
}

function isConfigFile(file: string): boolean {
  const name = path.basename(file)
  const configNames = [
    'package.json', 'tsconfig.json', '.eslintrc', '.eslintrc.json', '.eslintrc.js',
    '.prettierrc', '.prettierrc.json', 'webpack.config.js', 'vite.config.js',
    'jest.config.js', '.gitignore', '.dockerignore',
  ]
  return configNames.includes(name) || name.endsWith('.json') && name !== 'package-lock.json'
}
