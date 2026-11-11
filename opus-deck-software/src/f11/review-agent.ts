/**
 * Opus//DECK — Phase 11: Review Agent (f11) — review-agent.
 * Orchestrates: collect → filter → bundle → LLM review → position → reflect →
 * persist → escalate. All LLM calls go directly through f02 transport (not the
 * f07 task/claim queue).
 */
import * as fs from 'fs'
import * as path from 'path'
import { collectFiles } from './collect.js'
import { filterFiles } from './filter.js'
import { bundleFiles, assertCoverage } from './bundle.js'
import { criteriaForBundle, listRules, RULE_PACKS } from './rules.js'
import { positionFindings, type RawFinding } from './position.js'
import { buildReflectPrompt, parseReflectOutput } from './reflect.js'
import type {
  ReviewAgentDeps,
  ReviewRequest,
  ReviewResult,
  ReviewBundle,
  PositionedFinding,
  ReviewDrop,
  ReviewReflection,
  PersistedFinding,
} from './types.js'

const REVIEW_MODEL_ID = 'reviewer'

/** Shipped system prompt; the `reviewer` persona replaces it when present. */
const BUILT_IN_REVIEWER_SYSTEM_PROMPT = 'You are a senior security reviewer. Output only valid JSON.'

export class ReviewAgent {
  private readonly deps: ReviewAgentDeps

  constructor(deps: ReviewAgentDeps) {
    this.deps = deps
  }

