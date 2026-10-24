/**
 * Opus//DECK — Phase 11: Review Agent (f11) — reflect.
 * Build reflection prompts and parse second-pass model output.
 * Denied findings are recorded as 'denied' audit rows and dropped.
 */
import type { PositionedFinding } from './types.js'

export interface ReflectFindingInput {
  finding: PositionedFinding
  fileContent: string
  ruleHint: string
}

export function buildReflectPrompt(inputs: ReflectFindingInput[]): string {
  const lines: string[] = []
  lines.push(
    'Review the following candidate security findings. For each, confirm it is a real defect',
    'or deny it as a false positive. Respond with a JSON array where each entry has:',
    '  - findingId: the finding id',
    '  - verdict: "confirmed" or "denied"',
    '  - reason: brief explanation',
    '',
  )
  lines.push('Findings:')

  for (const input of inputs) {
    const linesOfFile = input.fileContent.split('\n')
    const lineContent = linesOfFile[input.finding.line - 1] || '(line not found)'
    lines.push(`- ${input.finding.id}: ${input.finding.ruleId} at ${input.finding.path}:${input.finding.line}`)
    lines.push(`  Evidence: ${input.finding.evidence}`)
    lines.push(`  Code context: ${lineContent}`)
    lines.push('')
  }

  return lines.join('\n')
}

export function parseReflectOutput(text: string): Array<{ findingId: string; verdict: 'confirmed' | 'denied' }> {
  const cleaned = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(cleaned)
  const candidate = fenced && fenced[1] !== undefined ? fenced[1].trim() : cleaned

  try {
    const parsed = JSON.parse(candidate)
    if (Array.isArray(parsed)) {
      return parsed.map((item: any) => ({
        findingId: String(item.findingId),
        verdict: item.verdict === 'denied' ? 'denied' : 'confirmed',
      }))
    }
  } catch {
    // fall through — deny all if unparseable
  }

  return []
}
