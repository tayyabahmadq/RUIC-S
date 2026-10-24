/**
 * Phase 8: rule implementations (pure predicates).
 */
import type { Rule, Severity, RuleId, PatchStrategy } from './types.js'

export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low']
export const SECRET_MIN_LENGTH = 8

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function isCommentLine(line: string): boolean {
  return /^\s*\/\//.test(line) || /^\s*\*/.test(line) || /^\s*\*/.test(line)
}

const NON_GLOBAL_FLAGS = ''

function makeTest(re: RegExp): (line: string) => boolean {
  return (line) => re.test(line)
}

export const RULES: readonly Rule[] = Object.freeze([
  {
    id: 'SEC-001' as RuleId,
    title: 'eval() / new Function()',
    severity: 'critical' as Severity,
    detectors: ['any'] as const,
    test: makeTest(/\b(eval\s*\(|window\.eval\s*\(|\.eval\s*\(|new\s+Function\s*\()/) ,
    guidance: 'Remove eval()/new Function(); use JSON.parse or a safe alternative.',
  },
  {
    id: 'SEC-002' as RuleId,
    title: 'innerHTML / insertAdjacentHTML with unescaped interpolation',
    severity: 'high' as Severity,
    detectors: ['any'] as const,
    patchStrategy: 'escape' as PatchStrategy,
    test: makeTest(/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\s*=/),
    fileTest: (content: string) => /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\s*=/.test(content),
    guidance: 'Escape interpolated values or use textContent instead of HTML sinks.',
  },
  {
    id: 'SEC-003' as RuleId,
    title: 'SQL by concatenation',
    severity: 'high' as Severity,
    detectors: ['any'] as const,
    test: makeTest(/\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b/i),
    fileTest: (content: string) => /\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b/i.test(content),
    guidance: 'Use parameterized queries / prepared statements instead of string concatenation.',
  },
  {
    id: 'SEC-004' as RuleId,
    title: 'Hardcoded secret',
    severity: 'critical' as Severity,
    detectors: ['any'] as const,
    patchStrategy: 'env-var' as PatchStrategy,
    test: makeTest(/(api[_-]?key|secret|token|password|passwd|credential|private[_-]?key|client[_-]?secret)\s*[:=]\s*['"][^'"]{8,}['"]/i),
    fileTest: (content: string) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content),
    guidance: 'Read secrets from environment variables or a secret store at runtime.',
  },
  {
    id: 'SEC-005' as RuleId,
    title: 'Insecure transport (http://)',
    severity: 'medium' as Severity,
    detectors: ['any'] as const,
    patchStrategy: 'https' as PatchStrategy,
    test: makeTest(/http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/),
    guidance: 'Upgrade endpoints to https://.',
  },
  {
    id: 'SEC-006' as RuleId,
    title: 'Math.random for security values',
    severity: 'medium' as Severity,
    detectors: ['any'] as const,
    patchStrategy: 'crypto-random' as PatchStrategy,
    test: makeTest(/\bMath\.random\s*\(/),
    guidance: 'Use node:crypto (randomBytes/randomUUID) instead of Math.random.',
  },
  {
    id: 'SEC-007' as RuleId,
    title: 'Non-constant-time password comparison',
    severity: 'medium' as Severity,
    detectors: ['any'] as const,
    test: makeTest(/(\b(pass|password|secret|token|credential)\b.*==|==.*\b(pass|password|secret|token|credential)\b)/i),
    fileTest: (content: string) => /===/.test(content) && /\b(compare|verify)\b/i.test(content),
    guidance: 'Use timingSafeEqual / bcrypt.compare / argon2.verify for secret comparison.',
  },
] as const)

export function escapeHtml_(value: string): string {
  return escapeHtml(value)
}
export function isCommentLine_(line: string): boolean {
  return isCommentLine(line)
}
