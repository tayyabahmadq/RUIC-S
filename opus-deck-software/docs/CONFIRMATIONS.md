# Single-use confirmation tokens (integration Phase 4)

**Status:** shipped. **Module:** `src/wiring/confirmations.ts`.
**Idea source:** `main/ARES-main` (MIT) — "single-use confirmation tokens for
high-impact actions" (idea attribution only; **no code was copied**, see
`PROVENANCE.md`).

The point is **auditability and recorded intent**, not crypto theater: a
high-impact action carries a proof that it was confirmed, that proof is good for
exactly one action, and the refusal reason is legible afterwards.

---

## 1. API

```ts
const confirmations = createConfirmant({ sink: hub, ttlMs: 15 * 60 * 1000 })

const issued = confirmations.issue(scope, { action?, subject?, ttlMs? })
// -> { token, scope, action, subject, nonce, confirmationId, issuedAt, expiresAt, expiresAtMs }

const receipt = confirmations.consume(issued.token, scope)  // verifies AND burns
// -> { confirmationId, scope, action, subject, nonce, issuedAt, expiresAt, consumedAt, fingerprint }

confirmations.tryConsume(token, scope)   // value form: { ok: true, receipt } | { ok: false, error }
confirmations.byId(confirmationId)       // one ledger row, or undefined
confirmations.ledger()                   // every issued token (issued/confirmed/rejected + rejections)
confirmations.confirmedActions()         // only the burned ones — the audit-grade list
```

`scope` is an exact string (no prefixes, no wildcards): it names *what* the token
authorizes. `subject` is free-form context for the audit trail (a decision id, a
batch description). `action` labels the action; it defaults to the last segment
of the scope.

## 2. Token construction

```
token = "CFM1." + base64url(payload) + "." + base64url(mac)
mac   = HMAC-SHA-256(secret, JSON([1, scope, action, nonce, expiry]))
payload = { v, cid, kid, scope, action, subject?, nonce, iat, exp }
```

- The MAC covers exactly `(scope, action, nonce, expiry)` as one JSON tuple, so no
  field separator can be forged by embedding newlines in a scope.
- HMAC is "keyed SHA-256" (SHA-256 under a secret key). A naive
  `sha256(secret || message)` digest is deliberately not used — it is
  length-extension prone.
- `node:crypto` only; no new dependency.
- **Never log `token`.** Use `confirmationId` (`CFM-…`) or `fingerprint`
  (`CFM1.<8 hex>`) for audit output.

## 3. Single use, by construction

`consume()` marks the nonce spent **before** it returns. There is no API that
un-burns a nonce, so a second presentation of the same token cannot succeed.

## 4. Failure modes — three distinct codes, never a generic "invalid token"

| Order | Reason | Code | Burns the token? |
|---|---|---|---|
| 0 | `malformed` | `CONFIRMATION_MALFORMED` | no — not attributable to this process (bad shape, bad signature, foreign process key) |
| 1 | `wrong-scope` | `CONFIRMATION_WRONG_SCOPE` | **no** — the right action can still use it |
| 2 | `replayed` | `CONFIRMATION_REPLAYED` | n/a — already burned |
| 3 | `expired` | `CONFIRMATION_EXPIRED` | no — the nonce is never counted as consumed |

Two precedence decisions, both deliberate:

- **Scope is checked before the burn.** Showing a token to the wrong action
  reveals nothing about the right one, so the token survives that mistake.
- **Replay is checked before expiry.** A burned nonce is spent for good; "you
  already used this" stays the true statement even after the clock passed its
  expiry. Expiry is what a never-spent token hits.

Every refusal emits `action.rejected` carrying `reason` **and** `code` plus
`requestedScope` / `tokenScope` / `expiresAt` / `consumedAt`, and is appended to
the token's ledger row under `rejections`.

## 5. v1 boundary (ruling R7) — tokens are PER-PROCESS

The signing secret is generated in memory at **wire time** and is never
persisted. Consequences, all intended for v1:

- A token minted before a restart cannot be verified after it: it arrives as
  `CONFIRMATION_MALFORMED` with `detail.reason = "foreign-key"`, and the error
  message names both key ids.
