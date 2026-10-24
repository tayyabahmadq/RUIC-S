/**
 * Opus//DECK — integration Phase 4: SINGLE-USE CONFIRMATION TOKENS.
 *
 * Idea source (idea attribution only, zero code copied — see docs/PROVENANCE.md):
 * `main/ARES-main` (MIT) — "capability/module registry; single-use confirmation
 * tokens for high-impact actions".
 *
 * Construction
 *   token = `CFM1.<base64url(payload)>.<base64url(mac)>`
 *   mac   = HMAC-SHA-256(secret, JSON([VERSION, scope, action, nonce, expiry]))
 *   HMAC *is* "keyed SHA-256" (SHA-256 under a secret key). A naive
 *   sha256(secret || message) digest is deliberately not used: it is
 *   length-extension prone.
 *
 * Single use BY CONSTRUCTION: consume() marks the nonce spent before it
 * returns, so a second presentation of the same token fails with
 * CONFIRMATION_REPLAYED. No caller can "use it twice".
 *
 * Failure modes are DISTINCT, because the audit trail must be able to tell
 * "too late" from "already used" from "not for this action":
 *   CONFIRMATION_EXPIRED       reason `expired`
 *   CONFIRMATION_REPLAYED      reason `replayed`
 *   CONFIRMATION_WRONG_SCOPE   reason `wrong-scope`
 *   CONFIRMATION_MALFORMED     reason `malformed` — not a token this process can
 *                              attribute at all (bad shape, bad signature, or a
 *                              foreign per-process key). Reported separately so a
 *                              forgery is never filed as "wrong scope".
 *
 * v1 BOUNDARY (ruling R7) — tokens are PER-PROCESS. The signing secret is
 * generated in memory at wire time and never persisted, so a token minted before
 * a restart cannot be verified after it (it arrives as CONFIRMATION_MALFORMED,
 * detail `foreign-key`). The secret, the ledger and the run share one lifetime.
 * That is the intended v1 shape: this layer buys auditability + recorded intent
 * for high-impact actions inside a run, not cross-process authorization.
 *
 * Default expiry: 15 minutes (R7).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ActionConfirmedPayload, ActionRejectedPayload, ConfirmationRejectionReason } from '../config/types.js'
import type { BatchConfirmationGate, BatchConfirmationRequest } from '../audit/types.js'

/** R7: default confirmation lifetime. */
export const DEFAULT_CONFIRMATION_TTL_MS = 15 * 60 * 1000
/** Guards against a caller minting a token that outlives any sane action. */
export const MAX_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000
/** Sub-second TTLs are a test affordance, not a production shape. */
export const MIN_CONFIRMATION_TTL_MS = 1

export const CONFIRMATION_VERSION = 1
export const CONFIRMATION_TOKEN_PREFIX = 'CFM1'
/** Phase-4 action name for a remediation batch spanning more than one file. */
export const REMEDIATION_BATCH_ACTION = 'remediate-batch'

export type ConfirmationErrorCode =
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_REPLAYED'
  | 'CONFIRMATION_WRONG_SCOPE'
  | 'CONFIRMATION_MALFORMED'

const CODE_BY_REASON: Record<ConfirmationRejectionReason, ConfirmationErrorCode> = {
  expired: 'CONFIRMATION_EXPIRED',
  replayed: 'CONFIRMATION_REPLAYED',
  'wrong-scope': 'CONFIRMATION_WRONG_SCOPE',
  malformed: 'CONFIRMATION_MALFORMED',
}

/** Everything the audit trail needs to explain a refusal without guessing. */
export interface ConfirmationRejectionDetail {
  readonly requestedScope: string
  readonly tokenScope?: string
  readonly action?: string
  readonly nonce?: string
  readonly confirmationId?: string
  readonly expiresAt?: string
  readonly consumedAt?: string
  readonly reason: string
  readonly at: string
}

export class ConfirmationError extends Error {
  readonly code: ConfirmationErrorCode
  readonly reason: ConfirmationRejectionReason
  readonly folder: 'wiring' = 'wiring'
  readonly detail: ConfirmationRejectionDetail

