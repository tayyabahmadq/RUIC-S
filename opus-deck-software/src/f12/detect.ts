/**
 * Opus//DECK — Phase 12: CodeGraph — file role detection.
 * Classifies files into entry/module/test/config/doc from path conventions.
 * No parsing library — pure path analysis.
 */
import type { FileRole } from './types.js'

/** File names that are conventionally entry points. */
const ENTRY_NAMES = new Set(['index', 'main', 'app', 'server', 'cli', 'start', 'init'])

/** Patterns that identify test files. */
const TEST_PATTERNS: RegExp[] = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /[/\\]__tests__[/\\]/,
  /[/\\]tests?[/\\]/,
]

/** Patterns that identify config files. */
const CONFIG_PATTERNS: RegExp[] = [
  /\.config\.[jt]sx?$/,
  /tsconfig.*\.json$/,
  /package\.json$/,
  /\.eslintrc.*$/,
  /webpack[/\\]/,
  /vite\.config\./,
  /babel\.config\./,
  /jest\.config\./,
  /prettier\.config\./,
  /\.prettierrc.*$/,
  /\.env$/,
]

/** Patterns that identify doc files. */
const DOC_PATTERNS: RegExp[] = [
  /\.md$/,
  /\.txt$/,
  /\.rst$/,
  /^README/i,
  /^CHANGELOG/i,
  /^LICENSE/i,
  /^CONTRIBUTING/i,
  /^TODO/i,
]

/** Patterns that identify source files (code). */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

/**
 * Classify a file's role from its relative path.
 * Order matters: test → config → doc → entry → module.
 */
export function classifyFileRole(relPath: string): FileRole {
  const normalized = relPath.replace(/\\/g, '/')
  const segments = normalized.split('/')
  const base = segments[segments.length - 1] ?? ''
  const ext = base.includes('.') ? '.' + base.split('.').pop()! : ''
  const name = base.replace(/\.[^.]+$/, '')

  // Test files
  if (TEST_PATTERNS.some((p) => p.test(normalized))) return 'test'

  // Config files
  if (CONFIG_PATTERNS.some((p) => p.test(normalized))) return 'config'

  // Doc files
  if (DOC_PATTERNS.some((p) => p.test(normalized))) return 'doc'

  // Entry points: source files with conventional entry names
  if (SOURCE_EXTENSIONS.has(ext) && ENTRY_NAMES.has(name)) return 'entry'

  // Source files are modules; everything else is doc
  if (SOURCE_EXTENSIONS.has(ext)) return 'module'

  return 'doc'
}
