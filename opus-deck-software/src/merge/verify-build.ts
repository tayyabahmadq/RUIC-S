/**
 * Phase 9: pre-merge gate.
 * checkReadiness(): critical findings, goal verification, dangling locks.
 * Dangling locks read from STATE/tasks.json claim rows (the authority).
 */
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { z } from 'zod'
import { CommonsError } from './errors.js'
import { normalizeRel, pathExists, walkFiles } from './fs-utils.js'
import type {
  ClaimRecord, Finding, GateCheck, TransactionRecord, VerificationResult, GoalCriterion,
} from './types.js'

const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low'])

const FindingSchema = z.object({
  id: z.string().min(1),
  severity: SeveritySchema,
  path: z.string().min(1),
  line: z.number().int().nonnegative().optional(),
  detector: z.string().min(1),
  resolved: z.boolean(),
})

const FindingsFileSchema = z.union([z.array(FindingSchema), z.object({ findings: z.array(FindingSchema) })])

const GoalCriterionSchema = z.object({ id: z.string().min(1), description: z.string().min(1) })
const GoalFileSchema = z.union([z.object({ criteria: z.array(GoalCriterionSchema) }), z.array(GoalCriterionSchema)])

const VerificationSchema = z.object({
  criterionId: z.string().min(1),
  status: z.enum(['satisfied', 'documented', 'pending']),
  evidence: z.string().optional(),
})
const VerificationFileSchema = z.union([z.object({ results: z.array(VerificationSchema) }), z.array(VerificationSchema)])

const ClaimSchema = z.object({
  holder: z.string().min(1),
  path: z.string().optional(),
  txn: z.string().optional(),
  released: z.boolean(),
})

async function readJsonFile(file: string): Promise<unknown | null> {
  if (!(await pathExists(file))) return null
  const raw = await fs.promises.readFile(file, 'utf8')
  if (raw.trim().length === 0) return null
  try { return JSON.parse(raw) as unknown } catch (err) {
    throw new CommonsError(`unparsable JSON: ${file}`, 'UNPARSABLE_JSON', err instanceof Error ? err.message : String(err))
  }
}

export async function loadFindings(memoryDir: string): Promise<Finding[]> {
  const file = path.join(memoryDir, 'STATE', 'findings.json')
  const data = await readJsonFile(file)
  if (data === null) return []
  const parsed = FindingsFileSchema.safeParse(data)
  if (!parsed.success) {
    throw new CommonsError(`invalid findings file: ${file}`, 'INVALID_FINDINGS', parsed.error.message)
  }
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.findings
}

export async function loadCriteria(memoryDir: string): Promise<GoalCriterion[]> {
  const candidates = [path.join(memoryDir, 'STATE', 'goal-state.json'), path.join(memoryDir, 'STATE', 'goals.json')]
  for (const file of candidates) {
    const data = await readJsonFile(file)
    if (data === null) continue
    const parsed = GoalFileSchema.safeParse(data)
    if (!parsed.success) {
      throw new CommonsError(`invalid goal-state file: ${file}`, 'INVALID_GOALS', parsed.error.message)
    }
    return Array.isArray(parsed.data) ? parsed.data : parsed.data.criteria
  }
  return []
}

export async function loadVerifications(memoryDir: string): Promise<VerificationResult[]> {
  const candidates = [path.join(memoryDir, 'STATE', 'verification.json'), path.join(memoryDir, 'STATE', 'verifications.json')]
  for (const file of candidates) {
    const data = await readJsonFile(file)
    if (data === null) continue
    const parsed = VerificationFileSchema.safeParse(data)
    if (!parsed.success) {
      throw new CommonsError(`invalid verification file: ${file}`, 'INVALID_VERIFICATION', parsed.error.message)
    }
    return Array.isArray(parsed.data) ? parsed.data : parsed.data.results
  }
  return []
}

/** Claims (locks) are read from STATE/tasks.json claim rows — the authority.
 * presence.json is the heartbeat table and says nothing about locks. */
export async function loadClaims(memoryDir: string): Promise<ClaimRecord[]> {
  const file = path.join(memoryDir, 'STATE', 'tasks.json')
  const data = await readJsonFile(file)
  if (data === null) return []
  if (!Array.isArray(data)) {
    throw new CommonsError(`invalid tasks file: ${file}`, 'INVALID_TASKS', 'STATE/tasks.json must be an array of task/claim rows')
  }
  const claims: ClaimRecord[] = []
  for (let index = 0; index < data.length; index++) {
    const row = data[index] as unknown
    if (typeof row !== 'object' || row === null || (row as Record<string, unknown>)['kind'] !== 'claim') continue
    const parsed = ClaimSchema.safeParse(row)
    if (!parsed.success) {
      // tolerant read: coordination writes {kind:'claim', modelId, path, createdAt}
      const r = row as Record<string, unknown>
      const holder = typeof r.holder === 'string' ? r.holder : (typeof r.modelId === 'string' ? r.modelId : undefined)
      if (!holder) continue
      claims.push({ holder, path: typeof r.path === 'string' ? r.path : undefined, txn: typeof r.txn === 'string' ? r.txn : undefined, released: Boolean(r.released) })
      continue
    }
    claims.push({ holder: parsed.data.holder, path: parsed.data.path, txn: parsed.data.txn, released: parsed.data.released ?? false })
  }
  return claims
}