- The secret, the ledger and the run share one lifetime. There is no
  cross-process or cross-run authorization.
- `STATE/` gains no new files: the ledger is in-process, and the durable audit
  trail for confirmations is the hub event history (`hub.published()`).

Upgrade path if cross-process confirmation is ever required: persist the secret
(or a key reference) under COMMONS with folder-03's atomic write, widen
`kid` to select among keys, and move the ledger to `STATE/confirmations.json`.
Both are additive changes behind the same `Confirmant` interface.

## 6. Applied to

### (a) Veto follow-up generation — `REVIEW_VETO_SCOPE` (`review.veto:follow-up`)

`ReviewQueue.veto()` confirms **before** the follow-up task exists, so a task is
never left pointing at a confirmation that was not consumed:

1. `issue(scope, { action: 'veto-follow-up', subject: decisionId })`
2. `consume(token, scope)` — burns, emits `action.confirmed`
3. `routeFollowUp({ …, confirmationRef })` — the **task record carries the
   confirmation reference**, and `ReviewDecision.confirmationRef` records it too
4. `review.vetoed` gains an additive `confirmationRef` field

`confirmations.confirmedActions().filter(a => a.confirmationId === ref)` resolves
to **exactly one** confirmed action per follow-up task.

If the confirmation layer itself refuses, the veto still completes (shipped
behavior first) without a pairing; the refusal is already on the hub as
`action.rejected`.

### (b) Multi-file remediation batches — `remediation.batch:<digest>`

`remediateFindings()` asks the gate **once per run**, before the first batch
executes, and only when the batch spans more than one path:

- gate present + multi-file → `authorize({ paths, findingIds })` must return a
  `BatchAuthorization`, or nothing is enqueued and every finding escalates with
  reason `batch-unconfirmed` (the escalation detail carries the confirmation
  error code, e.g. `CONFIRMATION_REPLAYED`).
- no gate, or a single-file batch → behavior is byte-for-byte what it was before
  Phase 4. The gate is additive, never mandatory.

Scope is deterministic — `remediation.batch:` + `sha256(sorted paths | sorted
finding ids)[0:16]` — and both sides derive membership from
`planRemediationBatch()`, so a caller can pre-issue:

```ts
const scope = wired.remediationBatchScope(findings)   // null when single-file
const { token } = wired.confirmations.issue(scope!, { action: 'remediate-batch' })
await wired.remediateFindings(findings, deps, { confirmationToken: token })
```

### (c) Bulk deletions in export/merge helpers — **deferred**

No bulk-deletion surface ships yet in folder-09, so nothing is gated there. The
pattern to apply when one does: `issue('export.bulk-delete', { subject: runId })`
→ consume → then delete, exactly as (a) and (b) do.

## 7. Policy — v1 is auto-issue-and-record

The open policy question was whether a veto requires **prior human confirmation**
or **auto-issue-and-record**. v1 chose **auto-issue-and-record**, because the
shipped escalation → veto → follow-up flow is unattended today and requiring a
human token would have turned every veto into a manual intervention — a silent
behavior regression in a phase that is supposed to be additive.

Every such action is still confirmed, single-use and audited; what is deferred is
*who* presses the button. The upgrade path is already wired:

- `wireOpusDeck(runtime, { confirmationAutoIssue: false })` — a multi-file
  remediation batch now refuses to execute without a caller-minted token.
- `createRemediationBatchGate(confirmant, { autoIssue: false })` — same, locally.
- A future `veto` option (e.g. `veto(id, reason, { requireConfirmation: true })`)
  would leave the token unconsumed and route the decision to a human queue. Not
  implemented: no shipped caller needs it yet.

## 8. Tests

`src/wiring/confirmations.test.ts` — round trip; expiry; replay; wrong scope
(asserting each of the three has its own code and its own hub rejection); the
three codes are pairwise distinct; the R7 per-process boundary; the veto pairing
end-to-end through the composition root; the batch gate refused / consumed /
replayed; and the single-file regression.
