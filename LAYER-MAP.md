# LAYER-MAP — every listed resource, mapped to the right layer

Each resource below was researched (live fetches where reachable), distilled
into adoptable patterns, and landed in the codebase under its layer. "Landed"
points at the actual file/behavior. All changes are verified: engine tests
177/179 (2 pre-existing baseline failures unrelated to UI), app tests 13/13,
UI verification 87/87, security audit 22/22.

## 1. UI layer — the operator console (`app/src/renderer/`)

| Resource | Adopted | Landed in |
|---|---|---|
| **navbar.gallery** | Sticky command-bar with a ⌘K search hint + `kbd` affordance chips; taxonomy (command bar, tabs, breadcrumbs) | Titlebar `#cmdkHint`, `kbd` chip system, `style.css` §v2 |
| **jiro.build** | "Glow Button" / "Electric Border" treatments (kept disciplined: accent moments only) | `.btn.primary:hover`, `.chatcard:focus-within` glow tokens (v1) + border beam (v2) |
| **footer.design** | Three-segment footer organization (context · live state · meta), small-caps metadata labels | Status bar segments (`sb-item`, `sb-branch`, `sb-gold`, `sb-remote`) |
| **cta.gallery** | One dominant CTA per region + reassurance microcopy; ghost secondary | Chat empty-state hero CTA `#heroCta` + `.cta-micro` ("runs locally · keys never leave the main process"); Command view Run button stays the only filled button |
| **styles.refero.design** | "Midnight command center / abyssal terminal" descriptors: hairline grid rules, depth from lightness not shadow, weight-over-size type | Deep Signal surface ladder + type ramp (`DESIGN.md` §1–2) |

## 2. Motion & component layer (vanilla ports — no React, CSP-safe)

| Resource | Adopted | Landed in |
|---|---|---|
| **magicui.design** | Border Beam (conic-gradient `@property --angle` on the focused composer); Shimmer sweep on LIVE chips; Number Ticker (rAF + timeout fallback); Dot Pattern (chat empty state); Blur Fade stagger (40ms/row, append batches only); Pulsating halo (send button when live) | `style.css` §v2 motion block; `app.ts` `tickTo()`, `stagger()` |
| **ui.aceternity.com** | Cursor Spotlight on stat cards (passive pointermove → `--mx/--my` radial glow) | `app.ts` `initSpotlight()`, `.stat::after` |
| **animate-ui.com** | Spring-overshoot press feel via `cubic-bezier(.34,1.56,.64,1)`-family `--ease-snap`; animated state transitions kept at 180ms | `--t-press`/`--ease-snap` tokens (v1), applied to all controls |
| **21st.dev** | Command-menu interaction pattern (input + grouped sections + keyboard nav + ARIA listbox) | `app.ts` cmdk module (`cmdkItems/cmdkFilter/cmdkRenderList`), `#cmdkOverlay` |
| **promptedsite.com** | WebGL 3D scenes marked NOT PORTABLE → closest analog: subtle dot-grid + glow depth (no canvas assets under CSP) | `.chat-empty` backdrop; documented decision |

## 3. Security layer (`app/src/main/`, `scripts/security_audit.py`)

| Resource | Adopted | Landed in |
|---|---|---|
| **cloudflare/security-audit-skill** | Six-phase audit: coverage ledger, verdict taxonomy (confirmed / needs_validation / rejected), severity anchors, "missing hardening without reachable content = note, not finding" | `scripts/security_audit.py` (22 automated checks) → `SECURITY-AUDIT.md` + `findings.json` |
| **Verlintas/NOIR** | Audit flow shape: enumerate surface → extract indicators → severity-ranked, reversible remediation → machine-readable report | `findings.json` structure; fixed-findings table with before/after |
| **mukul975/Anthropic-Cybersecurity-Skills** | Skill anatomy (workflow + verification per area); supply-chain/SBOM emphasis | `npm audit --omit=dev` gate in the audit; checklist areas mirror skill domains |

**Confirmed + fixed during this audit:** preview request-filter percent-encoding
traversal (`..%2F`) → decode+resolve+fail-closed; missing main-window
navigation/window/permission guards → added; `sandbox:false` → `sandbox:true`;
unknown invoke command returned undefined → explicit rejection.

## 4. Architecture + planner layer (`opus-deck-software/`, docs)

| Resource | Adopted | Landed in |
|---|---|---|
| **codecrafters-io/build-your-own-x** | Track→layer mapping and design principles: Git's hash-chained object model (event-log integrity), DBDB's storage/query split (COW snapshots for merge diffs), Redis single dispatch loop (DeckHost), SQLite plan-before-execute (Laya plans logged before execution — already true via `laya.routed`), MQTT topic routing + inverted index (documented roadmap) | `ARCHITECTURE.md` §track mapping; plan-before-execute verified in `routing/laya.ts` event order |

## 5. Crawl layer (`opus-deck-software/src/depts/data-collection.ts`)

| Resource | Adopted | Landed in |
|---|---|---|
| **tiliondev/fortress** | Fortress is a stealth-Chromium product, not a crawler — adopted its *taxonomy*: capability recorded in `via` ('web'), failure classification (robots/ssrf/timeout/size/http), API-before-DOM preference, gauntlet-style regression tests; built natively what it lacks: robots.txt Disallow honoring, SSRF guard, per-host politeness gap, size-capped reads | New `WebFetchCollector` in the Dept-2 fallback chain (`github → web → agent-reach`), 8 dedicated tests in `data-collection.web.test.ts` |

## 6. View layer (console behavior)

| Resource | Adopted | Landed in |
|---|---|---|
| **Louis-CFM/coucou** | Three-state ambient color language (amber = waiting for you, accent = working, mint = done) as a persistent header chip; "paused when nothing is watching" — render loop gated on view visibility; blocking-approval and per-department pills documented as roadmap | `#ambientChip` + `ambientState()`; visibility-gated render loop + `__deckRenderState` hook |

## 7. Cloning / ideation layer (workflow + roadmap)

| Resource | Adopted | Landed in |
|---|---|---|
| **JCodesMore/ai-website-cloner-template** | Map → Observe → Build → Compare pipeline as the crew workflow for site briefs; "references, not implementation" (extracted site = spec); evidence-first observation (structured page briefs, asset maps with content-type verification) maps onto Dept-2 output | `ARCHITECTURE.md` §clone workflow; `WebFetchCollector` emits structured text briefs (title + extracted text + source URL), not raw HTML dumps |

## Efficiency changes ("really efficient and powerful")

| Change | Where | Effect |
|---|---|---|
| Render loop pauses when the window is hidden, resumes + renders on visibilitychange | `app.ts` `startTimer` + visibilitychange listener | Zero idle CPU while backgrounded |
| Renderer event tail capped at 2000 (journal of record stays complete in main) | `app.ts` applyBatch | Bounded memory on long runs |
| Token bar animates `transform: scaleX` (GPU-composited), not `width` | v1 + verified 87/87 | No layout thrash under live updates |
| Number ticker animates only on change; instant first paint; timeout fallback | `app.ts` `tickTo` | No per-second DOM writes; correct even when rAF is starved |
| Append-only stream/feed rendering with no-op detection | v1 `listMode` | Re-renders (1s timer) do zero DOM work when nothing changed |
| One delegated passive pointermove for all spotlight cards | `app.ts` `initSpotlight` | O(1) listeners regardless of card count |
| Direct web collection with cache-gate-first ordering | `wiring/index.ts` chain | Free sources before paid browser time; repeat research served from the Brain at zero cost |