  async review(request: ReviewRequest): Promise<ReviewResult> {
    // Emit review.requested
    this.deps.hub.emit('review.requested', {
      runId: request.runId,
      fileCount: request.files?.length ?? 0,
      bundleCount: 0,
    })

    // --- Collect files from WORKSPACE ---
    const allFiles = await collectFiles(request.memoryDir, request.files)

    // --- Filter exclusions ---
    const filterResult = await filterFiles(allFiles, request, this.deps.holdersOf)
    const { included, excluded } = filterResult

    // --- Bundle files ---
    const criteria = request.criteria ?? criteriaForBundle(included, RULE_PACKS)
    const bundles = bundleFiles(included, criteria, this.deps.estimateTokens)
    assertCoverage(included, bundles)

    // Update review.requested with real bundle count
    this.deps.hub.emit('review.requested', {
      runId: request.runId,
      fileCount: included.length,
      bundleCount: bundles.length,
    })

    // --- Process each bundle ---
    const allFindings: PositionedFinding[] = []
    const allDropped: ReviewDrop[] = []
    const allReflections: ReviewReflection[] = []
    let requestCount = 0

    const fileContents = new Map<string, string>()

    for (const bundle of bundles) {
      this.deps.hub.emit('review.bundle.started', {
        bundleId: bundle.id,
        files: [...bundle.files],
      })

      // Read file contents for this bundle
      for (const file of bundle.files) {
        if (!fileContents.has(file)) {
          try {
            // file is already WORKSPACE-relative (e.g. WORKSPACE/src/app.ts)
            const content = await this.deps.commons.read(file)
            fileContents.set(file, content)
          } catch {
            // File not readable — skip
          }
        }
      }

      // Build review prompt
      const prompt = this.buildReviewPrompt(bundle)

      // Call f02 transport directly (R3: not through f07 task/claim queue)
      const rawOutput = await this.callTransport(bundle.id, prompt)
      requestCount++

      // Parse LLM output as raw findings
      const rawFindings = this.parseReviewOutput(rawOutput)

      // Position findings (re-anchor to exact line)
      const { positioned, unanchored } = positionFindings(rawFindings, fileContents)

      // Record unanchored as dropped
      for (const uf of unanchored) {
        allDropped.push({
          id: `${bundle.id}-${uf.ruleId}-${uf.path}:${uf.line}`,
          path: uf.path,
          line: uf.line,
          ruleId: uf.ruleId,
          reason: 'unanchored',
        })
      }

      // Build criteria lookup by ruleId
      const criteriaById = new Map(bundle.criteria.map((c) => [c.id, c]))

      // Reflect findings (second-pass confirm/deny)
      const reflectInputs = positioned.map((p) => {
        const criterion = criteriaById.get(p.finding.ruleId)
        return {
          finding: {
            id: `${bundle.id}-${p.finding.ruleId}-${p.finding.path}:${p.finding.line}`,
            ruleId: p.finding.ruleId,
            severity: criterion?.severity ?? 'medium',
            path: p.finding.path,
            line: p.finding.line,
            evidence: p.evidence,
            message: p.finding.message,
            patchStrategy: p.finding.patchStrategy,
            blocking: criterion?.severity === 'critical' || criterion?.severity === 'high',
            disposition: 'anchored' as const,
          },
          fileContent: fileContents.get(p.finding.path) ?? '',
          ruleHint: criterion?.promptHint ?? '',
        }
      })

      const reflectPrompt = buildReflectPrompt(reflectInputs)
      const reflectOutput = await this.callTransport(`${bundle.id}-reflect`, reflectPrompt)
      requestCount++

      const reflectVerdicts = parseReflectOutput(reflectOutput)
      const verdictMap = new Map<string, 'confirmed' | 'denied'>()
      for (const v of reflectVerdicts) {
        verdictMap.set(v.findingId, v.verdict)
      }

      // Build positioned findings with reflection verdicts
      for (const p of positioned) {
        const fid = `${bundle.id}-${p.finding.ruleId}-${p.finding.path}:${p.finding.line}`
        const verdict = verdictMap.get(fid) ?? 'confirmed'

        const criterion = criteriaById.get(p.finding.ruleId)
        const finding: PositionedFinding = {
          id: fid,
          ruleId: p.finding.ruleId,
          severity: criterion?.severity ?? 'medium',
          path: p.finding.path,
          line: p.finding.line,
          evidence: p.evidence,
          message: p.finding.message,
          patchStrategy: p.finding.patchStrategy,
          blocking: criterion?.severity === 'critical' || criterion?.severity === 'high',
          disposition: 'anchored',
          reflection: verdict,
        }

        allReflections.push({ findingId: fid, verdict })

        if (verdict === 'confirmed') {
          allFindings.push(finding)
        } else {
          allDropped.push({
            id: fid,
            path: finding.path,
            line: finding.line,
            ruleId: finding.ruleId,
            reason: 'denied',
          })
        }
      }

      this.deps.hub.emit('review.bundle.done', {
        bundleId: bundle.id,
        files: [...bundle.files],
        findings: allFindings.length,
        dropped: allDropped.length,
      })
    }

    // --- Persist findings via the wiring seam: f11's PersistedFinding[] is
    // translated to the canonical f08 shape by the single wiring adapter.
    // The `detector` field carries the REVIEWER MODEL's id — the model that ran
    // this review call (R13: never the rule id).
    const f08Findings: PersistedFinding[] = allFindings.map((f) => ({
      id: f.id,
      ruleId: f.ruleId,
      severity: f.severity,
      path: f.path,
      ...(f.line !== undefined ? { line: f.line } : {}),
      detector: this.deps.reviewModelId,
      resolved: false,
      evidence: f.evidence,
      message: f.message,
      patchStrategy: f.patchStrategy,
      blocking: f.blocking,
    }))
    await this.deps.persistFindings(f08Findings)

    // --- Escalate unpatchable criticals to ReviewQueue (f08 path) ---
    const unpatchableCritical = allFindings.filter(
      (f) => f.severity === 'critical' && !f.patchStrategy,
    )
    for (const f of unpatchableCritical) {
      await this.deps.escalationQueue.push({
        id: `ESC-${f.id}`,
        kind: 'security-escalation',
        folder: 'audit',
        findingId: f.id,
        ruleId: f.ruleId,
        severity: f.severity,
        path: f.path,
        line: f.line,
        detectorModelId: this.deps.reviewModelId,
        reason: 'no-patch-strategy',
        rounds: 0,
        detail: `Rule ${f.ruleId} declares no patchStrategy; requires lead judgement.`,
        evidence: f.evidence,
        createdAt: new Date().toISOString(),
      })
    }

    // --- Emit review.completed ---
    this.deps.hub.emit('review.completed', {
      runId: request.runId,
      requests: requestCount,
      bundles: bundles.map((b) => ({ id: b.id, files: [...b.files], tokenEstimate: b.tokenEstimate })),
      findings: allFindings.length,
      dropped: allDropped.length,
      reflections: allReflections.length,
    })

    // --- Write audit file STATE/folder-11/reviews/<runId>.json ---
    const audit = {
      runId: request.runId,
      brief: request.brief,
      goalState: request.goalState,
      filesIncluded: included,
      filesExcluded: excluded,
      bundles: bundles.map((b) => ({ id: b.id, files: [...b.files], tokenEstimate: b.tokenEstimate })),
      findings: allFindings,
      dropped: allDropped,
      reflections: allReflections,
      createdAt: new Date().toISOString(),
    }
    const auditContent = JSON.stringify(audit, null, 2)
    let current = ''
    try {
      current = await this.deps.commons.read(`STATE/folder-11/reviews/${request.runId}.json`)
    } catch {
      // not found — first write
    }
    // commons counts lines the way splitLines does: a trailing newline does
    // NOT start a new line. Counting it here inflated removedLineCount by one
    // on every rewrite and threw 'diff out of range' on the second audit.
    const currentLines = current === ''
      ? 0
      : current.split(/\r?\n/).length - (current.endsWith('\n') ? 1 : 0)
    await this.deps.commons.write({
      path: `STATE/folder-11/reviews/${request.runId}.json`,
      diff: {
        added: auditContent.split('\n'),
        removedLineCount: currentLines,
        atLine: 1,
      },
      intent: 'review audit',
      author: 'review-agent',
    })

    return {
      runId: request.runId,
      requests: requestCount,
      bundles,
      findings: allFindings,
      dropped: allDropped,
      reflections: allReflections,
    }
  }

