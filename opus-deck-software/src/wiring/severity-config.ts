/**
 * Opus//DECK — Phase 3 (integration roadmap): gate severity configuration.
 *
 * RULING R5 — ONE source for the gate severity threshold:
 *   explicitly-passed runtime config  ->  STATE/config.json  ->  "critical"
 * (the default equals shipped behavior). The file is validated with zod at
 * load; an invalid file fails fast with a precise error (file + key +
 * expected vs found) and aborts boot.
 *
 * The resolved value is injected ONCE at wiring and handed to both consumers:
 *   - the folder-09 merge gate's severity-thresholded blocking, and
 *   - the folder-08 audit escalation threshold.
 * Neither consumer parses STATE/config.json independently.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { CommonsError } from '../config/errors.js'

/** The severities `gate.failOn` accepts, most severe first. */
export const FAIL_ON_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export type FailOnSeverity = (typeof FAIL_ON_SEVERITIES)[number]

/** Shipped behavior: only critical findings block / escalate. */
export const DEFAULT_FAIL_ON: FailOnSeverity = 'critical'

/** Severity ordering: critical = 0 (most severe) .. low = 3. */
export const FAIL_ON_RANK: Record<FailOnSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

/** `true` when `severity` is at least as severe as the `failOn` threshold. */
export function atOrAboveFailOn(severity: FailOnSeverity, failOn: FailOnSeverity): boolean {
  return FAIL_ON_RANK[severity] <= FAIL_ON_RANK[failOn]
}

/** `<memoryDir>/STATE/config.json` — the single on-disk source. */
export const GATE_CONFIG_SEGMENTS = ['STATE', 'config.json'] as const

export function gateConfigPath(memoryDir: string): string {
  return path.join(memoryDir, ...GATE_CONFIG_SEGMENTS)
}

const GateConfigSchema = z
  .object({
    gate: z
      .object({ failOn: z.enum(['critical', 'high', 'medium', 'low']) })
      .strict(),
  })
  .strict()

export interface GateSeverityInput {
  /** Explicitly-passed runtime config (highest precedence). */
  readonly explicit?: unknown
  /** Memory dir holding STATE/config.json (second precedence). */
  readonly memoryDir?: string
}

function foundAt(json: unknown, segments: readonly PropertyKey[]): unknown {
  let cursor: unknown = json
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<PropertyKey, unknown>)[segment]
  }
  return cursor
}

function describeIssues(file: string, json: unknown, error: z.ZodError): string {
  const parts: string[] = []
  for (const issue of error.errors) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    const found = foundAt(json, issue.path)
    let expected: string
    if (issue.code === 'unrecognized_keys') {
      parts.push(`${key}: expected only the key(s) [${(issue as z.ZodUnrecognizedKeysIssue).keys.join(', ')}] to be absent, found extra key(s) [${issue.keys.join(', ')}]`)
      continue
    }
    if (issue.code === 'invalid_enum_value') {
      expected = `one of ${FAIL_ON_SEVERITIES.join('|')}`
    } else if (found === undefined) {
      expected = 'present'
    } else {
      expected = issue.message
    }
    parts.push(`${key}: expected ${expected}, found ${JSON.stringify(found)}`)
  }
  return parts.join('; ')
}

function invalidConfig(file: string, json: unknown, error: z.ZodError): CommonsError {
  const detail = describeIssues(file, json, error)
  return new CommonsError(
    'gate-config.invalid',
    `invalid gate severity config — ${file}: ${detail}`,
    { detail },
  )
}

/**
 * Resolve THE gate severity value (R5 precedence):
 * explicit runtime config > STATE/config.json > "critical".
 *
 * A missing file is the default, never an error; an INVALID file throws.
 */
export function resolveGateSeverity(input: GateSeverityInput = {}): FailOnSeverity {
  if (input.explicit !== undefined) {
    const parsed = z.enum(['critical', 'high', 'medium', 'low']).safeParse(input.explicit)
    if (!parsed.success) {
      const detail = `explicit gate.failOn: expected one of ${FAIL_ON_SEVERITIES.join('|')}, found ${JSON.stringify(input.explicit)}`
      throw new CommonsError('gate-config.invalid', `invalid gate severity config — ${detail}`, { detail })
    }
    return parsed.data
  }

  if (input.memoryDir === undefined) return DEFAULT_FAIL_ON

  const file = gateConfigPath(input.memoryDir)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_FAIL_ON
    throw new CommonsError(
      'gate-config.unreadable',
      `cannot read the gate severity config — ${file}: ${(err as Error).message}`,
      { detail: file },
    )
  }

  let json: unknown
  try {
    json = JSON.parse(raw) as unknown
  } catch (err) {
    const detail = `expected JSON shaped like {"gate":{"failOn":"critical"}}, found ${JSON.stringify(raw.slice(0, 120))} (${(err as Error).message})`
    throw new CommonsError('gate-config.invalid', `invalid gate severity config — ${file}: ${detail}`, { detail })
  }

  const parsed = GateConfigSchema.safeParse(json)
  if (!parsed.success) throw invalidConfig(file, json, parsed.error)
  return parsed.data.gate.failOn
}
