# Thinking Integration — reasoning protocols + native effort

Source material: `system_prompts_leaks-main/` (verbatim public system-prompt
leaks), specifically three sources chosen for reasoning capability:

1. **OpenAI GPT-5 Thinking prompts** (`OpenAI/gpt-5*-thinking.md`) — factuality
   and decision-boundary discipline.
2. **Claude Code system prompt** (`Anthropic/claude-code/claude-code-opus-5.5.md`)
   — agentic execution discipline and the `reasoning_effort` scale.
3. **prompt-audit guidance** (`Anthropic/claude-code/skills/claude-api/shared/prompt-audit.md`
   and the bundled `SKILL.md`) — *how* to make models think harder on 2026-era
   reasoning models.

Nothing is copied verbatim. The prompts below are paraphrased into deck
vocabulary; the wire fields follow the API contracts documented in the leaked
claude-api skill.

## The governing finding (prompt-audit)

On current reasoning models, prose steering ("think step by step", "think
harder") is a dated idiom — thinking is on by default and depth is controlled
by **effort configuration** and **task structure**, not incantations. So the
integration has exactly two levers, and deliberately none of the third:

| Lever | Where | Default |
|---|---|---|
| Native reasoning effort (thinking depth on the wire) | `ModelRef.reasoningEffort` → adapters | **unset = wire byte-identical to shipped shape** |
| Operational reasoning protocols (what to consider, what to verify) | user messages + worker prompt section 6 | **on** |
| "Think step by step" prose | — | never added |

## Lever 1 — `reasoningEffort` (config → registry → wire)

Set per model in crew config (validated by zod, optional, five Claude Code
tiers: `low | medium | high | xhigh | max`):

```jsonc
{
  "crew": {
    "lead":    { "id": "lead", "provider": "anthropic", "model": "claude-opus-5-5",
                 "endpoint": "…", "contextWindowTokens": 1000000, "reasoningEffort": "xhigh" },
    "engineers": [ { "…": "…", "reasoningEffort": "high" } ]
  }
}
```

How each adapter puts it on the wire when set (opt-in only — unset changes
nothing):

- **anthropic**: `output_config: { effort: <tier> }` — GA, all five tiers;
  thinking itself is adaptive/on by default on current models, so the deck
  never sends `thinking: {type:"enabled", budget_tokens}` (a 400 on current
  models). Grounded in the leaked claude-api skill (`SKILL.md` effort table).
- **openai-compatible**: `reasoning_effort: <tier>` (low/medium/high are the
  universally accepted values; xhigh/max pass through for servers that take
  them).
- **custom**: same OpenAI-style `reasoning_effort` field.

Guidance from the same skill: `high` is the agentic sweet spot, `xhigh` is
the best setting for coding/agentic work on current Claude models, `max` only
when correctness matters more than cost. Judge cost per completed task, not
per request.

## Lever 2 — operational reasoning protocols (default on)

### Leader `plan()` — decomposition protocol

Rides in the **user message** (`TASK_DECOMPOSITION` section), not the system
prompt, so it applies in both configurations — built-in system prompt *and*
a lead persona body (which replaces the system prompt verbatim, Phase-3
contract). Content: sequence tasks by dependency, smallest viable path set,
every acceptance criterion must name its proving check, commit to one
decomposition (Claude Code: "a recommendation, not a survey").

### Leader `verify()` — evidence discipline

User-message protocol after the `Criterion:` line (line order preserved for
the criterion-regex consumers): GPT-5 factuality ("a claim without a citation
is satisfied: false") + Claude Code faithful reporting ("if a check could not
be executed, report satisfied: false — never guess a pass") + judge only what
is written.

### Worker prompt — `## 6. Execution Protocol`

Fixed, budget-counted section in `buildPrompt` (present in both budget
branches, slots 1-5 untouched): read before write and match surrounding
style; smallest change (Claude Code); verify-then-claim with verbatim failure
reporting; rabbit-hole rule (2-3 failed attempts at the same approach → stop
and reassess).

## Considered and rejected

- **Two-pass deliberate→commit in `plan()`** (extra transport call feeding a
  free-form analysis into the decomposition call): doubles plan cost and
  call-count-sensitive behavior for a gain the native effort knob already
  delivers via hidden reasoning at `high`/`xhigh`. Revisit only if effort
  tuning proves insufficient.
- **Default-on wire effort**: rejected — unknown fields can 400 strict
  endpoints, and current Claude models reject `budget_tokens` outright. The
  knob is opt-in per model, per endpoint capability.
- **"Think step by step" prose anywhere**: rejected per prompt-audit.

## Tests

`src/transport/reasoning-effort.test.ts` (wire + config), plus additive
protocol assertions in `src/leader/smoke.test.ts` (plan/verify protocols,
Criterion-line order) and `src/crew/smoke.test.ts` (section 6 in both budget
branches).
