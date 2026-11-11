# RUIC — Final Migration & Implementation Plan

**The path: "Value first, then strangle — Rust for the bones, Lua for the hooks. Hooks propose, humans dispose."**

Status: **converged blueprint** — nothing below is implemented yet; this document is the plan of record. Stage 0 is ~90% complete (see §0).

---

## §0 Stage 0 — Ship Common-S on TypeScript *(the foundation — ~90% done)*

The approved Common-S v2 plan is executed: Brain (6 stores), State Contract v1.0.0 with exit-path enforcement, Triangular Compaction Loop, Laya, the five departments, Zeak v1 (economic guard) + v2 (the Teacher: TRY BOX, Model 2/3 learning loop, predictive early-stop), FreeLLM failover, Model pool, chat-first deck, glass→OpenCode themes.

**Gate 0 — the one open item.** Run **one real local run in the deck** (not the test harness): a trivial brief executed end-to-end by the local Qwen — contract written, compaction fired, learning cycle ran — and **one heavy brief that survives a forced handoff**.

*If this never passes, no language will save you — and you'll have learned why, cheaply.*

---

## §1 Stage 1 — Tauri Phase A *(the highest-value single move, 2–3 week timebox)*

Swap the Electron shell for **Tauri**. The glass/OpenCode frontend carries over nearly as-is; the engine is untouched. Kills the bulk of the window-level memory waste and produces the small one-click binary.

**Why this is cheaper here than usual:** DeckHost was written **Electron-free from day one** — the engine-facing core never imports Electron and runs under any host that can feed it the three-channel IPC surface. That seam was built in advance.

**Scope:**
- Re-implement the three IPC channels (`deck:invoke`, `deck:events:batch`, `deck:events:replay`) as Tauri commands/events.
- Engine host runs as a **Node sidecar** (spawned + supervised by the Rust shell) in this stage.
- Frontend port: chat, overview, command, findings, crew (model pool), status bar.

**Gate 1:**
1. Deck opens; chat runs a trivial brief end-to-end locally.
2. RAM drop confirmed vs the Electron build in Task Manager.
3. **Preview-sandbox decision (the make-or-break item):** Electron's `WebContentsView` sandbox has no Tauri equivalent. Decide and document one of: (a) preview stays Electron-only behind a flag, (b) sandboxed iframe downgrade with re-verified escape tests, (c) defer preview. The escape-test suite must pass in whichever form ships.

*Reversible by design: the Electron build is retained as fallback. **Timebox: 2–3 weeks — if exceeded, ship the Electron exe and defer. Cosmetics must not block momentum.***

---

## §1.5 Stage 1.5 — Sidecar measurement *(the decision point that prioritizes Stage 2)*

After Tauri ships, measure: steady-state RAM with the Node sidecar vs the Electron baseline, exe size, cold-start time, and sidecar IPC overhead.

**Decision rule:** if the sidecar eats the memory win (likely — ~50 MB of Node runtime), *that data* is what promotes Stage 2 from "someday" to "next". The numbers decide, not enthusiasm.

---

## §2 Stage 2 — Rust hot core *(the performance seam)*

Port the two genuinely hot, concurrency-sensitive, self-contained pieces, bound to the TS engine via local IPC:

1. **The vector store** — cosine search over the in-memory index (`STATE/vectors.json`), including decay.
2. **The Zeak transport decorator** — Cache-Gate / Pruner / Capper / Early-Stopper / predictive stop.

**Golden-test discipline:** the Rust ports must produce **byte-identical outputs** vs the TS versions on the same inputs, and show a **measured** speedup on vector lookups before the flag flips. The TS versions remain the default behind a config flag — a bad port can never break the system.

*Honest caveat carried from review: at the current 2000-entry vector cap, TS search is already sub-millisecond — the golden tests exist precisely to prove or kill this stage's value at real scale.*

---

## §3 Stage 3 — Engine strangling *(optional, no deadline)*

Rebuild the engine module-by-module in Rust behind the existing seams, in dependency order:

**Contract/State → Compactor *(+ the Zeak v2 learning loop, which travels with it)* → Laya → departments → crew → leader → merge**

**The learning loop's home:** the TRY BOX / Model 2 / Model 3 / guides-decay machinery ports **with the Compactor module** — it is wired into the compaction cycle, and guides decay is Compactor-owned. Its golden tests carry **one extra assertion beyond byte-identical outputs: the "no wrong guide" property** — given a TRY BOX history containing one-off failures, the Rust port must refuse to emit a guide exactly where the TS version refuses. Byte-identical success paths are necessary but not sufficient for a component whose failure mode is silently learning a bad rule. That single assertion protects the system's long-term intelligence during the port.

**Gate 3 (per module):** all existing tests pass against the Rust module before the TS module is deleted. The stage can take months or stop at 50% forever without harm — every completed module is independently valuable.

---

## §4 Stage 4 — Lua hooks *(optional extensibility — "Rust for the bones, Lua for the hooks")*

