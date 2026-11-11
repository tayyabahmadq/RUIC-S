/**
 * Opus//DECK — Phase 11: Review Agent (f11) — position.
 * Re-anchor every finding to an exact line via deterministic content match.
 * Unanchorable findings are demoted with disposition 'unanchored'.
 */
import type { PositionedFinding } from './types.js'

export interface RawFinding {
  ruleId: string
  path: string
  line: number
  evidence: string
  message: string
  patchStrategy?: 'escape' | 'env-var' | 'https' | 'crypto-random'
}

export function positionFindings(
  rawFindings: RawFinding[],
  fileContents: Map<string, string>,
): {
  positioned: Array<{ finding: Omit<RawFinding, 'line'> & { line: number }; evidence: string }>
  unanchored: RawFinding[]
} {
  const positioned: Array<{ finding: Omit<RawFinding, 'line'> & { line: number }; evidence: string }> = []
  const unanchored: RawFinding[] = []

  for (const finding of rawFindings) {
    const content = fileContents.get(finding.path)
    if (!content) {
      unanchored.push(finding)
      continue
    }

    const lines = content.split('\n')
    const evidenceTrimmed = finding.evidence.trim()

    // Try the reported line first
    if (
      finding.line >= 1 &&
      finding.line <= lines.length &&
      lines[finding.line - 1].includes(evidenceTrimmed)
    ) {
      positioned.push({
        finding: { ...finding, line: finding.line },
        evidence: lines[finding.line - 1].trim(),
      })
      continue
    }

    // Search all lines for the evidence
    let foundLine = -1
    for (let li = 0; li < lines.length; li++) {
      if (lines[li].includes(evidenceTrimmed)) {
        foundLine = li + 1
        break
      }
    }

    if (foundLine > 0) {
      positioned.push({
        finding: { ...finding, line: foundLine },
        evidence: lines[foundLine - 1].trim(),
      })
    } else {
      unanchored.push(finding)
    }
  }

  return { positioned, unanchored }
}
