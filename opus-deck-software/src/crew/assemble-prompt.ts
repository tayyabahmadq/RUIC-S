/**
 * Phase 7: Builds the five-slot engineering prompt.
 * Slots 1-4 are never trimmed. Slot 5 is trimmed to pointers when over budget.
 *
 * The compaction.requested emit goes on an injectable bus (args.bus) provided
 * by wiring — never an isolated module-default bus.
 */
import { type PresenceEntry, type Task, type WorkingSetEntry, type EventBus, type BuildPromptArgs } from './types.js'

const DEFAULT_PROMPT_TOKEN_BUDGET = 4000

let promptTokenBudget = DEFAULT_PROMPT_TOKEN_BUDGET

export function getPromptTokenBudget(): number {
  return promptTokenBudget
}

export function setPromptTokenBudget(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('promptTokenBudget must be a positive finite number')
  }
  promptTokenBudget = value
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function renderRange(entry: WorkingSetEntry): string {
  const start = entry.range?.startLine ?? entry.startLine
  const end = entry.range?.endLine ?? entry.endLine
  if (start === undefined || end === undefined) return ''
  return ` (lines ${start}-${end})`
}

function renderPresence(entries: readonly PresenceEntry[]): string {
  if (entries.length === 0) return 'none'
  return entries
    .map((entry) => {
      const status = entry.status ?? 'unknown'
      const claimed = entry.claimed && entry.claimed.length > 0 ? entry.claimed.join(',') : '-'
      return `${entry.modelId} | ${status} | claimed=${claimed}`
    })
    .join('\n')
}

function renderWorkingSetFull(entries: readonly WorkingSetEntry[]): string {
  if (entries.length === 0) return 'none'
  return entries
    .map((entry) => {
      const header = `### ${entry.path}${renderRange(entry)}`
      const body = entry.content ?? ''
      return body.length > 0 ? `${header}\n${body}` : `${header}\n[no cached content]`
    })
    .join('\n\n')
}

function renderWorkingSetPointers(entries: readonly WorkingSetEntry[]): string {
  if (entries.length === 0) return 'none'
  return entries
    .map((entry) => `- ${entry.path}${renderRange(entry)} [content omitted]`)
    .join('\n')
}

function taskDescription(task: Task): string {
  const description = task.description ?? task.title
  return description === undefined ? task.id : `${task.id}: ${description}`
}

/**
 * Section 6: the worker's execution protocol — the reasoning pattern distilled
 * from the Claude Code system prompt (read before write, smallest change,
 * verify-then-claim, rabbit-hole rule) and the GPT-5 factuality rules. Fixed
 * short content, counted in the token budget, present in both budget branches.
 */
const EXECUTION_PROTOCOL = [
  '## 6. Execution Protocol',
  '- Read before write: open the files your change touches and match their existing style.',
  '- Reason to the smallest change that satisfies the task; do not refactor beyond it.',
  '- Verify, then claim: re-run the check that proves the change works. If it fails, report the failure verbatim — never claim unverified success.',
  '- Rabbit hole rule: two or three failed attempts at the same approach means stop and reassess instead of retrying.',
].join('\n')

export function buildPrompt(args: BuildPromptArgs): string {
  const slot1 = args.brief
  const slot2 = args.digest
  const slot3 = renderPresence(args.presence)
  const claimSet = args.task.claimSet ?? args.task.locks ?? []
  const slot4 = [
    `Task: ${taskDescription(args.task)}`,
    `Claim set: ${claimSet.length > 0 ? claimSet.join(', ') : 'none'}`,
  ].join('\n')
  const slot5Full = renderWorkingSetFull(args.workingSet)

  const fullPrompt = [
    '## 1. BRIEF.md',
    slot1,
    '## 2. STATE/digest.md',
    slot2,
    '## 3. Presence',
    slot3,
    '## 4. My Task',
    slot4,
    '## 5. Working Set',
    slot5Full,
    EXECUTION_PROTOCOL,
  ].join('\n\n')

  if (estimateTokens(fullPrompt) > promptTokenBudget) {
    // Budget overflow: request compaction on the shared (injected) bus.
    // Slots 1-4 are never trimmed; slot 5 becomes pointers only. The fixed
    // execution protocol is kept in both branches.
    args.bus?.emit('compaction.requested', {
      estimatedTokens: estimateTokens(fullPrompt),
      budget: promptTokenBudget,
    })
    return [
      '## 1. BRIEF.md',
      slot1,
      '## 2. STATE/digest.md',
      slot2,
      '## 3. Presence',
      slot3,
      '## 4. My Task',
      slot4,
      '## 5. Working Set',
      renderWorkingSetPointers(args.workingSet),
      EXECUTION_PROTOCOL,
    ].join('\n\n')
  }

  return fullPrompt
}

export { buildPrompt as assemblePrompt }
