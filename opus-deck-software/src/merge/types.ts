/**
 * Opus//DECK — Phase 9: Merge & Build Engine.
 */
export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface Finding {
  id: string
  severity: Severity
  path: string
  line?: number
  detector: string
  resolved: boolean
}

export interface GoalCriterion { id: string; description: string }

export interface VerificationResult {
  criterionId: string
  status: 'satisfied' | 'documented' | 'pending'
  evidence?: string
}

export interface ClaimRecord {
  holder: string
  path?: string
  txn?: string
  released: boolean
}

export interface TransactionRecord {
  id: string
  timestamp: string
  author: string
  model?: string
  files: string[]
}

export interface ManifestEntry {
  path: string
  loc: number
  txn: string
  sha256: string
  bytes: number
}

export interface OverrideRecord { path: string; winner: string; losers: string[] }

export interface Manifest {
  version: 1
  createdAt: string
  memoryDir: string
  files: ManifestEntry[]
  overrides: OverrideRecord[]
  totalFiles: number
  totalLoc: number
}

export interface GateCheck {
  id: 'critical-findings' | 'goal-verification' | 'dangling-locks'
  name: string
  passed: boolean
  detail?: string
}

export interface ReportOptions {
  leadModel?: string
  timestamp?: string
  compactionCount?: number
  checksum?: string
  manifest?: Manifest
}

export interface StubSeed {
  leadModel?: string
  compactionCount?: number
  transactions?: Array<{
    id: string
    timestamp: string
    author: string
    files: Record<string, string>
  }>
  findings?: Finding[]
  criteria?: GoalCriterion[]
  verifications?: VerificationResult[]
  claims?: ClaimRecord[]
}

export interface StubMemoryInfo {
  memoryDir: string
  workspaceDir: string
  deltaDir: string
  stateDir: string
}

export const FOLDER: 'merge' = 'merge'
