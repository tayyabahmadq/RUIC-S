/**
 * Opus//DECK — Phase 11: Review Agent (f11) — rules.
 * Rule packs as data: RULES/<lang>.pack matching globs → per-bundle
 * ReviewCriterion[]. Template matching, not model-selected.
 */
import type { ReviewCriterion, RulePack } from './types.js'

function criterion(
  id: string,
  severity: 'critical' | 'high' | 'medium' | 'low',
  hint: string,
  source: 'f08' | 'f11' = 'f11',
): ReviewCriterion {
  return { id, severity, promptHint: hint, ruleSource: source }
}

export const TYPESCRIPT_PACK: RulePack = {
  id: 'typescript',
  language: 'TypeScript',
  globs: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
  criteria: [
    criterion('SEC-001', 'critical', 'eval(), new Function(), or other dangerous dynamic code execution', 'f08'),
    criterion('SEC-002', 'high', 'innerHTML/outerHTML/insertAdjacentHTML/document.write with unescaped user input', 'f08'),
    criterion('SEC-003', 'high', 'SQL query built by string concatenation with user input', 'f08'),
    criterion('SEC-004', 'critical', 'Hardcoded secret (API key, token, password) assigned a string literal >= 8 chars', 'f08'),
    criterion('SEC-005', 'medium', 'http:// URL outside loopback addresses', 'f08'),
    criterion('SEC-006', 'medium', 'Math.random() used for security values (tokens, keys, IDs)', 'f08'),
    criterion('SEC-007', 'medium', 'Non-constant-time comparison (==, ===, !=, !==) on passwords/secrets/tokens', 'f08'),
  ],
}

export const RULE_PACKS: readonly RulePack[] = Object.freeze([TYPESCRIPT_PACK])

export function listRules(): Array<{ id: string; language: string; globs: string[]; criteriaCount: number }> {
  return RULE_PACKS.map((p) => ({
    id: p.id,
    language: p.language,
    globs: [...p.globs],
    criteriaCount: p.criteria.length,
  }))
}

export function criteriaForBundle(
  files: string[],
  packs: readonly RulePack[] = RULE_PACKS,
): ReviewCriterion[] {
  const matched: ReviewCriterion[] = []
  const seen = new Set<string>()

  for (const pack of packs) {
    if (!files.some((f) => matchesAnyGlob(f, pack.globs))) continue
    for (const c of pack.criteria) {
      if (!seen.has(c.id)) {
        seen.add(c.id)
        matched.push(c)
      }
    }
  }

  return matched
}

function matchesAnyGlob(file: string, globs: string[]): boolean {
  return globs.some((g) => matchesGlob(file, g))
}

function matchesGlob(file: string, glob: string): boolean {
  return globToRegex(glob).test(file)
}

function globToRegex(glob: string): RegExp {
  let regex = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      regex += '.*'
      i++
    } else if (c === '*') {
      regex += '[^/]*'
    } else if (c === '?') {
      regex += '[^/]'
    } else if (c === '.') {
      regex += '\\.'
    } else if (c === '/') {
      regex += '/'
    } else {
      regex += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${regex}$`)
}
