# RUIC Control Deck — "Deep Signal" Design System

The deck's visual language: **black surfaces, cyan-blue accent, red reserved
for errors** (the user's explicit palette), applied over the structure of the
user's reference video — a dense dark ops-dashboard (near-black canvas, hairline
borders, translucent-fill mono chips with status dots, big mono KPI numbers,
tracked micro-labels, restrained accent glow).

Reference lineage, in order of influence:
1. **The user's video** (`upload/VID_20261105_005528_040.mp4`) — layout
   language, chip/badge pattern, mono-numbers signature, glow aesthetic.
2. Ten design repositories: [ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill),
   [framer-motion](https://github.com/iamshaunjp/framer-motion),
   [ponytail](https://github.com/DietrichGebert/ponytail),
   [hallmark](https://github.com/Nutlope/hallmark),
   [open-pencil](https://github.com/open-pencil/open-pencil),
   [claude-design-skills](https://github.com/master5d/claude-design-skills),
   [design-motion-principles](https://github.com/kylezantos/design-motion-principles),
   [awesome-design-md](https://github.com/VoltAgent/awesome-design-md),
   [oil-ui](https://github.com/oil-oil/oil-ui),
   [impeccable](https://github.com/pbakaus/impeccable).

Everything is implementable within the project's constraints: vanilla
HTML/CSS/TS, no bundler, strict CSP (`script-src 'self'`, no external fonts),
mono identity. **No bridge, reducer, or engine surface changed** — all edits
are presentation-layer (`style.css`, renderer DOM/markup, one main-process
background color).

---

## 1. Surfaces — near-black ladder, hairlines only

Elevation is expressed as **lightness, never shadow** (hallmark `dark-mode.md`:
in dark themes elevation *lightens*). One cool near-black family across the
ladder, matching the video's `#0A0A0C` canvas world:

| Token | Value | Role |
|---|---|---|
| `--bg3` | `#060608` | deepest chrome: activity rail, status bar |
| `--bg2` | `#0b0b0e` | sidebar, composer strip, titlebar |
| `--well` | `#07070a` | inset inputs — **darker than their surround** |
| `--bg` | `#0d0d11` | the page — the work surface |
| `--panel` | `#131318` | raised cards — **lighter than the page** |
| `--panel2` | `#1a1a21` | hover step |
| `--edge` | `#23232b` | hairline border |
| `--edge-hi` | `#34343e` | hover hairline |

Rules: cards rest on 1px borders (border XOR shadow — the *only* exception is
the accent glow, below); border width never changes on state; inputs sit in
dark wells; surfaces step ≈3–6% lightness.

## 2. Type — mono identity, real ramp, tabular figures

The deck is all data (ids, paths, tokens, phases), so mono stays the identity —
and it matches the video, where **mono digits are a signature element** (all
metrics, badges, and code are mono). Fixed ramp, no in-between sizes:

| Step | Value | Use |
|---|---|---|
| micro | 10px | eyebrows, table headers, timestamps, badges |
| chrome | 11px | secondary chrome, meta lines, feed rows |
| body | 12px | default body |
| control | 13px | inputs, buttons, composer |
| title | 16px | view titles |

Line-height 1.65–1.7 on dark surfaces ("dark needs air"); tracked uppercase
(0.08–0.16em, weight 600) reserved for **short markers only** — the video's
micro-labels ("LIVE RELAY", "IN FLIGHT") pattern. `font-variant-numeric:
tabular-nums` on every figure that updates, so digits never jitter.

## 3. Color — cyan-blue accent, black, red = errors

Exactly one accent — **cyan-blue `#38bdf8`** (hover `#7dd3fc`, ink-on-accent
`#04222f`) with fixed jobs: focus, active nav, selection, the single primary
control. Every other hue has one fixed job:

| Hue | Job |
|---|---|
| cyan-blue `#38bdf8` | focus / active / primary / ids — the video's "Healthy + links" energy, user-specified |
| red `#ff5d67` | **errors only** — critical/high findings, failed tasks, abort, alert rows (user-specified) |
| green `#3ed598` | done / healthy / on — the video's positive-delta green |
| gold `#e0b34e` | economics — token counters, Zeak tags (the video's forecast-yellow) |
| amber `#dfc07e` | waiting / claimed / medium severity |
| tan `#c9b99a` | chrome text |
| pink `#c586c0` | tags / keywords |

Text: 4 levels, off-whites, never `#fff` — `--fg-hi #eef0f6`, `--fg #c9cdd8`,
`--muted #8f95a4` (readable meta), `--muted2 #6b7180` (faint, decoration
only). All body pairs verified ≥4.5:1, UI glyphs ≥3:1 (67 automated
Chromium-computed contrast checks in `tools/verify/ui_verify.py`).

**Status is never color-only**: severity and task status carry a glyph
(▲ ◆ ● / ✓ ✕ ◍) + the word, and findings wear a same-hue tint fill +
same-hue hairline (open-pencil's severity pattern; the video's badge chips:
translucent colored fill + colored text).

**Glow — the video's signature, kept restrained**: a cyan glow token
(`0 0 0 1px rgba(56,189,248,.28), 0 0 22px rgba(56,189,248,.14)`) appears only
on focus-within of the composer, primary-button hover, the send button hover,
the active nav item (14px, .12 alpha), and the watermark's text-shadow. Nothing
else glows.

## 4. States — visible, fast, constant-size

- **Focus**: `:focus-visible { outline: 2px solid var(--accent); offset: 2px }`
  on every control; inputs swap border-color instead (their own affordance).
- **Press**: `transform: scale(.94–.98)` at 120ms — never a size change.
- **State transitions**: 180ms `cubic-bezier(.22,1,.36,1)`, color/border only.
- **Disabled**: `.55` opacity + `cursor:not-allowed`; hover neutralized.
- **Live indicators**: soft 2.4s pulse gated behind
  `prefers-reduced-motion: no-preference`.

## 5. Motion — 220ms enters, GPU-only, append-only

New stream/feed rows enter with `opacity 0→1 + translateY(6px)` at 220ms
ease-out — **only when rows are genuinely new**. `app.ts` diffs lists
(`listMode`) before rendering: a no-op re-render (the 1s timer) appends
nothing and animates nothing; a batch larger than 8 rows is a reconstruction,
so it renders without a wall of motion. Chat autoscroll is foot-aware.

The token bar animates `transform: scaleX()` (GPU-composited) instead of
`width` — no layout thrash under live updates. Reduced motion: global
`@media (reduce)` clamps every animation/transition to `.01ms`.

## 6. Chrome theming

Selection tinted from the accent; caret accent-colored; native checkboxes use
`accent-color`; scrollbars 8px, transparent track, quiet thumb. Electron
window `backgroundColor` matches the page (`#0d0d11`) so first paint never
flashes.

## 7. Where each decision came from

| Decision | Source |
|---|---|
| Near-black ladder, panels lighter, wells darker | the reference video (`#0A0A0C` world), hallmark dark-mode, Linear |
| Translucent-fill mono chips + status dots | the video's badge chips, open-pencil severity pattern |
| Mono digits as signature | the video (all metrics mono), Warp "mono for technical" |
| Tracked micro-labels for short markers | the video ("LIVE RELAY"), impeccable typeset rules |
| Restrained accent glow on focus/primary moments | the video's glow aesthetic, scoped by border-XOR-shadow discipline |
| Cyan-blue accent + red = errors only | the user's explicit palette |
| One accent + accent-ink on fills | hallmark "Dusk" |
| 4-level off-white text, never #fff | Linear, impeccable |
| Type ramp 10–16, tabular-nums | impeccable |
| Focus ring 2px offset 2, :focus-visible only | oil-ui, WCAG 2.2 |
| 180ms states / 120ms press / 220ms enters | design-motion-principles, Emil Kowalski |
| Append-only list rendering, no anim on re-render | design-motion-principles (high-frequency streaming gate) |
| scaleX progress fills | design-motion-principles (never animate width) |
| Reduced-motion gating | design-motion-principles, oil-ui |
| Empty states differentiated by cause | open-pencil patterns |
| 8px quiet scrollbars, themed selection | impeccable craft-floor |

## 8. Verification

- `npm run build` — strict tsc, green.
- `npm test` — 13/13 (bridge contract, reconstruction equivalence, key
  isolation, FreeLLM failover) green with the retheme in place.
- `python3 tools/verify/ui_verify.py` — **97/97** automated UI checks (Chromium
  computed styles): contrast pairs, focus rings, overflow, scaleX bar,
  append-only animation, empty states, per-view element presence, **theme
  assertions** (accent is cyan-blue; page is near-black; red appears only on
  error severity and alert rows; low severity stays green; composer glow) —
  plus the v2 suite (⌘K palette open/filter/run/Escape, kbd chips, hero CTA,
  ambient chip states, border beam, spotlight tracking, shimmer/halo keyframes,
  stagger delays, ticker values, visibility-gated render loop) and the v3
  suite (conversational turns, human bubble alignment, advanced panel
  open/close/prefill, goal parsing, description merge, palette integration).
- `python3 scripts/security_audit.py .` — 22/22 (see `SECURITY-AUDIT.md`).
- Pixel checks on screenshots: cyan/mint/red hues present; chrome corner
  near-black; 13 shots content-bearing.
- Gate items failing in this sandbox (engine `DECISIONS.log` is gitignored so
  absent from fresh clones; no X server for the Electron GUI items) fail
  identically on the pristine tree — verified by stash + re-run in the prior
  session.
- Headless-harness note: page timers/rAF only advance while an evaluate is in
  flight, so time-dependent checks settle with an in-page wait; the ticker
  carries a timeout fallback so real windows (and minimized ones) always
  settle too.

## 9. v2 — the resource-mapped upgrade layer

The second pass mapped the user's resource list onto layers (see
`LAYER-MAP.md`); the UI additions all live in `style.css` §v2 and the cmdk /
ticker / spotlight / ambient modules of `app.ts`:

- **⌘K command palette** (navbar.gallery command bar + 21st.dev menu) —
  titlebar hint with `kbd` chip, overlay panel, subsequence fuzzy filter,
  grouped sections, ↑↓/↵/Esc keyboard flow, ARIA listbox, actions that call
  the app's real handlers (no second behavior path).
- **Border beam** (Magic UI) — a conic light streak laps the composer border
  while focused (`@property --beam-angle`, masked gradient, 3.6s).
- **Shimmer + halo** (Magic UI) — LIVE chips sweep; the send button breathes a
  cyan halo while a run is live. Gated behind `prefers-reduced-motion:
  no-preference`.
- **Spotlight** (Aceternity) — stat cards paint a radial glow that follows the
  cursor via `--mx/--my` (one delegated passive listener).
- **Number ticker** (Magic UI) — KPI values count up on change with cubic
  ease-out, instant first paint, rAF + timeout fallback, reduced-motion
  instant.
- **Dot pattern + stagger** (Magic UI) — the chat empty state sits on a fading
  accent dot grid; appended chat/feed rows cascade at 40ms intervals.
- **Hero CTA + microcopy** (cta.gallery) — one dominant primary control on the
  empty state ("Compose the brief") with the reassurance line beneath it;
  quick-start prompts become the secondary tier.
- **Ambient chip** (coucou) — amber *waiting for you* → accent *working —
  phase* → mint *run complete*, in the chat header, dot + word.
- All effects remain inside the Deep Signal discipline: hairlines elsewhere,
  glow only on accent moments, nothing requires external assets or inline
  handlers (CSP intact).

## 10. v3 — the chat box + advanced options composer

The chat view is now an actual conversation between the human and the system,
with the Goal/Description blocks moved out of a dedicated view and into an
on-demand form under the composer.

- **Conversational turns.** `run.started` no longer prints a log line
  ("Run opened — brief …"); the crew replies ("On it. Crew dispatched… I'll
  verify: …") and every follow-up speaks in chat voice (`laya`, `zeak`,
  `security`, `ruic` closers). The user's message renders as a right-aligned
  bubble labeled *you* — a renderer-local event (`run.started.human`, id
  prefixed `human-`, never journaled; the journal keeps only real engine
  events) that rides the same stream pipeline, so ordering, dedup, stagger,
  and autoscroll treat it like any other turn.
- **Advanced options.** A quiet caret toggle under the input flips the
  composer from Chat Box to the Goal/Description form: *goal* (comma-separated
  success criteria the run is verified against, prefilled `app builds`) and
  *description* (context appended to the brief for every department). First
  open copies an unsent composer message into description. `aria-expanded` /
  `aria-controls` wired; panel reveal is a 160ms fade-rise, reduced-motion
  aware.
- **One pipeline.** The message is the brief; description is appended with a
  `[description]` marker; goal parses into `goalState`. The former Command
  view and its nav entries are gone — chat is the only door. The ⌘K palette
  learned three new actions (send, toggle advanced, abort) and lost the dead
  Command entry.
- Human bubble: `row-reverse` + `accent-dim` fill + asymmetric radius
  (`r-lg r-xs r-lg r-lg`); avatars stay on engine turns only.
