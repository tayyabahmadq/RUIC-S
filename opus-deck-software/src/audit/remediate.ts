/**
 * Phase 8: The remediation loop.
 * Emits remediation tasks, re-scans only affected (file, rule), escalates
 * anything unresolved after two rounds. Critical/high without a strategy
 * are escalated, never advisory.
 *
 * Phase 3 (gate severity, R5): the escalation threshold is severity-
 * thresholded and reads ONE injected value — `options.failOn`, resolved once
 * at wiring from explicit runtime config -> STATE/config.json -> "critical".
 * Findings AT OR ABOVE the threshold take the blocking/escalation path;
 * findings below it surface as non-blocking advisories. The default
 * ("critical") is the shipped resolution default.
 */
import { RULES, getRule, severityRank } from './rules.js'
import { scanFile } from './scan.js'
import type {
  Advisory, Artifact, BatchAuthorization, BatchConfirmationRequest, BusTaskOutcome, EnqueueReceipt, Escalation,
  EscalationReason, Finding, PatchStrategy, RemediationDeps, RemediationOptions,
  RemediationResult, RemediationTask, RescanSource, Rule, RuleId, Severity, TaskPriority,
} from './types.js'

export const MAX_REMEDIATION_ROUNDS = 2

/** Default gate severity (R5): the shipped resolution default. */
export const DEFAULT_FAIL_ON: Severity = 'critical'

/** `true` when `severity` is at least as severe as the `failOn` threshold. */
export function atOrAboveFailOn(severity: Severity, failOn: Severity): boolean {
  return severityRank(severity) <= severityRank(failOn)
}

/**
 * Phase 4: the remediation batch that would execute together — the blocking,
 * patchable, unresolved findings, deduplicated by path. `null` when the batch
 * spans a single file (or is empty), i.e. when no confirmation is required.
 *
 * Exported so callers can pre-issue a single-use token for the exact batch the
 * loop will build; the loop and the caller derive membership from this function,
 * so their scopes agree by construction.
 */
export function planRemediationBatch(
  findings: readonly Finding[],
  rules: readonly Rule[] = RULES,
  failOn: Severity = DEFAULT_FAIL_ON,
): BatchConfirmationRequest | null {
  const ids = selectPatchable(findings, rules, failOn).map((f) => f.id)
  const paths = [...new Set(selectPatchable(findings, rules, failOn).map((f) => f.path))].sort()
  if (paths.length <= 1) return null
  return { paths, findingIds: [...ids].sort() }
}

/** Audit never imports the confirmation layer; it only reports what it was told. */
function confirmationDetail(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null
  const code = e !== null && typeof e?.code === 'string' ? e.code : 'E_BATCH_UNCONFIRMED'
  const message = e !== null && typeof e?.message === 'string' ? e.message : String(err)
  return `${code}: ${message}`
}


export function envVarName(evidence: string): string {
  const match = /(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|secret|token|password|passwd|pwd|credentials?|private[_-]?key|auth[_-]?token|client[_-]?secret)[A-Za-z0-9_]*/i.exec(evidence)
  const raw = match?.[0]
  if (!raw) return 'SECRET_VALUE'
  const spaced = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  const normalized = spaced.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
  return normalized || 'SECRET_VALUE'
}

