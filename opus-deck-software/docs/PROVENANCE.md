# Opus//DECK — PROVENANCE

Component map, the DELTA/DECISIONS/FINDINGS JSONL schemas, the canonical path
table, the event catalog, and the security ruleset.

---

## Component map

| Phase | Directory | Responsibility |
|-------|-----------|----------------|
| 1 | `src/config/` | Config validation, event bus, canonical paths, `initOpusDeck` bootstrap |
| 2 | `src/transport/` | Model registry, `Transport.complete()` (the sole LLM-calling interface), adapters, retry, usage |
| 3 | `src/commons/` | COMMONS core — six-op memory API over the shared directory |
| 4 | `src/compactor/` | Compactor — digest shrinking, archival, PINS survival, working-set reduction |
| 5 | `src/coordination/` | Presence, claims/locks, sync, heartbeat, conflict queue |
| 6 | `src/leader/` | Leader (plan/route/verify/signOff), ReviewQueue |
| 7 | `src/crew/` | Engineering crew runner — buildPrompt, worker pool, LRU working set |
| 8 | `src/audit/` | Security audit gate — scan, remediate, escalate |
| 9 | `src/merge/` | Merge & build engine — gate, copy, manifest, report |
| 10 | `src/cli/` | CLI & surface — /opus commands, dashboard, formatting, abort |
| 11 | `src/f11/` | Review Agent — precision diff-review: collect → filter → bundle → LLM review → position → reflect → persist → escalate |
| 12 | `src/f12/` | CodeGraph — workspace knowledge-graph memory: detect → extract → build → cluster → CODEMAP digest section |
| 11 | `src/wiring/` | Composition root — single shared bus, all cross-phase adapters |

---

## Canonical COMMONS path table

All values are bare relative segments (directory entries carry no trailing
slash), resolved against `memoryDir` at the wiring boundary.

| Constant | Value | Kind |
|----------|-------|------|
| BRIEF | `BRIEF.md` | file |
| DECISIONS | `DECISIONS.log` | file |
| DIGEST | `STATE/digest.md` | file |
| PRESENCE | `STATE/presence.json` | file |
| TASKS | `STATE/tasks.json` | file |
| FINDINGS | `STATE/findings.json` | file |
| WORKSPACE | `WORKSPACE` | directory |
| DELTA | `DELTA` | directory |
| ARCHIVE | `ARCHIVE` | directory |
| TXN_LOG | `DELTA/txn.jsonl` | file |

---

## DELTA/txn.jsonl schema

One compact JSON object per line, UTF-8, LF-terminated. Appended before the
diff is applied; the source of truth for replay (`sync()`) and claims.

```json
{
  "txn": "txn-000001",
  "ts": "2026-10-17T00:00:00.000Z",
  "path": "WORKSPACE/src/a.ts",
  "intent": "add retry logic",
  "author": "model-alpha",
  "status": "applied",
  "diff": {
    "added": ["line a", "line b"],
    "removedLineCount": 1,
    "atLine": 42
  },
  "claims": ["WORKSPACE/src/a.ts"]
}
```

- `status` is `applied` or `blocked` (blocked = conflicted write, queued).
- `claims` is optional; absent = no claims. An APPLIED txn listing path P in
  claims claims P for its author; an APPLIED txn whose own path is P and that
  does not list P releases P.

---

## DECISIONS.log schema

Append-only JSONL, never rewritten or deleted:

```json
{
  "id": "dec-000001",
  "ts": "2026-10-17T00:00:00.000Z",
  "summary": "use zod for validation",
  "rationale": "boundary parsing needs schemas",
  "author": "lead"
}
```

---

## STATE/findings.json schema

The canonical findings store, written by the audit phase via an atomic
COMMONS write. Read by the merge gate and the leader escalation path.

```json
[
  {
    "id": "FND-476a87580bb0",
    "severity": "critical",
    "path": "src/app.ts",
    "line": 8,
    "detector": "sec-1",
    "resolved": false
  }
]
```

---

## Event catalog

Closed set (Phase 1; extended additively — an event name is never repurposed).

