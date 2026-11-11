/**
 * Opus//DECK — Phase 10: CLI & Surface.
 */
export type FolderId = 'cli'

export class CommonsError extends Error {
  readonly code: string
  readonly folder: FolderId = 'cli'
  readonly detail?: string

  constructor(code: string, message: string, detail?: string) {
    super(message)
    this.name = 'CommonsError'
    this.code = code
    if (detail !== undefined) {
      this.detail = detail
    }
  }
}

export interface Task {
  readonly id: string
  readonly title?: string
  readonly description?: string
  readonly status?: 'pending' | 'claimed' | 'completed' | 'failed' | 'retired'
  readonly claimSet?: readonly string[]
  readonly locks?: readonly string[]
  readonly priority?: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface PresenceEntry {
  readonly modelId: string
  readonly role?: string
  readonly status?: string
  readonly taskIds?: readonly string[]
  readonly claimed?: readonly string[]
  readonly lastSeen?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface WorkingSetEntry {
  readonly modelId?: string
  readonly path: string
  readonly startLine?: number
  readonly endLine?: number
  readonly range?: { readonly startLine: number; readonly endLine: number }
  readonly content?: string
  readonly pointer?: boolean
  readonly tokenCount?: number
  readonly updatedAt?: string
}

export type BusEvent =
  | 'run.started' | 'run.failed' | 'run.completed' | 'task.claimed' | 'task.completed'
  | 'task.failed' | 'task.retired' | 'finding.new' | 'finding.resolved'
  | 'phase.change' | 'token.use' | 'ctrl-c'

export interface RunConfig {
  readonly brief: string
  readonly goalState: string
  readonly crew: readonly string[]
  readonly keys?: Readonly<Record<string, string>>
}

export interface CommandHandler {
  (...args: readonly string[]): Promise<void> | void
}

export const SeverityColor: Readonly<Record<'critical' | 'high' | 'medium' | 'low', string>> = {
  critical: '\x1b[31m', high: '\x1b[31m', medium: '\x1b[33m', low: '\x1b[32m',
}
export const ResetColor = '\x1b[0m'

export function formatTokens(budget: number, used: number): string {
  const k = (n: number) => (n / 1000).toFixed(1) + 'k'
  return `${k(used)} / ${k(budget)}`
}

export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000
  const m = Math.floor(totalSeconds / 60)
  const s = (totalSeconds % 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}

export function formatSeverity(severity: 'critical' | 'high' | 'medium' | 'low', resolved: boolean): string {
  const color = SeverityColor[severity]
  const label = resolved ? `${severity} (resolved)` : severity
  return resolved ? `\x1b[90m${label}${ResetColor}` : `${color}${label}${ResetColor}`
}

export interface EventBus {
  emit(event: string, ...args: unknown[]): void
  on(event: string, handler: (...args: unknown[]) => void): void
  once(event: string, handler: (...args: unknown[]) => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
  publish?(event: string, ...args: unknown[]): void
  subscribe?(event: string, handler: (...args: unknown[]) => void): void
  waitFor?(event: string, timeoutMs?: number): Promise<unknown>
}