  private buildReviewPrompt(bundle: ReviewBundle): string {
    const lines: string[] = []
    lines.push('You are a senior security reviewer reviewing code changes.')
    lines.push('')
    lines.push('Files under review:')
    for (const file of bundle.files) {
      lines.push(`- ${file}`)
    }
    lines.push('')
    lines.push('Review criteria (match any that apply):')
    for (const c of bundle.criteria) {
      lines.push(`- ${c.id} (${c.severity}): ${c.promptHint}`)
    }
    lines.push('')
    lines.push('For each finding you detect, output a JSON object:')
    lines.push('{"ruleId": "SEC-004", "path": "WORKSPACE/src/app.ts", "line": 4, "evidence": "const API_TOKEN = \"sk-...\"", "message": "Hardcoded API token in source code"}')
    lines.push('')
    lines.push('Output ONLY a JSON array of findings, no markdown fences, no other text.')
    lines.push('If no findings, output: []')

    return lines.join('\n')
  }

  /**
   * Phase E3-REPAIR (R24, completing the family): the reviewer call consumes the
   * full canonical phase-02 chunk grammar, exactly as the crew worker (E1/R21),
   * the leader adapter (E2/R24) and the shared compactor helper (E3/R24) now do.
   *   - text chunks are collected and concatenated;
   *   - `usage` chunks are consumed and deliberately DROPPED. There is no usage
   *     sink on this path today, and adding one would double-count against the
   *     phase-02 usage layer and the shell's transport wrapper (same reasoning
   *     as E3). They are never concatenated into the answer either way;
   *   - the FIRST `done` breaks the iteration; a post-done chunk is never read.
   *
   * This matters MORE here than on the other three paths: the answer to this
   * call is FINDINGS JSON, parsed by parseReviewOutput / parseReflectOutput.
   * A real adapter always terminates with `{type:'done'}`, and a post-done chunk
   * appended to the array would make the JSON unparsable and silently yield zero
   * findings - a review that reports "clean" because it could not read its own
   * output. That is the exact corruption R24 exists to prevent.
   */
  private async callTransport(bundleId: string, prompt: string): Promise<string> {
    const chunks: string[] = []
    for await (const chunk of this.deps.transport.complete({
      modelId: this.deps.reviewModelId,
      system: this.deps.reviewerSystemPrompt ?? BUILT_IN_REVIEWER_SYSTEM_PROMPT,
      messages: [{ role: 'user' as const, content: prompt }],
    })) {
      if (chunk.type === 'text') { chunks.push(chunk.text); continue }
      // usage: consumed and dropped on purpose - see the note above.
      if (chunk.type === 'done') break
    }
    return chunks.join('')
  }

  private parseReviewOutput(text: string): RawFinding[] {
    const cleaned = text.trim()
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(cleaned)
    const candidate = fenced && fenced[1] !== undefined ? fenced[1].trim() : cleaned

    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item: any) => item && item.ruleId && item.path && item.line !== undefined)
          .map((item: any) => ({
            ruleId: String(item.ruleId),
            path: String(item.path),
            line: Number(item.line),
            evidence: String(item.evidence ?? ''),
            message: String(item.message ?? item.ruleId),
            patchStrategy: item.patchStrategy,
          }))
      }
    } catch {
      // fall through
    }
    return []
  }
}