| Event | Meaning |
|-------|---------|
| `run.started` | Reserved — no producer call site in `src/` yet (catalog audit enforces) |
| `task.claimed` | Reserved — no producer call site in `src/` yet (catalog audit enforces) |
| `task.completed` | A worker completed a task |
| `memory.written` | R10: a file was written through COMMONS — emitted from the wiring layer after every successful `commons.write()` with `{ path, txnId, author }`; commons itself stays bus-free |
| `finding.raised` | Reserved — no producer call site in `src/` yet (catalog audit enforces) |
| `finding.resolved` | Reserved — no producer call site in `src/` yet (catalog audit enforces) |
| `compaction.requested` | Digest over budget / prompt over budget |
| `compaction.started` | Reserved — no producer call site in `src/` yet (catalog audit enforces) |
| `compaction.done` | Compactor finished a pass |
| `crew.sync` | Reserved — no producer call site in `src/` yet (catalog audit enforces) |
| `review.queued` | Review decision entered pending |
| `review.requested` | Phase 11: review run started |
| `review.bundle.started` | Phase 11: review bundle LLM call started |
| `review.bundle.done` | Phase 11: review bundle LLM call finished |
| `review.completed` | Phase 11: review run completed |
| `run.completed` | Run signed off |
| `run.failed` | Run failed / aborted |
| `action.confirmed` | Phase 4: a high-impact action was authorized; its single-use token was burned |
| `action.rejected` | Phase 4: a confirmation token was refused — `reason` says WHICH failure mode |
| `codegraph.rebuilt` | Phase 12: workspace graph rebuilt — `{ files, clusters, hubs }` |

### Phase 4 payloads (`action.confirmed` / `action.rejected`)

```json
{ "confirmationId": "CFM-1A2B3C4D5E6F", "scope": "review.veto:follow-up",
  "action": "veto-follow-up", "subject": "D-01", "nonce": "…",
  "issuedAt": "…", "expiresAt": "…", "consumedAt": "…" }
```

```json
{ "reason": "replayed", "code": "CONFIRMATION_REPLAYED",
  "requestedScope": "export.bulk-delete", "tokenScope": "review.veto:follow-up",
  "action": "veto-follow-up", "nonce": "…", "confirmationId": "CFM-…",
  "expiresAt": "…", "consumedAt": "…", "message": "…", "at": "…" }
```

`reason` ∈ `expired` | `replayed` | `wrong-scope` | `malformed`; `code` is the
matching error constant. The three required failure modes have three distinct
codes — a generic "invalid token" is never emitted, because the audit trail must
be able to tell them apart.

---

## Phase 12 payload (`codegraph.rebuilt`)

```json
{ "files": 14, "clusters": 3, "hubs": 7 }
```

`files` = nodes in the rebuilt workspace graph; `clusters` = module clusters
reachable from entry points; `hubs` = files with in-degree > 0, ranked by
in-degree. The CODEMAP digest section is regenerable state (R6): compaction
may demote it and the next rebuild restores it — it is never pinned.

---

## Single-use confirmations (integration Phase 4)

`src/wiring/confirmations.ts`. Token = `CFM1.<base64url(payload)>.<base64url(mac)>`
where `mac = HMAC-SHA-256(per-process secret, JSON([1, scope, action, nonce, expiry]))`.
`consume()` burns the nonce before returning, so single use is structural, not a
convention. Default expiry **15 minutes**.

**v1 boundary (R7) — tokens are PER-PROCESS.** The signing secret is generated
in memory at wire time and never persisted, so a token minted before a restart
cannot be verified after it (it is reported as `CONFIRMATION_MALFORMED` /
`foreign-key`). No new COMMONS file is written: the durable trail is the hub
event history plus the in-process ledger
(`confirmations.ledger()` / `confirmations.confirmedActions()`).
Full spec, precedence rules and application sites: `docs/CONFIRMATIONS.md`.

Scoped confirmation records now ride on two existing records (optional fields,
no shape removed):

- `Task.confirmationRef` — a follow-up task born of a veto carries the
  confirmation that authorized it; it resolves to exactly one confirmed action.
- `ReviewDecision.confirmationRef` — the same reference on the decision.

`EscalationReason` gains `batch-unconfirmed`: a multi-file remediation batch that
was not confirmed enqueues nothing and escalates per finding.