  constructor(
    reason: ConfirmationRejectionReason,
    message: string,
    detail: Omit<ConfirmationRejectionDetail, 'reason' | 'at' | 'requestedScope'> & { requestedScope: string; reason?: string },
  ) {
    super(message)
    this.name = 'ConfirmationError'
    this.code = CODE_BY_REASON[reason]
    this.reason = reason
    this.detail = { ...detail, reason: detail.reason ?? reason, at: new Date().toISOString() }
  }
}

/** What `issue()` hands back. `token` is the bearer value — never log it. */
export interface IssuedConfirmation {
  readonly token: string
  readonly scope: string
  readonly action: string
  readonly subject?: string
  readonly nonce: string
  readonly confirmationId: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly expiresAtMs: number
}

export interface ConsumptionReceipt {
  readonly confirmationId: string
  readonly scope: string
  readonly action: string
  readonly subject?: string
  readonly nonce: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly consumedAt: string
  /** Non-secret handle for pairing + audit; safe to persist and print. */
  readonly fingerprint: string
}

export interface IssueOptions {
  readonly action?: string
  readonly subject?: string
  readonly ttlMs?: number
}

/** One ledger row per issued token. The in-process audit trail. */
export interface ConfirmationRecord {
  readonly confirmationId: string
  readonly fingerprint: string
  readonly scope: string
  readonly action: string
  readonly subject?: string
  readonly nonce: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly status: 'issued' | 'confirmed' | 'rejected'
  readonly consumedAt?: string
  readonly rejections: readonly ActionRejectedPayload[]
}

/** Minimal structural hub view — the shared EventHub satisfies it. */
export interface ConfirmationSink {
  emit(event: string, payload: unknown): void
}

export interface Confirmant {
  /** Short id of this process's signing key (proves tokens do not cross processes). */
  readonly keyId: string
  issue(scope: string, options?: IssueOptions): IssuedConfirmation
  consume(token: string, scope: string): ConsumptionReceipt
  tryConsume(token: string, scope: string): { ok: true; receipt: ConsumptionReceipt } | { ok: false; error: ConfirmationError }
  byId(confirmationId: string): ConfirmationRecord | undefined
  ledger(): readonly ConfirmationRecord[]
  confirmedActions(): readonly ConfirmationRecord[]
}

export interface ConfirmantOptions {
  /** Where `action.confirmed` / `action.rejected` are emitted (the shared hub). */
  readonly sink?: ConfirmationSink
  /** Epoch-ms clock; injectable so expiry is testable without waiting. */
  readonly now?: () => number
  /** Default lifetime (default: 15 minutes, R7). */
  readonly ttlMs?: number
  /** Per-process signing secret. Omit in production; injectable for tests. */
  readonly secret?: string | Buffer
}

interface TokenPayload {
  readonly v: number
  readonly cid: string
  readonly kid: string
  readonly scope: string
  readonly action: string
  readonly subject?: string
  readonly nonce: string
  readonly iat: number
  readonly exp: number
}

interface MutableRecord {
  confirmationId: string
  fingerprint: string
  scope: string
  action: string
  subject?: string
  nonce: string
  issuedAt: string
  expiresAt: string
  status: 'issued' | 'confirmed' | 'rejected'
  consumedAt?: string
  rejections: ActionRejectedPayload[]
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

function fromB64url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8')
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Canonical MAC input — exactly (scope, action, nonce, expiry), JSON-encoded so
 *  no field separator can be forged by embedding newlines in a scope. */
function canonical(payload: TokenPayload): string {
  return JSON.stringify([CONFIRMATION_VERSION, payload.scope, payload.action, payload.nonce, payload.exp])
}

function macOf(secret: Buffer, payload: TokenPayload): string {
  return createHmac('sha256', secret).update(canonical(payload), 'utf8').digest('base64url')
}

function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function clampTtl(requested: number): number {
  if (!Number.isFinite(requested)) return DEFAULT_CONFIRMATION_TTL_MS
  return Math.min(Math.max(Math.trunc(requested), MIN_CONFIRMATION_TTL_MS), MAX_CONFIRMATION_TTL_MS)
}

/** A plain object literal scope is its own action label. */
function defaultAction(scope: string): string {
  const tail = scope.split(/[:/]/).filter(Boolean).pop()
  return tail && tail.length > 0 ? tail : 'execute'
}

/**
 * Deterministic scope for a remediation batch: the same batch membership always
 * yields the same scope string, so a caller can pre-issue a token for a batch it
 * computed with `planRemediationBatch()` and the audit loop will accept it.
 */
export function remediationBatchScope(request: BatchConfirmationRequest): string {
  const paths = [...request.paths].sort().join(',')
  const findings = [...request.findingIds].sort().join(',')
  return `remediation.batch:${sha256Hex(`${paths}|${findings}`).slice(0, 16)}`
}

class ConfirmantImpl implements Confirmant {
  readonly keyId: string
  private readonly secret: Buffer
  private readonly sink?: ConfirmationSink
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly byNonce = new Map<string, MutableRecord>()
  private readonly byIdIndex = new Map<string, MutableRecord>()
  private readonly order: string[] = []

