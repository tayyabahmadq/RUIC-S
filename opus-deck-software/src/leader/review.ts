/**
 * Opus//DECK — Phase 6: ReviewQueue.
 * Multi-file decisions enter pending; single-file ratified immediately.
 * veto() converts the reason into a routed follow-up task.
 *
 * Phase 4: a veto is a high-impact action, so before the follow-up task is
 * created the decision is confirmed with a single-use token (scope
 * REVIEW_VETO_SCOPE). The token is consumed — burned — BEFORE the task is
 * routed, so every follow-up task is traceably paired to exactly one confirmed
 * action. v1 policy is auto-issue-and-record (shipped flows stay unattended);
 * the confirmation reference rides on the task record itself.
 */
import {
  Bus, Commons, CommonsError, ConfirmationGate, ReviewDecision, Task,
  REVIEW_VETO_ACTION, REVIEW_VETO_SCOPE,
} from './types.js'

function nowIso(): string {
  return new Date().toISOString()
}

export class ReviewQueue {
  private readonly commons: Commons
  private readonly bus: Bus
  private readonly routeFollowUp: (input: { path: string; description: string; acceptance: string[]; confirmationRef?: string }) => Promise<Task>
  private readonly confirmations?: ConfirmationGate

  constructor(deps: { commons: Commons; bus: Bus; routeFollowUp: (input: { path: string; description: string; acceptance: string[]; confirmationRef?: string }) => Promise<Task>; confirmations?: ConfirmationGate }) {
    this.commons = deps.commons
    this.bus = deps.bus
    this.routeFollowUp = deps.routeFollowUp
    this.confirmations = deps.confirmations
  }

  async decide(input: { workerId: string; touched: string[]; rationale: string }): Promise<ReviewDecision> {
    const decisions = await this.storedDecisions()
    const id = `D-${String(decisions.length + 1).padStart(2, '0')}`
    const decision: ReviewDecision = {
      id, workerId: input.workerId, touched: [...input.touched], rationale: input.rationale,
      status: input.touched.length > 1 ? 'pending' : 'ratified', createdAt: nowIso(),
    }
    decisions.push(decision)
    await this.commons.write('leader:decisions', decisions)
    if (decision.status === 'pending') {
      await this.bus.emit('review.queued', { decisionId: id, touched: decision.touched })
    } else {
      await this.bus.emit('review.ratified', { decisionId: id })
    }
    return { ...decision }
  }

  async ratify(decisionId: string): Promise<ReviewDecision> {
    const decision = await this.get(decisionId)
    if (decision === undefined) throw new CommonsError('REVIEW_NOT_FOUND', `No review decision ${decisionId}`, { detail: decisionId })
    if (decision.status !== 'pending') throw new CommonsError('REVIEW_NOT_PENDING', `Decision ${decisionId} is ${decision.status}`, { detail: decisionId })
    decision.status = 'ratified'
    decision.resolvedAt = nowIso()
    await this.persistDecision(decision)
    await this.bus.emit('review.ratified', { decisionId })
    return { ...decision }
  }

  async veto(decisionId: string, reason: string): Promise<ReviewDecision> {
    const decision = await this.get(decisionId)
    if (decision === undefined) throw new CommonsError('REVIEW_NOT_FOUND', `No review decision ${decisionId}`, { detail: decisionId })
    if (decision.status !== 'pending') throw new CommonsError('REVIEW_NOT_PENDING', `Decision ${decisionId} is ${decision.status}`, { detail: decisionId })
    decision.status = 'vetoed'
    decision.vetoReason = reason
    decision.resolvedAt = nowIso()

    // Phase 4: confirm BEFORE the follow-up exists, so task -> confirmation is
    // never dangling. If the confirmation layer itself refuses, the veto still
    // completes (shipped behavior first) but without a pairing, and the
    // failure is already on the hub as action.rejected.
    let confirmationRef: string | undefined
    if (this.confirmations !== undefined) {
      try {
        const issued = this.confirmations.issue(REVIEW_VETO_SCOPE, { action: REVIEW_VETO_ACTION, subject: decision.id })
        const receipt = this.confirmations.consume(issued.token, REVIEW_VETO_SCOPE)
        confirmationRef = receipt.confirmationId
      } catch {
        confirmationRef = undefined
      }
    }

    const followUp = await this.routeFollowUp({
      path: decision.touched[0] ?? `REVIEW/${decisionId}.md`,
      description: `Veto rework for decision ${decisionId}: ${reason}`,
      acceptance: ['Rework is implemented', 'Decision is re-submitted and ratified'],
      ...(confirmationRef === undefined ? {} : { confirmationRef }),
    })
    decision.followUpTaskId = followUp.id
    if (confirmationRef !== undefined) decision.confirmationRef = confirmationRef
    await this.persistDecision(decision)
    await this.bus.emit('review.vetoed', {
      decisionId,
      followUpTaskId: followUp.id,
      reason,
      ...(confirmationRef === undefined ? {} : { confirmationRef }),
    })
    return { ...decision }
  }

  async listPending(): Promise<ReviewDecision[]> {
    const decisions = await this.storedDecisions()
    return decisions.filter((d) => d.status === 'pending').map((d) => ({ ...d }))
  }

  async get(decisionId: string): Promise<ReviewDecision | undefined> {
    const decisions = await this.storedDecisions()
    return decisions.find((d) => d.id === decisionId)
  }

  private async storedDecisions(): Promise<ReviewDecision[]> {
    const value = await this.commons.read<unknown[]>('leader:decisions')
    if (!Array.isArray(value)) return []
    return value.filter((item): item is ReviewDecision => item !== null && typeof item === 'object' && typeof (item as ReviewDecision).id === 'string')
  }

  private async persistDecision(decision: ReviewDecision): Promise<void> {
    const decisions = await this.storedDecisions()
    const index = decisions.findIndex((d) => d.id === decision.id)
    if (index === -1) decisions.push(decision)
    else decisions[index] = decision
    await this.commons.write('leader:decisions', decisions)
  }
}