export async function loadTransactions(memoryDir: string): Promise<TransactionRecord[]> {
  const deltaDir = path.join(memoryDir, 'DELTA')
  if (!(await pathExists(deltaDir))) return []
  const entries = await fs.promises.readdir(deltaDir, { withFileTypes: true })
  const txns: TransactionRecord[] = []
  const TxnFileSchema = z.object({
    id: z.string().min(1),
    timestamp: z.string().min(1),
    author: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    files: z.union([z.array(z.string()), z.array(z.object({ path: z.string() }))]).optional(),
    paths: z.array(z.string()).optional(),
  })
  async function parseTxnFile(file: string): Promise<void> {
    const data = await readJsonFile(file)
    if (data === null) return
    const parsed = TxnFileSchema.safeParse(data)
    if (!parsed.success) return
    const t = parsed.data
    const rawFiles: string[] = []
    if (t.files !== undefined) {
      for (const f of t.files) rawFiles.push(typeof f === 'string' ? f : f.path)
    }
    if (t.paths !== undefined) rawFiles.push(...t.paths)
    txns.push({ id: t.id, timestamp: t.timestamp, author: t.author ?? t.model ?? 'unknown', files: rawFiles.map((f) => normalizeRel(f)) })
  }
  for (const e of entries) {
    const full = path.join(deltaDir, e.name)
    if (e.isFile() && e.name.endsWith('.json')) await parseTxnFile(full)
    else if (e.isDirectory()) {
      const meta = path.join(full, 'meta.json')
      if (await pathExists(meta)) await parseTxnFile(meta)
      else {
        const snapDir = path.join(full, 'files')
        const base = (await pathExists(snapDir)) ? snapDir : full
        const snapped = (await walkFiles(base)).filter((f) => f !== 'meta.json')
        if (snapped.length > 0) {
          txns.push({ id: e.name, timestamp: e.name, author: 'unknown', files: snapped.map((f) => normalizeRel(f)) })
        }
      }
    }
  }
  txns.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id < b.id ? -1 : 1))
  return txns
}

export function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function isGatePassed(checks: GateCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.passed)
}

/**
 * Phase 3 (gate severity, R5): the merge gate's severity-thresholded blocking.
 * THE resolved `gate.failOn` value is injected once at wiring; the gate blocks
 * on every unresolved finding AT OR ABOVE it. The default ("critical") is the
 * shipped behavior: only critical findings block.
 */
export type GateSeverity = 'critical' | 'high' | 'medium' | 'low'

export const DEFAULT_GATE_SEVERITY: GateSeverity = 'critical'

const GATE_SEVERITY_ORDER: readonly GateSeverity[] = ['critical', 'high', 'medium', 'low']

export function atOrAboveGateSeverity(severity: GateSeverity, failOn: GateSeverity): boolean {
  return GATE_SEVERITY_ORDER.indexOf(severity) <= GATE_SEVERITY_ORDER.indexOf(failOn)
}

export interface ReadinessOptions {
  readonly failOn?: GateSeverity
}

export async function checkReadiness(memoryDir: string, options: ReadinessOptions = {}): Promise<GateCheck[]> {
  if (!(await pathExists(memoryDir))) {
    throw new CommonsError(`memory dir not found: ${memoryDir}`, 'MEMORY_DIR_MISSING')
  }

  const failOn: GateSeverity = options.failOn ?? DEFAULT_GATE_SEVERITY
  const findings = await loadFindings(memoryDir)
  const blockingFindings = findings.filter((f) => !f.resolved && atOrAboveGateSeverity(f.severity, failOn))

  const criteria = await loadCriteria(memoryDir)
  const verifications = await loadVerifications(memoryDir)
  const okStatuses = new Set(['satisfied', 'documented'])
  const verifiedIds = new Set(verifications.filter((v) => okStatuses.has(v.status)).map((v) => v.criterionId))
  const missing = criteria.filter((c) => !verifiedIds.has(c.id))

  const claims = await loadClaims(memoryDir)
  const dangling = claims.filter((c) => !c.released)

  const checks: GateCheck[] = [
    {
      id: 'critical-findings',
      name: failOn === 'critical'
        ? 'zero unresolved critical findings'
        : `zero unresolved findings at or above '${failOn}'`,
      passed: blockingFindings.length === 0,
      detail: blockingFindings.length === 0
        ? failOn === 'critical'
          ? `0 unresolved critical (${findings.length} total findings)`
          : `0 unresolved at or above ${failOn} (${findings.length} total findings)`
        : failOn === 'critical'
          ? `${blockingFindings.length} unresolved critical: ${blockingFindings.map((f) => f.id).join(', ')}`
          : `${blockingFindings.length} unresolved at or above ${failOn}: ${blockingFindings.map((f) => f.id).join(', ')}`,
    },
    {
      id: 'goal-verification', name: 'every goalState criterion has a verification result',
      passed: missing.length === 0,
      detail: criteria.length === 0 ? 'no criteria defined (vacuously satisfied)'
        : missing.length === 0 ? `${criteria.length} criteria all verified (${verifications.length} results)`
        : `${missing.length}/${criteria.length} criteria unverified: ${missing.map((c) => c.id).join(', ')}`,
    },
    {
      id: 'dangling-locks', name: 'zero dangling locks',
      passed: dangling.length === 0,
      detail: dangling.length === 0 ? `0 dangling (${claims.length} total claims)`
        : `${dangling.length} dangling: ${dangling.map((c) => `${c.holder}${c.path ? `:${c.path}` : ''}`).join(', ')}`,
    },
  ]
  return checks
}
