/**
 * Phase 5: shared argument guards.
 */
import { CommonsError } from './errors.js'

export function requireModelId(modelId: unknown, code: string): string {
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new CommonsError(code, 'modelId must be a non-empty string', String(modelId))
  }
  return modelId
}

export function requireTimestamp(value: unknown, field: string, code: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CommonsError(code, `${field} must be a finite epoch-ms >= 0`, String(value))
  }
  return value
}

export function requireNonNegativeInt(value: unknown, field: string, code: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new CommonsError(code, `${field} must be an integer >= 0`, String(value))
  }
  return value
}

export function requirePositiveInt(value: unknown, field: string, code: string): number {
  const v = requireNonNegativeInt(value, field, code)
  if (v <= 0) {
    throw new CommonsError(code, `${field} must be a positive integer`, String(value))
  }
  return v
}