Embedded sandboxed user hooks in the Rust host via **`mlua`**: user-scriptable Laya scoring, security rules (Dept 5), guide filters, and Zeak budget policies. Neovim/Redis precedent: sandboxed scripting inside a disciplined host. VM: `os`/`io`/`require` stripped, memory + instruction caps per invocation, microsecond-cheap call overhead (no IPC).

**The four pins (governance designed in, not bolted on):**

1. **Hooks must be auditable, or they corrupt the ledger's meaning.** Every hook invocation emits `hook.fired { hookId, hookHash, decision, durationMs }` into the event bridge and audit trail. The Findings feed shows *what made the decision* — "score 7 **via user hook 'auth-is-heavy'**". Trust the decision only when you can see what made it.

2. **Every hook fails *closed*, per type.** The built-in behavior is always the floor; hooks can only tighten or specialize, never remove:
   - Laya scoring hook fails → built-in deterministic scorer stands (routing never hangs on user code).
   - Security rule hook fails → the built-in rule pack still runs (failing open is the one unforgivable direction for Dept 5).
   - Budget policy hook fails → built-in Zeak caps stand, unmodified.

3. **AI-authored hooks are quarantined — the governance lynchpin.** The crew or the TRY BOX loop may *draft* a hook ("auth tasks are always heavy — let me add a Laya rule"), but a draft never executes until **a human approves it**. Hooks live in a **human-approved registry**, hash-pinned so nothing mutates them silently. This rule is the difference between an extension system and an escape hatch.

4. **Hook storage is config-as-code, versioned like the contract.** Hooks live in a versioned, hash-pinned directory — *config, not Brain state* (the Brain holds learned truth; hooks are granted authority). Schema-versioned with the same "readers reject unknown majors" discipline as the State Contract.

**The restraint:** do **not** pull Lua forward. A WASM Lua (wasmoon) could deliver ~80% during the TS era, but it adds a second embedding boundary that gets thrown away at Stage 2 — exactly when the migration is most delicate. Hooks are worth more *after* the Rust host exists: microsecond-cheap, sandbox-solid via `mlua`, no security-gate rework. Stage 4's placement is correct; resist the itch.

---

## §5 Final language map

| Language | Slot | One-line why |
|---|---|---|
| **TypeScript** | Stage 0 + reference implementation behind golden tests | Proves it |
| **Rust** | Stages 1–3: Tauri shell, hot seams, engine | Carries it — memory safety is a *containment* requirement here, not a nicety |
| **Lua** | Stage 4, optional — `mlua` sandboxed hooks: Laya scoring, security rules, guide filters, budget policies | Lets users bend it — safely, auditable, human-gated |
| **Zig** | None | Nothing it offers that Rust doesn't already deliver in this architecture |
| **C/C++** | None | Memory-safety risk in a system that runs generated code and holds API keys — the wrong trade at any speed |

**The one-liner:** *"Value first, then strangle — Rust for the bones, Lua for the hooks. Hooks propose, humans dispose."*

---

## §6 Worst cases — and what already protects you

| Worst case | Protection |
|---|---|
| Rewrite death spiral (months of porting, nothing ships) | Common-S ships first in TS; migration is additive, never blocks a working system |
| Split-brain divergence (two codebases drift) | Stage 2+ ports live behind seams with golden tests; TS stays the reference until each gate passes |
| Rust learning curve stalls you | Stages are independently valuable — stopping after Stage 1 still leaves you better off |
| Tauri webview breaks the UI / preview | Electron build retained; Stage 1 is reversible by design |
| Migrating before the design is proven | Gate 0 exists to prevent optimizing an unproven system |
| AI-authored hooks corrupt governance | Pin 3: hooks propose, humans dispose; hash-pinned registry |
| A hook bug widens what passes security | Pin 2: fail-closed per type; built-ins are the floor |

---

## §7 The one refused mistake

**Starting with Stage 3.** Rewriting the engine first — while Common-S's real-world run is unproven and the shell is unswapped — is the big-bang trap in its purest form. That is the path where projects die.

## §8 Next action

**Gate 0: the deck-run.** Cheapest step, biggest proof. One trivial local brief, one forced-handoff heavy brief, both in the running deck — then Stage 1 begins.

---

## §9 Gate checklist *(the migration's own State Contract — tick in a diff, never renegotiate at 2 AM)*

- [ ] Gate 0: trivial local deck-run (contract written, compaction fired, learning cycled)
- [ ] Gate 0: heavy brief survives forced handoff — heavy run completed with findings raised, but both tasks succeeded first try (normalization fixed the failure mode), so no handoff was organically forced; scripted handoff coverage remains in gate.mjs Gate 7. Re-run until an organic handoff occurs
- [ ] Gate 1: Tauri deck opens, trivial brief end-to-end
- [ ] Gate 1: RAM drop confirmed vs Electron baseline
- [ ] Gate 1: preview-sandbox decision documented + escape tests pass
- [ ] Gate 1.5: sidecar RSS measured, Stage 2 priority decided by numbers
- [ ] Gate 2: golden tests byte-identical, vector speedup measured
- [ ] Gate 3: per-module — tests green before TS deletion (learning loop travels with the Compactor; "no wrong guide" assertion green)
- [ ] Gate 4: hook.fired audit, fail-closed matrix, human-approved registry