  constructor(options: ConfirmantOptions = {}) {
    this.secret = options.secret === undefined
      ? randomBytes(32)
      : Buffer.isBuffer(options.secret) ? options.secret : Buffer.from(options.secret, 'utf8')
    if (this.secret.length === 0) throw new Error('E_CONFIRMATION_SECRET: signing secret must not be empty')
    this.keyId = sha256Hex(this.secret.toString('binary')).slice(0, 8)
    this.sink = options.sink
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = clampTtl(options.ttlMs ?? DEFAULT_CONFIRMATION_TTL_MS)
  }

  issue(scope: string, options: IssueOptions = {}): IssuedConfirmation {
    if (typeof scope !== 'string' || scope.trim().length === 0) {
      throw new Error('E_CONFIRMATION_SCOPE: issue() requires a non-empty scope')
    }
    const action = options.action ?? defaultAction(scope)
    const ttl = options.ttlMs === undefined ? this.ttlMs : clampTtl(options.ttlMs)
    const issuedAtMs = this.now()
    const expiresAtMs = issuedAtMs + ttl
    const nonce = randomBytes(16).toString('hex')
    const confirmationId = `CFM-${nonce.slice(0, 12).toUpperCase()}`
    const payload: TokenPayload = {
      v: CONFIRMATION_VERSION,
      cid: confirmationId,
      kid: this.keyId,
      scope,
      action,
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      nonce,
      iat: issuedAtMs,
      exp: expiresAtMs,
    }
    const token = `${CONFIRMATION_TOKEN_PREFIX}.${b64url(JSON.stringify(payload))}.${macOf(this.secret, payload)}`
    const record: MutableRecord = {
      confirmationId,
      fingerprint: `${CONFIRMATION_TOKEN_PREFIX}.${nonce.slice(0, 8)}`,
      scope,
      action,
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      nonce,
      issuedAt: iso(issuedAtMs),
      expiresAt: iso(expiresAtMs),
      status: 'issued',
      rejections: [],
    }
    this.byNonce.set(nonce, record)
    this.byIdIndex.set(confirmationId, record)
    this.order.push(nonce)
    return {
      token,
      scope,
      action,
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      nonce,
      confirmationId,
      issuedAt: iso(issuedAtMs),
      expiresAt: iso(expiresAtMs),
      expiresAtMs,
    }
  }

  consume(token: string, requestedScope: string): ConsumptionReceipt {
    if (typeof requestedScope !== 'string' || requestedScope.trim().length === 0) {
      throw new Error('E_CONFIRMATION_SCOPE: consume() requires a non-empty scope')
    }
    const payload = this.verify(token, requestedScope)
    const record = this.byNonce.get(payload.nonce)
    if (record === undefined) {
      throw this.reject('malformed', requestedScope, payload, undefined,
        'Confirmation is correctly signed but unknown to this process ledger.')
    }

    // Scope first, and it must NOT burn: presenting a token to the wrong action
    // tells the caller nothing about the right one, so the token survives.
    if (payload.scope !== requestedScope) {
      throw this.reject('wrong-scope', requestedScope, payload, record,
        `Confirmation ${payload.cid} is scoped to ${payload.scope}, not ${requestedScope}.`)
    }

    // Replay is checked BEFORE expiry, on purpose: a burned nonce is spent for
    // good, so "you already used this" stays the true statement even if the clock
    // has since passed its expiry. Expiry is what a never-spent token hits.
    if (record.consumedAt !== undefined) {
      throw this.reject('replayed', requestedScope, payload, record,
        `Confirmation ${record.confirmationId} was already consumed at ${record.consumedAt}; each token authorizes exactly one action.`)
    }
    if (this.now() > payload.exp) {
      throw this.reject('expired', requestedScope, payload, record,
        `Confirmation ${payload.cid} expired at ${iso(payload.exp)}.`)
    }

    // --- burn, before any hand-back: single use by construction ---
    const consumedAt = iso(this.now())
    record.status = 'confirmed'
    record.consumedAt = consumedAt
    const receipt: ConsumptionReceipt = {
      confirmationId: record.confirmationId,
      scope: record.scope,
      action: record.action,
      ...(record.subject === undefined ? {} : { subject: record.subject }),
      nonce: record.nonce,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      consumedAt,
      fingerprint: record.fingerprint,
    }
    this.emitConfirmed(receipt)
    return receipt
  }

