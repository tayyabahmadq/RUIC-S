/**
 * Phase 8: The scan engine.
 */
import {
  Artifact, Finding, Rule, RuleId, ScanOptions, ScanReport, Severity,
  SeverityCounts, ModelRef,
  MAX_HITS_PER_RULE_PER_FILE, DEFAULT_MIN_AUDITORS, EVIDENCE_MAX_LENGTH,
  FILE_LEVEL_EVIDENCE,
} from './types.js'
import { getRule, rulesForAuditor, hasDetector, severityRank, RULES } from './rules.js'

export function findingId(ruleId: RuleId, path: string, line: number): string {
  let hash = 0
  const input = `${ruleId}\u0000${path}\u0000${line}`
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0
  }
  return `FND-${Math.abs(hash).toString(16).padStart(12, '0')}`
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, EVIDENCE_MAX_LENGTH)
}

export function scanFile(
  artifact: Artifact,
  auditors: readonly (ModelRef | string)[],
  ruleIds: readonly RuleId[],
  options: ScanOptions = {},
): Finding[] {
  const rules = ruleIds.map((id) => getRule(id, options.rules))
  const maxHits = options.maxHitsPerRulePerFile ?? MAX_HITS_PER_RULE_PER_FILE
  const hits = new Map<string, Finding>()

  const lines = artifact.code.split('\n')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    if (/^\s*$/.test(line)) continue
    for (const auditor of auditors) {
      const auditorId = typeof auditor === 'string' ? auditor : auditor.id
      for (const rule of rules) {
        if (!hasDetector(rule, auditorId)) continue
        if (!rule.test(line)) continue
        const key = `${rule.id}\u0000${artifact.path}\u0000${li + 1}`
        const existing = hits.get(key)
        if (existing) {
          hits.set(key, { ...existing, auditorCount: existing.auditorCount + 1 })
          continue
        }
        hits.set(key, {
          id: findingId(rule.id, artifact.path, li + 1),
          ruleId: rule.id,
          severity: rule.severity,
          path: artifact.path,
          line: li + 1,
          detectorModelId: auditorId,
          resolved: false,
          evidence: collapse(line),
          message: `${rule.title} — ${collapse(line)}`,
          patchStrategy: rule.patchStrategy,
          auditorCount: 1,
          blocking: rule.severity === 'critical' || rule.severity === 'high',
        })
      }
    }
  }

  // fileTest rules
  for (const rule of rules) {
    if (!rule.fileTest) continue
    if (!rule.fileTest(artifact.code)) continue
    const lines2 = rule.locateFile ? rule.locateFile(artifact.code) : []
    const targetLine = lines2.length > 0 ? lines2[0] : 1
    const evidence = lines2.length > 0 ? collapse(artifact.code.split('\n')[targetLine - 1] ?? '') : FILE_LEVEL_EVIDENCE
    const key = `${rule.id}\u0000${artifact.path}\u0000${targetLine}`
    const existing = hits.get(key)
    if (existing) {
      hits.set(key, { ...existing, auditorCount: existing.auditorCount + 1 })
      continue
    }
    const auditorId = auditors[0] ? (typeof auditors[0] === 'string' ? auditors[0] : auditors[0].id) : 'unknown'
    hits.set(key, {
      id: findingId(rule.id, artifact.path, targetLine),
      ruleId: rule.id,
      severity: rule.severity,
      path: artifact.path,
      line: targetLine,
      detectorModelId: auditorId,
      resolved: false,
      evidence,
      message: `${rule.title} — ${evidence}`,
      patchStrategy: rule.patchStrategy,
      auditorCount: 1,
      blocking: rule.severity === 'critical' || rule.severity === 'high',
    })
  }

  const findings: Finding[] = [...hits.values()]
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.ruleId.localeCompare(b.ruleId))
  return findings
}

export function scanAll(
  artifacts: readonly Artifact[],
  auditors: readonly (ModelRef | string)[],
  options: ScanOptions = {},
): ScanReport {
  const rules = options.rules ?? RULES
  const minAuditors = options.minAuditors ?? DEFAULT_MIN_AUDITORS
  if (auditors.length < minAuditors) throw new Error(`E_INSUFFICIENT_AUDITORS: need ${minAuditors}, got ${auditors.length}`)
  if (rules.length === 0) throw new Error('E_EMPTY_RULESET')

  let filesScanned = 0, filesSkipped = 0
  const findings: Finding[] = []
  const byModel: Record<string, number> = {}
  const byPath: Record<string, number> = {}
  const byRule: Record<string, number> = {}
  const bySeverity: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 }
  const auditorsSeen: string[] = []
  let corroborated = 0

  for (const artifact of artifacts) {
    const skip = options.excludePaths?.some((p) => {
      if (p instanceof RegExp) return p.test(artifact.path)
      return artifact.path.includes(String(p))
    })
    if (skip) { filesSkipped++; continue }
    filesScanned++
    const ruleIds = rules.map((r: Rule) => r.id)
    const fileFindings = scanFile(artifact, auditors, ruleIds, options)
    for (const f of fileFindings) {
      findings.push(f)
      bySeverity[f.severity]++
      byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1
      byPath[f.path] = (byPath[f.path] ?? 0) + 1
      byModel[f.detectorModelId] = (byModel[f.detectorModelId] ?? 0) + 1
      if (!auditorsSeen.includes(f.detectorModelId)) auditorsSeen.push(f.detectorModelId)
      if (f.auditorCount >= 2) corroborated++
    }
  }

  return {
    findings,
    total: findings.length,
    filesScanned,
    filesSkipped,
    auditors: auditorsSeen,
    rulesEvaluated: rules.length,
    bySeverity,
    byRule,
    byModel,
    byPath,
    corroborated,
  }
}

export function gateBlocked(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.blocking && !f.resolved)
}

export function summarizeFindings(findings: readonly Finding[]): SeverityCounts {
  const out: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of findings) out[f.severity]++
  return out
}

export function groupByRule(findings: readonly Finding[]): Map<RuleId, Finding[]> {
  const m = new Map<RuleId, Finding[]>()
  for (const f of findings) {
    const arr = m.get(f.ruleId) ?? []
    arr.push(f)
    m.set(f.ruleId, arr)
  }
  return m
}

export function worstSeverity(findings: readonly Finding[]): Severity | null {
  let worst: Severity | null = null
  for (const f of findings) {
    if (!worst || severityRank(f.severity) < severityRank(worst)) worst = f.severity
  }
  return worst
}

export function contributingAuditors(findings: readonly Finding[]): string[] {
  const seen: string[] = []
  for (const f of findings) if (!seen.includes(f.detectorModelId)) seen.push(f.detectorModelId)
  return seen
}
