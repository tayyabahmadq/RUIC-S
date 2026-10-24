/**
 * Opus//DECK — Phase 6: The Leader.
 * Orchestration brain: plan -> route -> verify -> signOff.
 * Every state change flows through commons; no in-memory truth.
 */
import { createHash } from 'crypto'
import { z } from 'zod'
import {
  Bus, Claims, Commons, CommonsError, ConfirmationGate, Conflict, Crew, Conflicts, Message,
  PlanInput, SignOff, Task, TaskSchema, Transport, VerificationResult,
} from './types.js'
import { ReviewQueue } from './review.js'

const TASKS_KEY = 'leader:tasks'
const BRIEF_KEY = 'leader:brief'
const GOAL_STATE_KEY = 'leader:goalState'
const CREW_KEY = 'leader:crew'
const ASSIGNMENTS_KEY = 'leader:assignments'
const VERIFY_CRITERIA_KEY = 'leader:verifyCriteria'
const VERIFICATIONS_KEY = 'leader:verifications'
const SIGNOFF_KEY = 'leader:signoff'
const LOG_KEY = 'leader:log'

function nowIso(): string {
  return new Date().toISOString()
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isTaskLike(item: unknown): item is Task {
  return item !== null && typeof item === 'object' && typeof (item as Task).id === 'string' && typeof (item as Task).path === 'string'
}

export class Leader {
  private readonly transport: Transport
  private readonly commons: Commons
  private readonly claims: Claims
  private readonly conflicts: Conflicts
  private readonly bus: Bus
  private readonly review: ReviewQueue
  /** Phase 3 (personas): the `lead` persona body; absent = shipped built-in prompt. */
  private readonly leadSystemPrompt?: string

  constructor(deps: { transport: Transport; commons: Commons; claims: Claims; conflicts: Conflicts; bus: Bus; confirmations?: ConfirmationGate; leadSystemPrompt?: string }) {
    this.transport = deps.transport
    this.commons = deps.commons
    this.claims = deps.claims
    this.conflicts = deps.conflicts
    this.bus = deps.bus
    this.leadSystemPrompt = deps.leadSystemPrompt
    this.review = new ReviewQueue({
      commons: deps.commons,
      bus: deps.bus,
      routeFollowUp: this.routeFollowUp,
      ...(deps.confirmations === undefined ? {} : { confirmations: deps.confirmations }),
    })
  }

  private readonly routeFollowUp = async (input: { path: string; description: string; acceptance: string[]; confirmationRef?: string }): Promise<Task> => {
    const stored = await this.storedTasks()
    const id = `T-${String(stored.length + 1).padStart(2, '0')}`
    const task: Task = { id, ...input }
    await this.route([task])
    const updated = [...stored, task]
    await this.commons.write(TASKS_KEY, updated)
    return task
  }

  get reviewQueue(): ReviewQueue {
    return this.review
  }

  async plan(input?: PlanInput): Promise<Task[]> {
    try {
      const state = input ?? (await this.planStateFromCommons())
      const stored = await this.storedTasks()
      if (stored.length > 0) return stored
      // The digest is the SAME source the worker's prompt slot 2 uses
      // (STATE/digest.md), so a rebuilt CODEMAP reaches plan() through the
      // normal digest path. The digest is already token-bounded by folder-04's
      // compactor (digestTokenBudget) — the existing budget machinery applies;
      // no new budget channel is introduced here.
      const digest = this.commons.readDigest?.() ?? ''
      const response = await this.transport.completion({
        modelId: state.crew.lead,
        messages: this.planMessages(state, digest),
      })
      const tasks = this.parsePlanTasks(response.text)
      await this.commons.write(BRIEF_KEY, state.brief)
      await this.commons.write(GOAL_STATE_KEY, state.goalState)
      await this.commons.write(CREW_KEY, state.crew)
      await this.commons.write(TASKS_KEY, tasks)
      await this.commons.append(LOG_KEY, { event: 'planned', taskCount: tasks.length, at: nowIso() })
      return tasks
    } catch (err) {
      if (err instanceof CommonsError) throw err
      throw new CommonsError('LEADER_PLAN_FAILED', `plan() failed: ${messageOf(err)}`, { detail: String(err), cause: err })
    }
  }

  async route(tasks?: Task[]): Promise<void> {
    try {
      const list = tasks ?? (await this.storedTasks())
      if (list.length === 0) {
        throw new CommonsError('LEADER_NO_TASKS', 'route() has no tasks; run plan() first or pass tasks.')
      }
      const crew = await this.requireCrew()
      const assignments: Record<string, string> = {}
      const load: Record<string, number> = {}
      for (const engineer of crew.engineers) load[engineer] = 0
      for (const task of list) {
        const holders = await this.claims.holdersOf(task.path)
        if (holders.length > 0) {
          await this.conflicts.record(task.path, task.id, holders)
          continue
        }
        const engineer = this.pickEngineer(crew.engineers, load, [])
        if (engineer === undefined) {
          await this.conflicts.record(task.path, task.id, [])
          continue
        }
        assignments[task.id] = engineer
        load[engineer] += 1
        await this.claims.claim(task.id, task.path, engineer)
      }
      await this.commons.write(ASSIGNMENTS_KEY, assignments)
      await this.drainQueue(list, crew, assignments, load)
    } catch (err) {
      if (err instanceof CommonsError) throw err
      throw new CommonsError('LEADER_ROUTE_FAILED', `route() failed: ${messageOf(err)}`, { detail: String(err), cause: err })
    }
  }

  async verify(criteria?: string[]): Promise<VerificationResult[]> {
    try {
      const list = criteria ?? (await this.storedCriteria())
      if (list.length === 0) {
        throw new CommonsError('LEADER_NO_CRITERIA', 'verify() requires criteria; pass them or store leader:verifyCriteria first.')
      }
      await this.requireCrew()
      const workspace = await this.snapshotWorkspace()
      const results: VerificationResult[] = []
      for (const criterion of list) {
        const response = await this.transport.completion({
          modelId: (await this.requireCrew()).lead,
          messages: this.verifyMessages(criterion, workspace),
        })
        results.push(this.parseVerifyVerdict(criterion, response.text))
      }
      await this.commons.write(VERIFY_CRITERIA_KEY, list)
      await this.commons.write(VERIFICATIONS_KEY, results)
      return results
    } catch (err) {
      if (err instanceof CommonsError) throw err
      throw new CommonsError('LEADER_VERIFY_FAILED', `verify() failed: ${messageOf(err)}`, { detail: String(err), cause: err })
    }
  }

  async signOff(): Promise<SignOff> {
    try {
      const files = (await this.commons.listWorkspace()).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      const fileMap: Record<string, string> = {}
      for (const file of files) {
        let content = ''
        try { content = await this.commons.readWorkspace(file.path) } catch { content = '' }
        fileMap[file.path] = createHash('sha256').update(content, 'utf8').digest('hex')
      }
      const payload = JSON.stringify(fileMap)
      const checksum = createHash('sha256').update(payload, 'utf8').digest('hex')
      const signOff: SignOff = { checksum, fileCount: files.length, generatedAt: nowIso() }
      await this.commons.write(SIGNOFF_KEY, signOff)
      await this.bus.emit('run.completed', { checksum, fileCount: signOff.fileCount, at: signOff.generatedAt })
      await this.commons.append(LOG_KEY, { event: 'signedOff', checksum, at: signOff.generatedAt })
      return signOff
    } catch (err) {
      if (err instanceof CommonsError) throw err
      throw new CommonsError('LEADER_SIGN_OFF_FAILED', `signOff() failed: ${messageOf(err)}`, { detail: String(err), cause: err })
    }
  }

  private async planStateFromCommons(): Promise<PlanInput> {
    const brief = await this.commons.read<string>(BRIEF_KEY)
    const goalState = await this.commons.read<string>(GOAL_STATE_KEY)
    const crew = await this.commons.read<Crew>(CREW_KEY)
    if (!brief || !goalState || !crew) {
      throw new CommonsError('LEADER_INCOMPLETE_STATE', 'plan() requires brief, goalState and crew; nothing found in commons', {
        detail: `brief=${Boolean(brief)} goalState=${Boolean(goalState)} crew=${Boolean(crew)}`,
      })
    }
    return { brief, goalState, crew }
  }

  private async storedTasks(): Promise<Task[]> {
    const value = await this.commons.read<unknown[]>(TASKS_KEY)
    return Array.isArray(value) ? value.filter(isTaskLike) : []
  }

  private async storedCriteria(): Promise<string[]> {
    const value = await this.commons.read<unknown[]>(VERIFY_CRITERIA_KEY)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  }

  private async requireCrew(): Promise<Crew> {
    const crew = await this.commons.read<Crew>(CREW_KEY)
    if (!crew || crew.engineers.length === 0) {
      throw new CommonsError('LEADER_NO_CREW', 'No crew configured in commons; run plan() first.')
    }
    return crew
  }

  private planMessages(state: PlanInput, digest: string): Message[] {
    return [
      // Phase 3 (personas): the `lead` persona body replaces the built-in
      // system prompt when a CREW/personas lead persona exists; otherwise the
      // shipped prompt is used verbatim (fallback is the zero-risk default).
      { role: 'system', content: this.leadSystemPrompt ?? 'You are the lead planner. Output ONLY a JSON array of task objects. Each task: { id, path, description, acceptance: string[] }. Exactly one WORKSPACE-relative path per task. No markdown fences.' },
      // The reasoning protocol rides in the USER message, not the system
      // prompt, so it applies in both configurations: the built-in system
      // prompt and a lead persona body (which replaces the system prompt
      // verbatim). Operational content — what to consider — rather than a
      // "think step by step" incantation, per the prompt-audit finding that
      // depth on reasoning models is controlled by effort configuration and
      // task structure, not prose steering.
      { role: 'user', content: `TASK_DECOMPOSITION\nCrew lead: ${state.crew.lead}\nEngineers: ${state.crew.engineers.join(', ')}\nBrief: ${state.brief}\nGoal state: ${state.goalState}\nREASONING PROTOCOL (work through this before emitting the array):\n1. Order matters: sequence tasks so each one only touches files created or edited by earlier tasks.\n2. Smallest viable set: pick the fewest WORKSPACE-relative paths that can reach the goal state; exactly one path per task.\n3. Every acceptance criterion must name the check that proves it — a file:line, a command, or a visible artifact.\n4. If two decompositions seem plausible, commit to one — a recommendation, not a survey.\nThen output ONLY the JSON array — no markdown fences.` },
      // The digest slot: the SAME source the worker's prompt slot 2 uses
      // (STATE/digest.md), so a rebuilt CODEMAP reaches plan() through the
      // normal digest path. Token-bounded by folder-04's compactor budget.
      { role: 'user', content: `DIGEST (STATE/digest.md)\n${digest}` },
    ]
  }

  private verifyMessages(criterion: string, workspace: string): Message[] {
    return [
      { role: 'system', content: 'You are a verifier. Answer ONLY with JSON: { satisfied: boolean, evidence: string }. Evidence must cite file:line from the WORKSPACE. No markdown fences.' },
      // Evidence discipline rides in the USER message (persona-safe, same as
      // the plan protocol): factuality rules from the GPT-5 Thinking prompt
      // (never claim what evidence does not support) plus Claude Code's
      // faithful-outcome reporting (a failed or skipped check is reported as
      // such, never as a pass).
      { role: 'user', content: `CRITERION_VERIFICATION\nCriterion: ${criterion}\nVERIFICATION PROTOCOL:\n- Cite evidence as file:line from the WORKSPACE snapshot below. A claim without a citation is satisfied: false.\n- If a check could not be executed, report satisfied: false and name what was missing — never guess a pass.\n- Judge the item as written: do not invent extra requirements, and do not excuse a partial result.\nWORKSPACE:\n${workspace}` },
    ]
  }

  private extractJson(text: string): string {
    const cleaned = text.trim()
    const match = cleaned.match(/```json\s*\n([\s\S]*?)\n\s*```/)
    return match ? match[1].trim() : cleaned
  }

  private parsePlanTasks(text: string): Task[] {
    let json: unknown
    try { json = JSON.parse(this.extractJson(text)) } catch (err) {
      throw new CommonsError('LEADER_INVALID_LLM_JSON', 'Transport did not return valid JSON for the plan', { detail: text.slice(0, 1000), cause: err })
    }
    let tasks: Task[]
    try { tasks = z.array(TaskSchema).parse(json) } catch (err) {
      throw new CommonsError('LEADER_INVALID_TASK_SCHEMA', 'LLM tasks did not match the task schema', { detail: String(err), cause: err })
    }
    return tasks.map((task, index) => {
      if (task.path.trim().length === 0) {
        throw new CommonsError('LEADER_TASK_NO_PATH', `Task ${task.id} has an empty path`, { detail: JSON.stringify(task) })
      }
      return { ...task, id: `T-${String(index + 1).padStart(2, '0')}` }
    })
  }

  private parseVerifyVerdict(criterion: string, text: string): VerificationResult {
    let parsed: { satisfied: boolean; evidence: string }
    try { parsed = z.object({ satisfied: z.boolean(), evidence: z.string().min(1) }).parse(JSON.parse(this.extractJson(text))) } catch (err) {
      throw new CommonsError('LEADER_INVALID_VERDICT', `Verification returned invalid JSON for criterion: ${criterion}`, { detail: text.slice(0, 1000), cause: err })
    }
    return { criterion, satisfied: parsed.satisfied, evidence: parsed.evidence }
  }

  private async snapshotWorkspace(): Promise<string> {
    const files = await this.commons.listWorkspace()
    const parts: string[] = []
    for (const file of files) {
      let content = ''
      try { content = await this.commons.readWorkspace(file.path) } catch { content = '<unreadable>' }
      parts.push(`### ${file.path}\n${content}`)
    }
    return parts.join('\n\n---\n\n')
  }

  private pickEngineer(engineers: string[], load: Record<string, number>, exclude: string[]): string | undefined {
    const ordered = [...engineers].sort((a, b) => load[a] - load[b])
    for (const engineer of ordered) {
      if (!exclude.includes(engineer)) return engineer
    }
    return undefined
  }

  private async drainQueue(list: Task[], crew: Crew, assignments: Record<string, string>, load: Record<string, number>): Promise<void> {
    const conflicts = (await this.conflicts.list()).filter((c) => c.resolution === undefined)
    for (const conflict of conflicts) {
      const engineer = this.pickEngineer(crew.engineers, load, conflict.heldBy)
      if (engineer !== undefined) {
        await this.claims.release(conflict.taskId)
        await this.claims.claim(conflict.taskId, conflict.path, engineer)
        assignments[conflict.taskId] = engineer
        load[engineer] += 1
        await this.conflicts.resolve(conflict.id, 'rerouted', `re-routed ${conflict.taskId} to ${engineer}`)
        continue
      }
      const task = list.find((t) => t.id === conflict.taskId)
      if (task === undefined) {
        await this.conflicts.resolve(conflict.id, 'split', 'task not found; abandoned')
        continue
      }
      const mid = Math.ceil(task.description.length / 2) || 1
      const part1 = task.description.slice(0, mid).trim() || 'part 1'
      const part2 = task.description.slice(mid).trim() || 'part 2'
      const sub1: Task = { id: `T-${String(list.length + 1).padStart(2, '0')}`, path: `${conflict.path}.part-1`, description: part1, acceptance: ['Part 1 implemented and reviewed'] }
      const sub2: Task = { id: `T-${String(list.length + 2).padStart(2, '0')}`, path: `${conflict.path}.part-2`, description: part2, acceptance: ['Part 2 implemented and reviewed'] }
      for (const sub of [sub1, sub2]) {
        const holders = await this.claims.holdersOf(sub.path)
        const assignee = this.pickEngineer(crew.engineers, load, holders)
        if (assignee !== undefined) {
          assignments[sub.id] = assignee
          load[assignee] += 1
          await this.claims.claim(sub.id, sub.path, assignee)
        }
      }
      await this.replaceTaskInStore(task.id, [sub1, sub2])
      await this.conflicts.resolve(conflict.id, 'split', `split into ${sub1.id} and ${sub2.id}`)
    }
    await this.commons.write(ASSIGNMENTS_KEY, assignments)
  }

  private async replaceTaskInStore(removedId: string, replacements: Task[]): Promise<void> {
    const current = await this.storedTasks()
    const index = current.findIndex((t) => t.id === removedId)
    const updated = index === -1 ? [...current, ...replacements] : [...current.slice(0, index), ...replacements, ...current.slice(index + 1)]
    await this.commons.write(TASKS_KEY, updated)
  }
}
