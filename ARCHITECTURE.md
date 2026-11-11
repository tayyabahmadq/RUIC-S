# ARCHITECTURE — RUIC layers, principles, and roadmap

Companion to `LAYER-MAP.md` (which resource landed where) and `DESIGN.md`
(how it looks). This document is the system view: the layer model, the
build-your-own-x principles adopted into it, the crawl design, and the
clone-a-site crew workflow.

## 1. The layer model

```
┌────────────────────────────────────────────────────────────────────┐
│ CONTROL DECK (Electron app)                                        │
│  renderer: chat-first console — 6 views, ⌘K palette, ambient chip   │
│    │ sandbox:true · contextIsolation · CSP · no node                │
│  preload: one bridge object on window.__deckBridge__ (no fs/env)    │
│    │ 3 IPC channels: invoke · events:batch · events:replay          │
│  main: DeckHost (Electron-free core) + PreviewHost (sandboxed)      │
│        + transport factory (lazy builds, FreeLLM failover)          │
└────────────┬───────────────────────────────────────────────────────┘
             │ journal + commands
┌────────────▼───────────────────────────────────────────────────────┐
│ ENGINE (opus-deck-software) — single dispatch loop                  │
│  planner/router   Laya      brief → complexity → executor + budget  │
│  economic guard   Zeak      caps · fallbacks · early stops · learn  │
│  departments      leader · engineers · security (diff scan) ·       │
│                   data-collection (cache-gate → collector chain)    │
│  state            append-only event journal · Brain (vectors) ·     │
│                   TRY BOX · contract · atomic writes                │
│  merge            merge engine → MANIFEST.json → sandboxed preview  │
└────────────────────────────────────────────────────────────────────┘
```

Trust boundaries: renderer never touches Node, the engine, or key material;
generated code never leaves the sandboxed preview; keys resolve only in main
(`transport-factory.ts`); the journal is the single source of truth, replayed
to any renderer at any position.

## 2. build-your-own-x → adopted principles

From [codecrafters-io/build-your-own-x](https://github.com/codecrafters-io/build-your-own-x):

| Track | Principle | Status in RUIC |
|---|---|---|
| Build your own Git (Gitlet/ugit) | Content-addressed, hash-chained objects give tamper evidence and free dedup | **Roadmap**: event ids are sequence-based today; adopt `id = sha256(parentId + canonicalJson)` in the journal for a verifiable chain. Renderer diffing (`listMode`) is id-based and unaffected by the format change. |
| Build your own Database (DBDB) | Separate storage engine from query API; copy-on-write snapshots | **Roadmap**: merge engine can diff two immutable snapshots instead of mutating state; `state/atomic.ts` already isolates write mechanics. |
| Build your own Redis | Single-threaded command dispatch loop, typed error framing | **Adopted in spirit**: DeckHost is a single dispatch loop over the journal; invoke returns `{ok:false,error}` structured errors (now including unknown commands). |
| Build your own SQLite | Plan before execute: compile a query plan, then run it | **Already true**: Laya emits `laya.routed` (decision + score + reasons) *before* execution — the plan is an auditable event, and Zeak can veto spend against it. |
| Build your own MQTT broker | Topic routing with wildcard subscriptions | **Roadmap**: departments currently wire explicitly (`wiring/index.ts`); a `collector.*.<topic>` subscription model would make security/learning subscribe declaratively. |
| Build your own Search Engine | Inverted index + TF-IDF retrieval | **Roadmap**: TRY BOX pattern retrieval over guides/event history. |

## 3. The crawl layer (Dept 2, data collection)

Fortress ([tiliondev/fortress](https://github.com/tiliondev/fortress)) is a
stealth-Chromium with an MCP tool surface (`fetch_protected_page`, `extract_page`,
`crawl_site`, `recon_site_apis`) — adopt its *capability taxonomy and failover
shape*, not a fork. The native collector implements what fortress leaves out:

```
collectTopic(topic)
  1. cache gate  — Brain vector recall ≥ 0.9 → serve free, emit cache_hit
  2. chain       — github (REST, budget 10) → web (this layer) → agent-reach
  3. ingest      — every item → Brain.learn (embed + store)
  4. event       — collector.collected { topic, count, via }   ← 'via' = capability
```

`WebFetchCollector` (via = `web`) guarantees:
- **SSRF guard** — http/https only; loopback, RFC1918, link-local (169.254,
  incl. cloud-metadata), `0.0.0.0`, `::1` hostnames rejected before any I/O.
- **Robots** — `/robots.txt` `User-agent: *` group, longest-match with
  Allow-beats-Disallow-at-equal-length; missing/unfetchable robots = allow.
- **Politeness** — per-host minimum gap (default 1s, injectable clock).
- **Bounded memory** — streamed read capped at 256 KiB/page; over-cap = miss.
- **Structured output** — title + tag-stripped text (≤2000 chars) + source URL:
  a *page brief*, never a raw HTML dump (see §4 Observe).
- **Failure classification** — `missReason ∈ {not-url, ssrf, robots, timeout,
  size, http, error}` so Zeak can budget fallbacks per class (fortress's
  four-layer block taxonomy, adapted).

Upgrade path: insert a fortress-CDP hop between `web` and `agent-reach`
(`connectOverCDP`) when login-walled pages matter — same seam, one more link.

## 4. Clone-a-site crew workflow (ai-website-cloner-template)

The cloner template's pipeline becomes the standard brief shape for site
work, with "references, not implementation" as the cardinal rule — the
extracted site is a *spec*; the crew rebuilds editable structure.

1. **Map** — before any build: source→local route map, file ownership, an
   explicit finish condition. Laya should require this as the plan's first
   milestone (plan-before-execute).
2. **Observe** — evidence-first: screenshots at widths, real assets, computed
   styles, real inputs. Dept 2 emits structured briefs (§3), each observation
   one sample of a rule. Asset maps verify content-type ("a .png URL may
   return AVIF").
3. **Build** — foundations first (tokens, width, fonts), shared components
   with every observed state, then independent sections as parallel tasks
   with per-task finish lines.
4. **Compare** — side-by-side at matched viewport/scroll/state; fix largest
   drift first (geometry → missing sections → typography → assets →
   spacing/motion). On early stop, Zeak logs residual gaps precisely in the
   final event instead of burning tokens chasing pixel-perfection.

## 5. View-layer principles (coucou)

- **Ambient state language**: amber = waiting for you, accent = working,
  mint = done — one glanceable chip computed from the event-log tail; the
  word travels with the hue (never color-only).
- **Attention economics**: the render loop pauses when nothing is watching
  (visibilitychange); animations are append-only and reduced-motion aware.
- **Roadmap** (documented, not built): blocking approvals with Allow/Deny/
  Always wired to TRY BOX guide creation; per-department presence pills;
  diff-ticker with +N −M counts on the findings badge.

## 6. Efficiency ledger

| Change | Cost paid | Payoff |
|---|---|---|
| Visibility-gated render loop | one listener | zero idle CPU while hidden |
| 2000-event renderer tail (journal stays complete in main) | rebuild on overflow | bounded memory on long runs |
| `scaleX` progress fills | none | GPU-only animation, no layout |
| Ticker with change-detection + timeout fallback | one Map | no per-second DOM writes; correct under rAF starvation (headless, minimized) |
| Append-only diffed lists (`listMode`) | small bookkeeping | no-op re-renders cost zero DOM |
| Cache-gate-first collection | Brain embed cost | repeat research is free; paid/browser time only on misses |
| Delegated passive spotlight | one listener | O(1) listeners for all stat cards |
