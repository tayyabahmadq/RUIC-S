/**
 * Configuration of the OpusDeck runtime.
 * Validation is performed with zod; on failure a single CommonsError lists
 * ALL invalid fields at once (field + reason) instead of one error per field.
 */
import path from 'path'
import { z } from 'zod'
import { CommonsError } from './errors.js'
import type {
  ModelRef,
  OpusDeckConfig,
  ResolvedBudgets,
  ResolvedConfig,
  ResolvedCrew,
} from './types.js'
import { BRIEF, DECISIONS, DIGEST, PRESENCE, TASKS, FINDINGS, WORKSPACE, DELTA, ARCHIVE, TXN_LOG } from './paths.js'

export const DEFAULT_DIGEST_TOKENS = 2000
export const DEFAULT_PROMPT_TOKENS = 6000

const providerValues = ['openai-compatible', 'anthropic', 'custom'] as const
const speedValues = ['fast', 'standard', 'heavy'] as const
const reasoningEffortValues = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const modelRefSchema = z.object({
  id: z.string().min(1, 'model id must be a non-empty string'),
  provider: z.enum(providerValues),
  endpoint: z.string().optional(),
  model: z.string().min(1, 'model name must be a non-empty string'),
  apiKeyEnv: z.string().optional(),
  contextWindowTokens: z.number().int().positive('contextWindowTokens must be a positive integer'),
  speedClass: z.enum(speedValues).optional(),
  reasoningEffort: z.enum(reasoningEffortValues).optional(),
})

const crewSchema = z.object({
  lead: modelRefSchema,
  engineers: z.array(modelRefSchema).min(1, 'crew must declare at least one engineer'),
  security: z.array(modelRefSchema).min(2, 'security gate requires at least two models'),
})

const budgetsSchema = z.object({
  digestTokens: z.number().int().positive().default(DEFAULT_DIGEST_TOKENS),
  promptTokens: z.number().int().positive().default(DEFAULT_PROMPT_TOKENS),
})

const opusDeckConfigSchema = z.object({
  memoryDir: z.string().min(1, 'memoryDir must be a non-empty string'),
  outputDir: z.string().min(1, 'outputDir must be a non-empty string'),
  brief: z.string().min(1, 'brief must be a non-empty string'),
  goalState: z.array(z.string().min(1)).min(1, 'goalState must declare at least one criterion'),
  crew: crewSchema,
  budgets: budgetsSchema.optional(),
})

export function resolveOpusDeckConfig(config: OpusDeckConfig): ResolvedConfig {
  const result = opusDeckConfigSchema.safeParse(config)
  if (!result.success) {
    throw invalidConfigError(result.error)
  }

  const parsed = result.data

  const crew: ResolvedCrew = {
    lead: parsed.crew.lead,
    engineers: parsed.crew.engineers,
    security: parsed.crew.security,
  }

  const budgets: ResolvedBudgets = {
    digestTokens: parsed.budgets?.digestTokens ?? DEFAULT_DIGEST_TOKENS,
    promptTokens: parsed.budgets?.promptTokens ?? DEFAULT_PROMPT_TOKENS,
  }

  return {
    memoryDir: path.resolve(parsed.memoryDir),
    outputDir: path.resolve(parsed.outputDir),
    brief: parsed.brief,
    goalState: parsed.goalState,
    crew,
    budgets,
  }
}

function invalidConfigError(error: z.ZodError): CommonsError {
  const fields: string[] = []
  for (const issue of error.errors) {
    const field = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    fields.push(`${field}: ${issue.message}`)
  }
  const detail = `invalid fields -> ${fields.join('; ')}`
  return new CommonsError('config.invalid', `Invalid OpusDeckConfig (${fields.length} problem(s) found): ${detail}`, {
    detail,
  })
}

export type { ModelRef, OpusDeckConfig, ResolvedBudgets, ResolvedConfig, ResolvedCrew }

export {
  BRIEF,
  DECISIONS,
  DIGEST,
  PRESENCE,
  TASKS,
  FINDINGS,
  WORKSPACE,
  DELTA,
  ARCHIVE,
  TXN_LOG,
}
