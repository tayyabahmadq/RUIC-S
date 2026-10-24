/**
 * Opus//DECK — Phase 4: The Compactor.
 * Type contracts for what the compactor expects from other phases.
 */

export type SectionName = 'ARCH' | 'IFACE' | 'OPEN' | 'SETTLED' | 'PINS'

export const SECTION_NAMES: readonly SectionName[] = ['ARCH', 'IFACE', 'OPEN', 'SETTLED', 'PINS']

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmRequest {
  system?: string
  messages: LlmMessage[]
  model?: string
  maxTokens?: number
  temperature?: number
}

export interface LlmResponse {
  text: string
  tokensIn?: number
  tokensOut?: number
  model?: string
}

/** Transport used by the compactor (chat-based). Adapted from phase 2 in wiring. */
export interface Transport {
  chat(req: LlmRequest): Promise<LlmResponse>
}

/** Commons used by the compactor (root-relative paths). Adapted from phase 3 in wiring. */
export interface Commons {
  read(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  write(path: string, content: string): Promise<void>
  append(path: string, content: string): Promise<void>
  list(dir: string): Promise<string[]>
}

export interface CompactionResult {
  beforeTokens: number
  afterTokens: number
  demotedToArchive: number
  ran: boolean
}

export interface CompactorOptions {
  digestTokenBudget?: number   // default 2000
  promptTokensBudget?: number  // default 8000
  llmModel?: string            // default 'compactor-small'
  budgetCheckEvents?: string[] // default ['commons.changed','digest.updated']
}

export interface ReadRange {
  path: string
  startLine: number
  endLine: number
  lastUsed: number
  tokens?: number
}

/** Event bus used by the compactor (subscribe/emit). */
export interface EventBus {
  subscribe(event: string, handler: (payload: unknown) => void | Promise<void>): void
  emit(event: string, payload?: unknown): void | Promise<void>
}

export interface RangePointer {
  path: string
  startLine: number
  endLine: number
  pointer: string
}

export interface WorkingSetReduction {
  kept: ReadRange[]
  dropped: RangePointer[]
  tokensBefore: number
  tokensAfter: number
}