  tryConsume(token: string, scope: string): { ok: true; receipt: ConsumptionReceipt } | { ok: false; error: ConfirmationError } {
    try {
      return { ok: true, receipt: this.consume(token, scope) }
    } catch (err) {
      if (err instanceof ConfirmationError) return { ok: false, error: err }
      throw err
    }
  }

  byId(confirmationId: string): ConfirmationRecord | undefined {
    const record = this.byIdIndex.get(confirmationId)
    return record === undefined ? undefined : this.snapshot(record)
  }

  ledger(): readonly ConfirmationRecord[] {
    return this.order
      .map((nonce) => this.byNonce.get(nonce))
      .filter((r): r is MutableRecord => r !== undefined)
      .map((r) => this.snapshot(r))
  }

  confirmedActions(): readonly ConfirmationRecord[] {
    return this.ledger().filter((r) => r.status === 'confirmed')
  }

  // --- internals ---

  private snapshot(record: MutableRecord): ConfirmationRecord {
    return {
      confirmationId: record.confirmationId,
      fingerprint: record.fingerprint,
      scope: record.scope,
      action: record.action,
      ...(record.subject === undefined ? {} : { subject: record.subject }),
      nonce: record.nonce,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      status: record.status,
      ...(record.consumedAt === undefined ? {} : { consumedAt: record.consumedAt }),
      rejections: record.rejections.map((r) => ({ ...r })),
    }
  }

  private malformed(requestedScope: string, message: string, hint: string): ConfirmationError {
    const at = new Date().toISOString()
    const code = CODE_BY_REASON.malformed
    const payload: ActionRejectedPayload = {
      reason: 'malformed', code, requestedScope, message, at,
    }
    this.sink?.emit('action.rejected', payload)
    return new ConfirmationError('malformed', message, { requestedScope, reason: hint })
  }

  private verify(token: string, requestedScope: string): TokenPayload {
    if (typeof token !== 'string' || token.length === 0) {
      throw this.malformed(requestedScope, 'Confirmation token is empty.', 'empty-token')
    }
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== CONFIRMATION_TOKEN_PREFIX) {
      throw this.malformed(requestedScope, 'Confirmation token is not a CFM1 token.', 'bad-shape')
    }
    let payload: TokenPayload
    try {
      payload = JSON.parse(fromB64url(parts[1])) as TokenPayload
    } catch {
      throw this.malformed(requestedScope, 'Confirmation token payload is not decodable.', 'bad-payload')
    }
    if (
      payload === null || typeof payload !== 'object' || payload.v !== CONFIRMATION_VERSION ||
      typeof payload.scope !== 'string' || typeof payload.action !== 'string' ||
      typeof payload.nonce !== 'string' || typeof payload.exp !== 'number'
    ) {
      throw this.malformed(requestedScope, 'Confirmation token payload is not a v1 confirmation.', 'bad-payload')
    }
    if (payload.kid !== this.keyId) {
      throw this.malformed(
        requestedScope,
        `Confirmation was minted by process key ${String(payload.kid)}; this process is ${this.keyId}. v1 tokens are per-process and do not survive a restart.`,
        'foreign-key',
      )
    }
    if (!secureEquals(parts[2], macOf(this.secret, payload))) {
      throw this.malformed(requestedScope, 'Confirmation signature does not verify against this process secret.', 'bad-signature')
    }
    return payload
  }

