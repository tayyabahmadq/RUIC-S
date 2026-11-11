# SECURITY-AUDIT — RUIC Control Deck

Methodology: cloudflare/security-audit-skill (verdict taxonomy + severity anchors,
"missing hardening without reachable protected content is a hardening note"), NOIR
(surface → indicators → data-flow → ranked reversible remediation), Anthropic
Cybersecurity-Skills (per-area workflow + verification). Re-run with:
`python3 scripts/security_audit.py .`

## Result

- **22/22 checks pass**; 0 failing, 0 blocking (confirmed critical/high).
- Coverage ledger: 1 main window (local renderer + preload bridge), 1 sandboxed
  preview WebContentsView (dedicated session), 3 IPC channels, 5 invoke commands,
  no protocol handlers, no auto-updater, no remote content.

## Fixed during this audit

| Severity | Finding | Remediation |
|---|---|---|
| MEDIUM | preview-host: session request filter used a raw URL prefix check | A percent-encoded escape (..%2F) in a subresource URL passes a raw startsWith check while resolving outside the output directory after decoding. Fixed: the filter now decodes (fileURLToPath), resolves dot segments (path.resolve) and compares against the resolved root; any parse failure fails closed (cancel). |
| LOW | main window had no navigation/window-open/permission guards | The renderer is local and CSP-restricted, so reachability was unproven (hardening note per anchors) — hardened anyway: will-navigate blocked for non-file URLs, window.open denied, permission requests denied by default. |
| LOW | main window ran with sandbox:false | The preload only uses contextBridge + ipcRenderer (both available to sandboxed preloads), so the full Chromium sandbox can stay on. Flipped to sandbox:true. |
| LOW | unknown invoke command types fell out of the switch | An unrecognized command.type returned an undefined response shape. Fixed: default case returns {ok:false, error:"unknown command: …"}. |

## Checklist results

| Area | Check | Status | Detail |
|---|---|---|---|
| webPreferences | main window contextIsolation:true | PASS | app/src/main/index.ts |
| webPreferences | main window nodeIntegration:false | PASS | app/src/main/index.ts |
| webPreferences | main window sandbox:true | PASS | app/src/main/index.ts (hardened this audit) |
| webPreferences | preview sandbox+CI+no-node+webSecurity | PASS | app/src/main/preview-host.ts |
| webPreferences | no unsafe webPreferences flags anywhere | PASS | clean |
| preload | bridge uses fixed channel constants (no dynamic names) | PASS | app/src/preload/bridge.ts |
| preload | preload exposes exactly one global, no node/fs/env | PASS | app/src/preload/index.ts — no fs/child_process/os/path/process require |
| ipc | exactly three allowlisted channels installed | PASS | deck:invoke (handle) + deck:events:replay (on) + deck:events:batch (send); nothing else |
| ipc | unknown invoke commands rejected explicitly | PASS | deck-host.ts: default case returns ok:false (added this audit) |
| guards | main window: will-navigate blocked for non-file URLs | PASS | app/src/main/index.ts (added this audit) |
| guards | main window: window.open denied | PASS | app/src/main/index.ts (added this audit) |
| guards | main window: permission requests denied by default | PASS | app/src/main/index.ts (added this audit) |
| guards | preview: navigation/redirect/webview/window-open all blocked | PASS | app/src/main/preview-host.ts |
| csp | renderer CSP present | PASS | default-src 'self' file:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' |
| csp | no unsafe-inline/unsafe-eval for scripts | PASS | script-src free of unsafe-* directives |
| remote-content | no remote URL is ever loadURL-ed in main | PASS | preview-host.ts: fileUrl |
| traversal | preview request filter decodes + resolves before prefix check | PASS | preview-host.ts (hardened this audit: raw startsWith admitted ..%2F) |
| traversal | preview entry must be listed, HTML, resolve inside outputDir | PASS | preview-host.ts open() |
| containment | preview session cancels non-outputDir requests + denies permissions | PASS | dedicated session.fromPartition per preview instance |
| secrets | no secrets/env in renderer or preload | PASS | clean |
| external | no shell.openExternal usage | PASS | none |
| supply-chain | npm audit (prod deps): no high/critical | PASS | total vulnerabilities: 0 |

## Hardening notes (not findings — no proven reachability)

- No auto-updater is configured: there is no update feed to attack, but release hardening (code signing, asar integrity, Electron fuses: runAsNode/nodeCliInspect off) must be added before any packaged distribution.
- The renderer loads only local files and the CSP blocks remote scripts; keep it that way — remote content must only ever appear inside the sandboxed preview.
- IPC payloads are trusted from our own renderer today; if the renderer ever renders attacker-supplied text into command payloads, add schema validation (zod/ajv) at the ipc.ts boundary.

## Verdict policy

Confirmed findings get severity (critical: unauthenticated code execution /
arbitrary file R+W / credential-store compromise; high: full defeat of an explicit
control; medium: boundary violation with limited blast radius; low: hardening with
plausible-but-unproven reachability; info: minimal impact). `needs_validation` items
never carry severity. Static evidence is not proof of exploitability.