Idea attribution: `main/ARES-main` (MIT) — single-use confirmation tokens for
high-impact actions. Concept only; zero code copied.

---

## Gate severity configuration (integration Phase 3)

`STATE/config.json` `{ "gate": { "failOn": "critical" | "high" | "medium" | "low" } }` is the
ONE source for the merge gate's blocking threshold (ruling R5), zod-validated at load
in `src/wiring/severity-config.ts`; an invalid file fails fast with `gate-config.invalid`
naming the file, the key, and expected vs found. A missing file is the default
(`critical`), never an error — that default is exactly the shipped behavior: only
unresolved critical findings block merge and escalate.

Precedence, resolved once at `wireOpusDeck()` boot: explicit runtime config ->
`STATE/config.json` -> `"critical"`. The resolved value is injected into both consumers
— the f09 merge gate (`checkReadiness`) and the f08 audit escalation threshold
(`remediateFindings`) — so neither folder parses the file and both read the same value.
Changeable without code edits: edit `STATE/config.json` and restart.

---

## Security ruleset (SEC-001 … SEC-007)

| Id | Severity | Strategy | Fires on |
|----|----------|----------|----------|
| SEC-001 | critical | (none — escalated) | `eval(`, `window.eval(`, `.eval(`, `new Function(` |
| SEC-002 | high | `escape` | innerHTML/outerHTML/insertAdjacentHTML/document.write with non-literal HTML |
| SEC-003 | high | (none — escalated) | SQL verb + concatenation + quote/context |
| SEC-004 | critical | `env-var` | `(api_key\|secret\|token\|password\|…)` assigned a literal >= 8 chars; PEM blocks |
| SEC-005 | medium | `https` | `http://` outside loopback / XML namespaces |
| SEC-006 | medium | `crypto-random` | `Math.random(` on a security-named identifier |
| SEC-007 | medium | (none — escalated) | `===`/`!==`/`==`/`!=`/localeCompare on a password/secret/token operand |

- Critical/high without a patch strategy are ESCALATED, never advisory.
- Resolution = zero remaining hits for (file, rule) after re-scan (per-line
  matching is insufficient because patching shifts line numbers).
- Max 3 hits per rule per file; dedupe key `(ruleId, path, line)` keeping the
  first detector's attribution.
- New rule ids start at SEC-008; SEC-001..007 are never renumbered.

## Thinking integration (reasoning protocols + effort knob)

External material: `system_prompts_leaks-main/` (public verbatim system-prompt
leaks, `C:\Users\ctayy\Downloads\Studio`). Three sources, selected for reasoning
capability:

| Source | Used for | Copied verbatim? |
|---|---|---|
| `OpenAI/gpt-5*-thinking.md` | Factuality + decision-boundary rules in the verify protocol | No — paraphrased |
| `Anthropic/claude-code/claude-code-opus-5.5.md` | `reasoning_effort` scale, execution discipline (rabbit-hole rule, verify-then-claim, recommendation-not-survey) | No — paraphrased |
| `Anthropic/claude-code/skills/claude-api/` (prompt-audit, effort tables) | Governing rule: depth via configuration + task structure, never prose; anthropic wire contract `output_config.effort` | No — contract followed |

Integration surfaces (all additive, all default-safe):

- `ModelRef.reasoningEffort?` — config layer (`src/config/types.ts`,
  `src/config/index.ts` zod enum) and transport layer
  (`src/transport/types.ts`).
- Adapter wire emission — `openai-compatible.ts` / `custom.ts`:
  `reasoning_effort`; `anthropic.ts`: `output_config.effort`. Opt-in only;
  unset = wire body unchanged (tested).
- Reasoning protocols in **user messages** — `src/leader/leader.ts`
  (`plan()`: TASK_DECOMPOSITION protocol; `verify()`: VERIFICATION PROTOCOL).
  User-message placement is deliberate: a persona body replaces the system
  prompt verbatim (Phase-3 contract), so the system message is not a reliable
  channel for reasoning content.
- `## 6. Execution Protocol` — fixed, budget-counted section in
  `src/crew/assemble-prompt.ts` `buildPrompt`, both budget branches.

Guide: `docs/thinking.md`.