  private reject(
    reason: ConfirmationRejectionReason,
    requestedScope: string,
    payload: TokenPayload,
    record: MutableRecord | undefined,
    message: string,
  ): ConfirmationError {
    const code = CODE_BY_REASON[reason]
    const at = new Date().toISOString()
    const rejected: ActionRejectedPayload = {
      reason,
      code,
      requestedScope,
      tokenScope: payload.scope,
      action: payload.action,
      nonce: payload.nonce,
      confirmationId: record?.confirmationId ?? payload.cid,
      expiresAt: iso(payload.exp),
      ...(record?.consumedAt === undefined ? {} : { consumedAt: record.consumedAt }),
      message,
      at,
    }
    if (record !== undefined) {
      record.rejections.push(rejected)
      if (reason !== 'replayed') record.status = 'rejected'
    }
    this.sink?.emit('action.rejected', rejected)
    return new ConfirmationError(reason, message, {
      requestedScope,
      tokenScope: payload.scope,
      action: payload.action,
      nonce: payload.nonce,
      confirmationId: rejected.confirmationId,
      expiresAt: rejected.expiresAt,
      ...(rejected.consumedAt === undefined ? {} : { consumedAt: rejected.consumedAt }),
      reason,
    })
  }

  private emitConfirmed(receipt: ConsumptionReceipt): void {
    const payload: ActionConfirmedPayload = {
      confirmationId: receipt.confirmationId,
      scope: receipt.scope,
      action: receipt.action,
      ...(receipt.subject === undefined ? {} : { subject: receipt.subject }),
      nonce: receipt.nonce,
      issuedAt: receipt.issuedAt,
      expiresAt: receipt.expiresAt,
      consumedAt: receipt.consumedAt,
    }
    this.sink?.emit('action.confirmed', payload)
  }
}

/** The confirmant factory. Called once, at wire time (R7: secret per process). */
export function createConfirmant(options: ConfirmantOptions = {}): Confirmant {
  return new ConfirmantImpl(options)
}

// ---------------------------------------------------------------------------
// Application (b): multi-file remediation batches
// ---------------------------------------------------------------------------

export interface BatchGateOptions {
  /** A token the caller minted for this exact batch; consumed (burned) on use. */
  readonly token?: string
  /**
   * v1 policy: auto-issue-and-record. When no token is supplied the gate mints
   * and immediately burns one so shipped flows stay unattended — every batch is
   * still confirmed, audited and single-use. Set false to require a caller token
   * (the upgrade path towards prior human confirmation).
   */
  readonly autoIssue?: boolean
}

/**
 * Batch gate for the audit loop. `authorize()` MUST throw (a `ConfirmationError`)
 * when the batch is not confirmed; the loop then executes nothing and escalates.
 */
export interface RemediationBatchGate extends BatchConfirmationGate {
  scopeFor(request: BatchConfirmationRequest): string
}

export function createRemediationBatchGate(
  confirmant: Confirmant,
  options: BatchGateOptions = {},
): RemediationBatchGate {
  const autoIssue = options.autoIssue ?? true
  return {
    scopeFor: remediationBatchScope,
    authorize(request: BatchConfirmationRequest) {
      const scope = remediationBatchScope(request)
      const subject = `${request.paths.length} file(s): ${[...request.paths].sort().join(', ')}`
      if (options.token !== undefined && options.token.length > 0) {
        // Caller-driven confirmation: wrong scope, expiry and replay are all
        // hard failures here and stop the batch before anything executes.
        const receipt = confirmant.consume(options.token, scope)
        return { confirmationId: receipt.confirmationId, scope, confirmedAt: receipt.consumedAt, autoIssued: false }
      }
      if (!autoIssue) {
        throw new Error(`E_BATCH_UNCONFIRMED: multi-file remediation batch requires a confirmation token for scope ${scope}`)
      }
      const issued = confirmant.issue(scope, { action: REMEDIATION_BATCH_ACTION, subject })
      const receipt = confirmant.consume(issued.token, scope)
      return { confirmationId: receipt.confirmationId, scope, confirmedAt: receipt.consumedAt, autoIssued: true }
    },
  }
}