export function describeRemediation(strategy: PatchStrategy, finding: Finding): { instruction: string; suggestion: string } {
  switch (strategy) {
    case 'escape':
      return { instruction: 'Escape the interpolated value before it reaches an HTML sink.', suggestion: 'escapeHtml(value)' }
    case 'env-var':
      return { instruction: 'Remove the literal; read from the environment at runtime.', suggestion: `process.env.${envVarName(finding.evidence)}` }
    case 'https':
      return { instruction: 'Upgrade the endpoint to TLS.', suggestion: finding.evidence.replace(/http:\/\//g, 'https://') }
    case 'crypto-random':
      return { instruction: 'Generate with node:crypto.', suggestion: 'crypto.randomUUID()' }
  }
}

export function remediationTaskId(findingId: string, round: number): string {
  let hash = 0
  const input = `${findingId}\u0000${round}`
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0
  }
  return `RTD-${Math.abs(hash).toString(16).padStart(8, '0').toUpperCase()}`
}

export function buildRemediationTask(
  finding: Finding, round: number, createdAt: string, rules: readonly Rule[] = RULES,
): RemediationTask {
  const rule = getRule(finding.ruleId, rules)
  const strategy = rule.patchStrategy
  if (!strategy) throw new Error(`E_NO_PATCH_STRATEGY: ${rule.id}`)
  const advice = describeRemediation(strategy, finding)
  return {
    id: remediationTaskId(finding.id, round),
    kind: 'security-remediation',
    folder: 'audit',
    priority: severityRank(finding.severity) as TaskPriority,
    round, findingId: finding.id, ruleId: rule.id, severity: finding.severity,
    patchStrategy: strategy, targetPath: finding.path, targetLine: finding.line,
    evidence: finding.evidence, instruction: advice.instruction, suggestion: advice.suggestion,
    detectorModelId: finding.detectorModelId, createdAt,
  }
}

export function selectPatchable(findings: readonly Finding[], rules: readonly Rule[] = RULES, failOn: Severity = DEFAULT_FAIL_ON): Finding[] {
  return findings.filter((f) =>
    !f.resolved && atOrAboveFailOn(f.severity, failOn) &&
    rules.some((r) => r.id === f.ruleId && r.patchStrategy),
  )
}

/**
 * Everything BELOW the gate severity threshold is advisory — never blocking.
 * At the shipped default ("critical") that is high/medium/low; raising the
 * threshold (failOn) moves severities from the advisory partition onto the
 * blocking/escalation partition.
 */
export function toAdvisories(findings: readonly Finding[], rules: readonly Rule[] = RULES, failOn: Severity = DEFAULT_FAIL_ON): Advisory[] {
  const out: Advisory[] = []
  for (const f of findings) {
    if (f.resolved) continue
    if (atOrAboveFailOn(f.severity, failOn)) continue
    const rule = rules.find((c) => c.id === f.ruleId)
    out.push({ findingId: f.id, ruleId: f.ruleId, severity: f.severity, path: f.path, line: f.line, detectorModelId: f.detectorModelId, message: f.message, suggestion: rule?.guidance ?? '', blocking: false })
  }
  return out
}

function escalationId(findingId: string, reason: EscalationReason, rounds: number): string {
  let hash = 0
  for (const ch of `${findingId}\u0000${reason}\u0000${rounds}`) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  return `ESC-${Math.abs(hash).toString(16).padStart(8, '0').toUpperCase()}`
}

function buildEscalation(finding: Finding, reason: EscalationReason, rounds: number, detail: string, createdAt: string): Escalation {
  return {
    id: escalationId(finding.id, reason, rounds), kind: 'security-escalation', folder: 'audit',
    findingId: finding.id, ruleId: finding.ruleId, severity: finding.severity, path: finding.path,
    line: finding.line, detectorModelId: finding.detectorModelId, reason, rounds, detail, evidence: finding.evidence, createdAt,
  }
}

/**
 * Phase 3 (gate severity): the escalation threshold. A finding is "blocking"
 * (remediation path + escalations, never advisory) exactly when its severity
 * is AT OR ABOVE the injected `failOn` threshold.
 */
function isBlocking(finding: Finding, failOn: Severity): boolean {
  return atOrAboveFailOn(finding.severity, failOn)
}

export async function remediateFindings(
  findings: readonly Finding[],
  deps: RemediationDeps,
  options: RemediationOptions = {},
): Promise<RemediationResult> {
  if (!Array.isArray(findings)) throw new Error('E_INVALID_INPUT: findings must be an array')
  if (!deps || typeof deps !== 'object' || typeof deps.bus?.enqueue !== 'function') {
    throw new Error('E_MISSING_DEP: deps.bus.enqueue is required')
  }
  const rules = options.rules ?? RULES
  const maxRounds = Math.min(Math.max(Math.trunc(options.maxRounds ?? MAX_REMEDIATION_ROUNDS), 0), MAX_REMEDIATION_ROUNDS)
  const now = deps.now ?? (() => new Date().toISOString())
  // Phase 3 (gate severity): THE injected threshold (R5: resolved once at
  // wiring from explicit config -> STATE/config.json -> "critical").
  const failOn: Severity = options.failOn ?? DEFAULT_FAIL_ON

  const store = deps.artifacts
  const rescanSource: RescanSource = store !== undefined ? 'artifact-store' : 'none'

  const tasks: RemediationTask[] = []
  const escalations: Escalation[] = []
  const resolved: Finding[] = []
  const advisories = toAdvisories(findings, rules, failOn)
  const states = new Map<string, 'open' | 'resolved' | 'abandoned'>()
  const open: { finding: Finding; rule: Rule; strategy: PatchStrategy; line: number; evidence: string; rounds: number }[] = []
  const blocking: Finding[] = []

  const pushEscalation = (finding: Finding, reason: EscalationReason, rounds: number, detail: string): void => {
    const esc = buildEscalation(finding, reason, rounds, detail, now())
    escalations.push(esc)
    if (deps.escalations) {
      try { void deps.escalations.push(esc) } catch { }
    }
  }

  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') throw new Error('E_INVALID_FINDING')
    if (typeof finding.id !== 'string' || typeof finding.path !== 'string' || typeof finding.line !== 'number') {
      throw new Error('E_INVALID_FINDING')
    }
    if (finding.resolved) continue
    if (!isBlocking(finding, failOn)) continue
    if (states.has(finding.id)) continue
    states.set(finding.id, 'open')
    blocking.push(finding)

    const rule = rules.find((c) => c.id === finding.ruleId)
    const strategy = rule?.patchStrategy
    if (!rule || !strategy) {
      states.set(finding.id, 'abandoned')
      pushEscalation(finding, 'no-patch-strategy', 0, rule
        ? `Rule ${finding.ruleId} declares no patchStrategy; requires lead judgement.`
        : `Rule ${finding.ruleId} is not in the active ruleset.`)
      continue
    }
    open.push({ finding, rule, strategy, line: finding.line, evidence: finding.evidence, rounds: 0 })
  }

  let rounds = 0, rescans = 0, accepted = 0, rejected = 0

  // --- Phase 4: a multi-file batch executes only against a consumed confirmation ---
  // Asked once per run (every round of the loop is part of the same batch).
  // No gate injected, or a single-file batch: unchanged behavior.
  let batch: BatchConfirmationRequest | undefined
  let batchAuthorization: BatchAuthorization | undefined
  const gate = deps.confirmations
  if (gate !== undefined) {
    const request = planRemediationBatch(findings, rules, failOn)
    if (request !== null) {
      batch = request
      try {
        batchAuthorization = gate.authorize(request)
      } catch (err) {
        for (const item of open) {
          states.set(item.finding.id, 'abandoned')
          pushEscalation(item.finding, 'batch-unconfirmed', 0,
            `Multi-file batch (${request.paths.join(', ')}) was not confirmed; nothing executed. ${confirmationDetail(err)}`)
        }
      }
    }
  }

  while (rounds < maxRounds) {
    const batch = open.filter((i) => states.get(i.finding.id) === 'open')
    if (batch.length === 0) break
    rounds += 1
    const touched = new Set<string>()
    for (const item of batch) {
      const task = buildRemediationTask({ ...item.finding, line: item.line, evidence: item.evidence }, rounds, now(), rules)
      let receipt: EnqueueReceipt
      try { receipt = await deps.bus.enqueue(task) } catch { throw new Error('E_BUS_FAILURE') }
      tasks.push(task)
      item.rounds = rounds
      if (!receipt.accepted) {
        states.set(item.finding.id, 'abandoned')
        rejected++
        pushEscalation(item.finding, 'task-rejected', rounds, receipt.note ?? 'rejected')
        continue
      }
      accepted++
      if (deps.bus.awaitSettlement) {
        let outcome: BusTaskOutcome
        try { outcome = await deps.bus.awaitSettlement(receipt) } catch { throw new Error('E_BUS_FAILURE') }
        if (!outcome.ok) {
          states.set(item.finding.id, 'abandoned')
          rejected++
          pushEscalation(item.finding, 'task-failed', rounds, outcome.error ?? 'failed')
          continue
        }
      }
      touched.add(`${item.finding.path}\u0000${item.finding.ruleId}`)
    }
    if (touched.size === 0) continue
    for (const key of touched) {
      const sep = key.indexOf('\u0000')
      const path = key.slice(0, sep)
      const ruleId = key.slice(sep + 1) as RuleId
      const affected = batch.filter((i) => i.finding.path === path && i.finding.ruleId === ruleId)
      if (affected.length === 0) continue
      let artifact: Artifact | undefined
      if (store) {
        try { artifact = await store.read(path) } catch {
          for (const item of affected) { states.set(item.finding.id, 'abandoned'); pushEscalation(item.finding, 'rescan-unavailable', rounds, `cannot read ${path}`) }
          continue
        }
      }
      if (!artifact) {
        for (const item of affected) { states.set(item.finding.id, 'abandoned'); pushEscalation(item.finding, 'rescan-unavailable', rounds, `no artifact for ${path}`) }
        continue
      }
      rescans += 1
      const stillPresent = scanFile(artifact, [affected[0].finding.detectorModelId], [ruleId], { rules, minAuditors: 1 })
      for (const item of affected) {
        const remaining = stillPresent.filter((f) => f.ruleId === ruleId)
        if (remaining.length === 0) {
          states.set(item.finding.id, 'resolved')
          resolved.push({ ...item.finding, resolved: true })
        } else {
          item.line = remaining[0].line
          item.evidence = remaining[0].evidence
        }
      }
    }
  }

  for (const item of open) {
    if (states.get(item.finding.id) !== 'open') continue
    pushEscalation(item.finding, 'unresolved-after-patching', item.rounds, `rule ${item.rule.id} did not clear after ${item.rounds} round(s)`)
    states.set(item.finding.id, 'abandoned')
  }

  const resolvedIds = new Set(resolved.map((f) => f.id))
  return {
    rounds, tasks, accepted, rejected, resolved,
    unresolved: blocking.filter((f) => !resolvedIds.has(f.id)),
    escalations, advisories, rescans, rescanSource,
    ...(batch === undefined ? {} : { batch }),
    ...(batchAuthorization === undefined ? {} : { batchAuthorization }),
  }
}
