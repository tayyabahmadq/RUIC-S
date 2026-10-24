/**
 * Phase 8: rule helpers.
 */
import type { Rule, Severity, RuleId, PatchStrategy } from './types.js'
import { RULES, SEVERITY_ORDER, SECRET_MIN_LENGTH, escapeHtml, isCommentLine } from './rules-impl.js'

export { RULES, SEVERITY_ORDER, SECRET_MIN_LENGTH, escapeHtml, isCommentLine }

export const RULE_IDS = {
  EVAL: 'SEC-001' as RuleId,
  HTML_SINK: 'SEC-002' as RuleId,
  SQL_CONCAT: 'SEC-003' as RuleId,
  HARDCODED_SECRET: 'SEC-004' as RuleId,
  INSECURE_TRANSPORT: 'SEC-005' as RuleId,
  WEAK_RANDOM: 'SEC-006' as RuleId,
  PASSWORD_COMPARE: 'SEC-007' as RuleId,
} as const

export function getRule(id: RuleId, rules: readonly Rule[] = RULES): Rule {
  const rule = rules.find((r) => r.id === id)
  if (!rule) throw new Error(`E_UNKNOWN_RULE: ${id}`)
  return rule
}

export function rulesForAuditor(auditorId: string, rules: readonly Rule[] = RULES): Rule[] {
  return rules.filter((r) => r.detectors.includes('any') || r.detectors.includes(auditorId))
}

export function hasDetector(rule: Rule, auditorId: string): boolean {
  return rule.detectors.includes('any') || rule.detectors.includes(auditorId)
}

export function isRuleId(value: string): value is RuleId {
  return /^SEC-\d{3}$/.test(value)
}

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity)
}
