/**
 * Opus//DECK App â€” Control Deck renderer.
 *
 * A plain browser script: no imports, no bundler. It talks to the main process
 * ONLY through `window.__deckBridge__` (R16) and rebuilds run state purely from
 * the event stream it is handed, so a window opened mid-run reconstructs the
 * same state as one opened before the run (R16 hard requirement).
 *
 * `reconstructState` here is the renderer's OWN reducer â€” intentionally written
 * independently of the host's bookkeeping and of `BT.reconstructState`, so the
 * contract test compares two independent computations. It is exposed (along
 * with the applied-event counter) on `window.__deckInternals__` /
 * `globalThis.__deckInternals__` for that test.
 */

const deckEvents: DeckEvent[] = []
const deckEventIds = new Set<string>()
let deckApplied = 0
let deckCrewHealth: readonly ReconstructedCrewHealth[] = []
let deckState: ReconstructedState = BT.emptyState()
let deckReady = false
let deckRunning = false
let deckHealthPending = false
let deckBridge: DeckBridge | undefined
let deckTimerHandle: number | null = null

/* ------------------------------------------------------------------ *
 * Preview state (R16: preview surface)
 * ------------------------------------------------------------------ */
let deckPreviewOpen = false
let deckPreviewCurrentFile: string | null = null
let deckPreviewFiles: string[] = []

/* ------------------------------------------------------------------ *
 * Reconstruction
 * ------------------------------------------------------------------ */

function reconstructState(events: readonly DeckEvent[]): ReconstructedState {
  const tasks = new Map<string, ReconstructedTask>()
  const findings = new Map<string, ReconstructedFinding>()
  const presence = new Map<string, ReconstructedPresence>()
  const seen = new Set<string>()
  let runId = ''
  let phase: RunPhase = 'idle'
  let startedAt: string | null = null
  let endedAt: string | null = null
  let tokenInput = 0
  const routingNotes: string[] = []
  let tokenOutput = 0

  for (const event of events) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    switch (event.type) {
      case 'run.started':
        tasks.clear()
        findings.clear()
        presence.clear()
        tokenInput = 0
        tokenOutput = 0
        endedAt = null
        runId = event.payload.runId
        startedAt = event.at
        phase = 'planning'
        break
      case 'phase.change':
        phase = event.payload.phase
        break
      case 'task.claimed':
        tasks.set(event.payload.taskId, {
          id: event.payload.taskId,
          file: event.payload.file,
          holder: event.payload.holder,
          status: 'claimed',
        })
        break
      case 'task.completed': {
        const existing = tasks.get(event.payload.taskId)
        tasks.set(event.payload.taskId, {
          id: event.payload.taskId,
          file: existing?.file ?? '',
          holder: existing?.holder ?? '',
          status: 'completed',
        })
        break
      }
      case 'task.failed': {
        const existing = tasks.get(event.payload.taskId)
        tasks.set(event.payload.taskId, {
          id: event.payload.taskId,
          file: existing?.file ?? '',
          holder: existing?.holder ?? '',
          status: 'failed',
        })
        break
      }
      case 'finding.raised':
        findings.set(event.payload.findingId, {
          id: event.payload.findingId,
          severity: event.payload.severity,
          path: event.payload.path,
          line: event.payload.line,
          message: event.payload.message,
          resolved: false,
        })
        break
      case 'finding.resolved': {
        const existing = findings.get(event.payload.findingId)
        if (existing !== undefined) {
          findings.set(event.payload.findingId, { ...existing, resolved: true })
        }
        break
      }
      case 'presence.update': {
        const taskId = event.payload.taskId
        presence.set(event.payload.modelId, {
          modelId: event.payload.modelId,
          role: event.payload.role,
          status: event.payload.status,
          ...(taskId === undefined ? {} : { taskId }),
        })
        break
      }
      case 'token.use':
        tokenInput += event.payload.inputTokens
        tokenOutput += event.payload.outputTokens
        break
      case 'run.completed':
        phase = 'completed'
        endedAt = event.at
        break
      case 'run.failed':
        phase = 'failed'
        endedAt = event.at
        break
      case 'preview.state':
        // Preview state is tracked in dedicated variables (see below),
        // not in the reconstructed state.
        break
      case 'laya.routed':
        routingNotes.push(`Laya routed ${event.payload.decision} (score ${event.payload.score}): ${event.payload.reasons[0] ?? ''}`.trim())
        break
      case 'zeak.fallback':
        routingNotes.push(`Zeak fallback ${event.payload.from} -> ${event.payload.to} (${event.payload.reason})`)
        break
      case 'zeak.early_stop':
        routingNotes.push(`Zeak early-stop after ${event.payload.chunks} chunks (contract satisfied)`)
        break
      case 'zeak.escalation':
        routingNotes.push(`Zeak re-escalated task to ${event.payload.to} (attempt ${event.payload.attempt})`)
        break
      case 'zeak.predictive_stop':
        routingNotes.push(`Zeak predictive stop (${event.payload['signature']}): ${event.payload['guide']}`)
        break
      case 'learning.pattern_found':
        routingNotes.push(`Learning scan found ${event.payload['candidates']} pattern(s)${event.payload['deterministic'] ? ' (deterministic)' : ''}`)
        break
      case 'learning.guide_added':
        routingNotes.push(`Guide added (${event.payload['occurrences']}x seen): ${event.payload['guide']}`)
        break
      case 'learning.guide_rejected':
        routingNotes.push(`Guide rejected for ${event.payload['signature']}: ${event.payload['reason']}`)
        break
      case 'collector.collected':
        routingNotes.push(`Collected ${event.payload.count} item(s) via ${event.payload.via}: ${event.payload.topic}`)
        break
      default:
        break
    }
  }

  const elapsedMs =
    startedAt !== null && endedAt !== null ? Date.parse(endedAt) - Date.parse(startedAt) : 0

  return {
    runId,
    phase,
    routingNotes,
    tasks: [...tasks.values()].sort(BT.compareTasks),
    findings: [...findings.values()].sort(BT.compareFindings),
    presence: [...presence.values()].sort(BT.comparePresence),
    crewHealth: deckCrewHealth,
    tokenSpend: tokenInput + tokenOutput,
    elapsedMs,
    startedAt,
    endedAt,
  }
}

/**
 * Pull crew health over invoke and merge it into the published state. Health is
 * the one piece of state the event stream does not carry (R19: names + health
 * only), so it is (re)fetched at boot AND whenever a run starts â€” main probes
 * the crew at run start, so a window opened before the run must refresh to
 * agree with main's directly-computed expected state.
 */
async function refreshCrewHealth(): Promise<void> {
  const bridge = deckBridge
  if (bridge === undefined) return
  deckHealthPending = true
  try {
    const health = await bridge.invoke({ type: 'crewHealth', payload: {} } as const)
    if (health.ok) {
      deckCrewHealth = health.data.crew
      refresh()
    }
  } catch {
    // crew health is advisory; a failure must never block the deck
  } finally {
    deckHealthPending = false
  }
}

function ingest(events: readonly DeckEvent[]): void {
  let changed = false
  let runStarted = false
  for (const event of events) {
    if (deckEventIds.has(event.id)) continue
    deckEventIds.add(event.id)
    deckEvents.push(event)
    // Memory cap: the journal lives in main; the renderer keeps a bounded
    // tail. Dropping the front flips listMode to 'rebuild' — handled cleanly.
    if (deckEvents.length > 2000) {
      const dropped = deckEvents.splice(0, deckEvents.length - 2000)
      for (const d of dropped) deckEventIds.delete(d.id)
    }
    deckApplied += 1
    changed = true
    if (event.type === 'run.started') runStarted = true
    if (event.type === 'preview.state') {
      const p = event.payload as { runId: string; open: boolean; currentFile: string | null; files: string[] }
      deckPreviewOpen = p.open
      deckPreviewCurrentFile = p.currentFile
      deckPreviewFiles = p.files
    }
  }
  if (changed) refresh()
  if (runStarted) void refreshCrewHealth()
}

function refresh(): void {
  deckState = reconstructState(deckEvents)
  deckRunning =
    deckState.phase !== 'idle' && deckState.phase !== 'completed' && deckState.phase !== 'failed'
  publish()
}

function publish(): void {
  globalThis.__deckState__ = deckState
  if (typeof window !== 'undefined') window.__deckState__ = deckState
  render()
}

/* ------------------------------------------------------------------ *
 * Rendering (DOM only; never mutates the published state)
 * ------------------------------------------------------------------ */

function byId<T extends HTMLElement>(id: string): T | null {
  if (typeof document === 'undefined') return null
  return document.getElementById(id) as T | null
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const total = Math.floor(safe / 1000)
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/** Live timer value for the UI only â€” never written back into deckState. */
function liveElapsedMs(): number {
  if (deckState.endedAt !== null) return deckState.elapsedMs
  if (deckState.startedAt !== null) return Date.now() - Date.parse(deckState.startedAt)
  return 0
}

function clearChildren(node: HTMLElement): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild)
}

function addCell(row: HTMLTableRowElement, text: string, className?: string): void {
  const cell = document.createElement('td')
  cell.textContent = text
  if (className !== undefined) cell.className = className
  row.appendChild(cell)
}

function render(): void {
  if (typeof document === 'undefined') return

  // The two bars (titlebar + statusbar) are one state surface: the same run,
  // phase, and bridge text is written to both, and the "run open" accent is
  // toggled on both in lockstep — idle (closed) and running (open) always agree.
  const runText = `⎇ ${deckState.runId !== '' ? deckState.runId : 'idle'}`
  const phaseText = `phase: ${deckState.phase}`
  for (const id of ['tbRun', 'sbBranch']) {
    const el = byId<HTMLElement>(id)
    if (el !== null) {
      el.textContent = runText
      el.classList.toggle('live', deckRunning)
    }
  }
  for (const id of ['phaseStrip', 'sbPhase']) {
    const el = byId<HTMLElement>(id)
    if (el !== null) {
      el.textContent = phaseText
      el.className = deckRunning ? 'chip accent live' : 'chip dim'
      if (id === 'sbPhase') el.className = deckRunning ? 'sb-item accent live' : 'sb-item dim'
    }
  }
  renderOverviewStats()

  const timer = byId<HTMLElement>('elapsedTimer')
  if (timer !== null) timer.textContent = formatDuration(liveElapsedMs())

  const tokens = byId<HTMLElement>('tokenSpend')
  if (tokens !== null) tokens.textContent = `Tokens: ${deckState.tokenSpend}`

  const taskBody = byId<HTMLTableSectionElement>('taskBody')
  if (taskBody !== null) {
    clearChildren(taskBody)
    for (const task of deckState.tasks) {
      const row = document.createElement('tr')
      addCell(row, task.id)
      addCell(row, task.file)
      addCell(row, task.holder)
      addCell(row, `${STATUS_GLYPH[task.status] ?? ''} ${task.status}`, `status-${task.status}`)
      taskBody.appendChild(row)
    }
    if (deckState.tasks.length === 0) {
      const row = document.createElement('tr')
      row.className = 'tbl-empty'
      const cell = document.createElement('td')
      cell.colSpan = 4
      cell.textContent = 'no tasks yet — the ledger fills as engineers claim work'
      row.appendChild(cell)
      taskBody.appendChild(row)
    }
  }

  const findingsList = byId<HTMLElement>('findingsList')
  if (findingsList !== null) {
    clearChildren(findingsList)
    for (const finding of deckState.findings) {
      const item = document.createElement('div')
      item.className = `finding-item severity-${finding.severity}${finding.resolved ? ' resolved' : ''}`
      const head = document.createElement('div')
      head.className = 'finding-header'
      const id = document.createElement('span')
      id.className = 'finding-id'
      id.textContent = finding.id
      const sev = document.createElement('span')
      sev.className = `finding-sev severity-${finding.severity}`
      sev.textContent = finding.resolved
        ? `✓ ${finding.severity} (resolved)`
        : `${SEV_GLYPH[finding.severity] ?? ''} ${finding.severity}`
      head.appendChild(id)
      head.appendChild(sev)
      const where = document.createElement('div')
      where.className = 'finding-path'
      where.textContent = `${finding.path}:${finding.line}`
      const msg = document.createElement('div')
      msg.className = 'finding-msg'
      msg.textContent = finding.message
      item.appendChild(head)
      item.appendChild(where)
      item.appendChild(msg)
      findingsList.appendChild(item)
    }
    if (deckState.findings.length === 0) {
      const none = document.createElement('div')
      none.className = 'findings-empty'
      none.textContent = 'No findings yet — Dept 5 scans every diff during a run.'
      findingsList.appendChild(none)
    }
  }

  // Common-S: routing + economic-layer visibility (Laya decisions, Zeak
  // fallbacks/early-stops, Data Collection) in the overview + findings feeds.
  const strip = byId<HTMLElement>('phaseStrip')
  if (strip !== null && deckState.routingNotes.length > 0) {
    strip.title = deckState.routingNotes.join('\n')
  }
  renderRoutingNotes('overviewRouting', 'overviewRoutingEmpty')
  renderRoutingNotes('routingFeedHolder', 'routingFeedEmpty')

  /* ---- Preview surface (R16) ---- */
  const previewPanel = byId<HTMLElement>('previewPanel')
  const previewFileList = byId<HTMLElement>('previewFileList')
  const previewOpenBtn = byId<HTMLButtonElement>('previewOpenBtn')
  const previewCloseBtn = byId<HTMLButtonElement>('previewCloseBtn')

  if (previewPanel !== null) {
    previewPanel.classList.toggle('preview-open', deckPreviewOpen)
    if (previewOpenBtn !== null) previewOpenBtn.disabled = deckPreviewOpen
    if (previewCloseBtn !== null) previewCloseBtn.disabled = !deckPreviewOpen
  }

  if (previewFileList !== null) {
    clearChildren(previewFileList)
    for (const f of deckPreviewFiles) {
      const item = document.createElement('div')
      item.className = 'preview-file'
      item.textContent = f
      if (deckPreviewCurrentFile === f) item.classList.add('active')
      item.addEventListener('click', async () => {
        const bridge = deckBridge
        if (bridge) {
          await bridge.invoke({ type: 'preview', payload: { action: 'open', runId: deckState.runId, file: f } })
        }
      })
      previewFileList.appendChild(item)
    }
  }
  const rosterBig = byId<HTMLElement>('crewRosterBig')
  if (rosterBig !== null) {
    clearChildren(rosterBig)
    for (const member of deckState.crewHealth) {
      const card = document.createElement('div')
      card.className = 'panel'
      const head = document.createElement('div')
      head.className = 'phead'
      const name = document.createElement('span')
      name.textContent = `${member.id} (${member.role})`
      head.appendChild(name)
      const status = document.createElement('span')
      status.className = `chip ${member.healthy ? 'mint' : 'mut'}`
      status.textContent = member.healthy ? 'healthy' : 'unhealthy'
      head.appendChild(status)
      card.appendChild(head)
      const body = document.createElement('div')
      body.className = 'pbody'
      body.innerHTML = '<div style="font:11px var(--mono);color:var(--muted)">stateless worker · swappable via config</div>'
      card.appendChild(body)
      rosterBig.appendChild(card)
    }
    if (deckState.crewHealth.length === 0) {
      rosterBig.innerHTML = '<div class="crew-empty">probing crew health...</div>'
    }
  }

  renderStream()

  const bridgeStatusEl = byId<HTMLElement>('bridgeStatus')
  const sbBridge = byId<HTMLElement>('sbBridge')
  if (sbBridge !== null && bridgeStatusEl !== null) {
    // Exact mirror — including transient invoke-error text and its warn state.
    sbBridge.textContent = bridgeStatusEl.textContent
    sbBridge.classList.toggle('warn', bridgeStatusEl.classList.contains('warn'))
    sbBridge.classList.toggle('ok', bridgeStatusEl.classList.contains('good'))
  }
  const findingsBadge = byId<HTMLElement>('findingsBadge')
  if (findingsBadge !== null) {
    const open = deckState.findings.filter((f) => !f.resolved).length
    findingsBadge.textContent = String(open)
    findingsBadge.style.display = open > 0 ? '' : 'none'
  }

  // Chat chrome: live pill, phase chip, button states.
  const chatPhase = byId<HTMLElement>('chatPhase')
  if (chatPhase !== null) {
    chatPhase.textContent = deckState.phase
    chatPhase.className = `chip ${deckRunning ? 'accent pulse live' : 'dim'}`
  }
  const chatPill = byId<HTMLElement>('chatPill')
  if (chatPill !== null) chatPill.style.display = deckRunning ? '' : 'none'
  const chatSend = byId<HTMLButtonElement>('chatSendBtn')
  if (chatSend !== null) {
    chatSend.disabled = deckRunning
    chatSend.classList.toggle('live', deckRunning)
  }
  const chatAbort = byId<HTMLButtonElement>('chatAbortBtn')
  if (chatAbort !== null) {
    chatAbort.disabled = !deckRunning
    chatAbort.classList.toggle('hidden', !deckRunning)
  }
  const chatAbortHint = byId<HTMLElement>('chatAbortHint')
  if (chatAbortHint !== null) chatAbortHint.style.display = deckRunning ? '' : 'none'
  renderAmbientChip()
}

/* ── presentation helpers (view layer only — no bridge/logic changes) ── */

/** Severity glyphs — status is never color-only (WCAG): hue + glyph + word. */
const SEV_GLYPH: Record<string, string> = {
  critical: '▲',
  high: '▲',
  medium: '◆',
  low: '●',
}
const STATUS_GLYPH: Record<string, string> = {
  claimed: '◍',
  completed: '✓',
  failed: '✕',
}

/* ── append-only list rendering ─────────────────────────────────────
 * render() fires every second (timer) and once per event batch; these
 * lists are diffed instead of rebuilt, so an enter animation can play for
 * genuinely-new rows only — never on a no-op re-render. */
interface RenderedMark { count: number; first: string; last: string }
const renderedMarks = new Map<string, RenderedMark>()

type ListMode = 'noop' | 'append' | 'rebuild'
function listMode(key: string, count: number, first: string, last: string): ListMode {
  const mark = renderedMarks.get(key)
  if (mark === undefined) return 'rebuild'
  if (count === mark.count && first === mark.first && last === mark.last) return 'noop'
  if (count > mark.count && first === mark.first) return 'append'
  return 'rebuild'
}

/** Feed source tags — one hue per source, scoped to activity tags. */
const FEED_TAG_FOR: ReadonlyArray<{ readonly match: string; readonly tag: string; readonly cls: string }> = [
  { match: 'Laya', tag: 'laya', cls: 'tg-laya' },
  { match: 'Zeak', tag: 'zeak', cls: 'tg-zeak' },
  { match: 'Learning', tag: 'learn', cls: 'tg-learn' },
]
function feedTagFor(note: string): { tag: string; cls: string } {
  for (const src of FEED_TAG_FOR) {
    if (note.startsWith(src.match)) return { tag: src.tag, cls: src.cls }
  }
  return { tag: 'data', cls: 'tg-collector' }
}

/* ── number ticker (Magic UI Number Ticker, vanilla) ────────────────────
 * Count-up on change with cubic ease-out; respects reduced motion. First
 * paint is instant — only CHANGES animate. rAF drives the interpolation
 * with a setTimeout fallback: headless and heavily-throttled pages may
 * starve requestAnimationFrame, and the value must never stick mid-flight. */
const tickerState = new Map<HTMLElement, { from: number; to: number; start: number; raf: number; tid: number }>()
function tickTo(el: HTMLElement, target: number): void {
  const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const existing = tickerState.get(el)
  if (existing !== undefined && (existing.raf !== 0 || existing.tid !== 0)) {
    cancelAnimationFrame(existing.raf)
    clearTimeout(existing.tid)
  }
  const finalText = target.toLocaleString('en-US')
  // No animation needed (first paint, reduced motion, or a canceled in-flight
  // animation for the same value): guarantee the final value is on the element.
  if (existing === undefined || reduce || existing.to === target) {
    if (el.textContent !== finalText) el.textContent = finalText
    tickerState.delete(el)
    return
  }
  const s = { from: existing.to, to: target, start: performance.now(), raf: 0, tid: 0 }
  tickerState.set(el, s)
  const finish = (): void => {
    cancelAnimationFrame(s.raf)
    clearTimeout(s.tid)
    el.textContent = s.to.toLocaleString('en-US')
    tickerState.delete(el)
  }
  const step = (t: number): void => {
    const p = Math.min(1, (t - s.start) / 420)
    if (p >= 1) {
      finish()
      return
    }
    const eased = 1 - Math.pow(1 - p, 3)
    el.textContent = Math.round(s.from + (s.to - s.from) * eased).toLocaleString('en-US')
    s.raf = requestAnimationFrame(step)
  }
  s.raf = requestAnimationFrame(step)
  s.tid = window.setTimeout(() => step(performance.now()), 460)
}

/* ── ambient state chip (coucou's three-state color language) ───────────
 * amber = waiting for you · accent = working · mint = done. Glanceable
 * without switching views; never color-only (word travels with the hue). */
function ambientState(): { cls: string; label: string } {
  if (deckRunning) return { cls: 'work', label: `working — ${deckState.phase}` }
  if (deckState.phase === 'completed') return { cls: 'done', label: 'run complete' }
  return { cls: 'wait', label: 'waiting for brief' }
}
function renderAmbientChip(): void {
  const chip = byId<HTMLElement>('ambientChip')
  if (chip === null) return
  const state = ambientState()
  chip.className = `chip ambient ${state.cls}${state.cls === 'work' ? ' live' : ''}`
  const label = chip.querySelector('.ambient-label')
  if (label !== null) label.textContent = state.label
}

/* ── cursor spotlight (Aceternity, vanilla) ─────────────────────────────
 * One delegated passive pointermove sets --mx/--my on the hovered stat
 * card; the CSS paints a radial glow at that point. */
function initSpotlight(): void {
  if (typeof document === 'undefined') return
  document.addEventListener('pointermove', (e) => {
    const target = (e.target as HTMLElement | null)?.closest?.('.stat') as HTMLElement | null
    if (target === null) return
    const rect = target.getBoundingClientRect()
    target.style.setProperty('--mx', `${Math.round(e.clientX - rect.left)}px`)
    target.style.setProperty('--my', `${Math.round(e.clientY - rect.top)}px`)
  }, { passive: true })
}

/* ── stagger helper (Magic UI Blur Fade) ────────────────────────────────
 * Rows entering in one append batch get sequential 40ms delays. */
function stagger(rows: NodeListOf<Element> | Element[]): void {
  let i = 0
  for (const row of Array.from(rows)) {
    if (row.classList.contains('row-enter')) {
      ;(row as HTMLElement).style.animationDelay = `${i * 40}ms`
      i += 1
    }
  }
}

/* ── ⌘K command palette (navbar.gallery command bar + 21st.dev menu) ────
 * One input, fuzzy filter, keyboard-first. Actions call the app's real
 * handlers — the palette adds no second path to behavior. */
interface CmdkItem { id: string; label: string; hint: string; section: string; run: () => void }
const cmdkState = { open: false, items: [] as CmdkItem[], filtered: [] as CmdkItem[], selected: 0 }

function cmdkItems(): CmdkItem[] {
  const go = (view: string, label: string): CmdkItem => ({
    id: `view-${view}`, label, hint: 'view', section: 'Navigate',
    run: () => document.querySelector<HTMLElement>(`.activitybar .navitem[data-nav="${view}"]`)?.click(),
  })
  return [
    go('chat', 'Go to Chat'), go('overview', 'Go to Overview'),
    go('findings', 'Go to Findings'), go('crew', 'Go to Crew'), go('preview', 'Go to Preview'),
    {
      id: 'run-brief', label: 'Send the message / run the brief', hint: 'Enter', section: 'Run',
      run: () => {
        const input = byId<HTMLInputElement>('chatInput')
        if (input !== null && !deckRunning) { void handleRun(input.value.trim()) }
        else input?.focus()
      },
    },
    {
      id: 'abort', label: 'Abort the current run', hint: '', section: 'Run',
      run: () => { void handleAbort() },
    },
    {
      id: 'toggle-advanced', label: 'Open advanced options (goal / description)', hint: '', section: 'Run',
      run: () => {
        const t = byId<HTMLButtonElement>('advToggle')
        if (t !== null && byId<HTMLElement>('chatAdv')?.hidden === true) t.click()
        else byId<HTMLInputElement>('chatInput')?.focus()
      },
    },
    {
      id: 'open-preview', label: 'Open the build preview', hint: '', section: 'Output',
      run: () => { void handlePreviewOpen() },
    },
    {
      id: 'copy-run-id', label: 'Copy run id', hint: '', section: 'Output',
      run: () => {
        const id = byId<HTMLElement>('runIdChip')?.textContent ?? ''
        void navigator.clipboard?.writeText(id).catch(() => undefined)
      },
    },
    {
      id: 'add-model', label: 'Add a model to the pool', hint: '', section: 'Crew',
      run: () => {
        document.querySelector<HTMLElement>('.activitybar .navitem[data-nav="crew"]')?.click()
        byId<HTMLButtonElement>('addModelBtn')?.click()
      },
    },
  ]
}

function cmdkFilter(query: string): CmdkItem[] {
  const q = query.trim().toLowerCase()
  if (q === '') return cmdkState.items
  const scored: Array<{ item: CmdkItem; score: number }> = []
  for (const item of cmdkState.items) {
    const hay = `${item.label} ${item.section}`.toLowerCase()
    const idx = hay.indexOf(q)
    if (idx >= 0) { scored.push({ item, score: idx }); continue }
    // subsequence fallback: every query char must appear, in order
    let hi = 0
    let ok = true
    for (const ch of q) {
      hi = hay.indexOf(ch, hi)
      if (hi < 0) { ok = false; break }
      hi += 1
    }
    if (ok) scored.push({ item, score: 1000 + idx })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.map((s) => s.item)
}

function cmdkRenderList(): void {
  const list = byId<HTMLElement>('cmdkList')
  const input = byId<HTMLInputElement>('cmdkInput')
  if (list === null || input === null) return
  clearChildren(list)
  cmdkState.filtered = cmdkFilter(input.value)
  if (cmdkState.selected >= cmdkState.filtered.length) cmdkState.selected = 0
  let lastSection = ''
  cmdkState.filtered.forEach((item, i) => {
    if (item.section !== lastSection) {
      const head = document.createElement('div')
      head.className = 'cmdk-section'
      head.textContent = item.section
      list.appendChild(head)
      lastSection = item.section
    }
    const row = document.createElement('button')
    row.type = 'button'
    row.id = `cmdk-opt-${i}`
    row.className = `cmdk-item${i === cmdkState.selected ? ' on' : ''}`
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', i === cmdkState.selected ? 'true' : 'false')
    const label = document.createElement('span')
    label.textContent = item.label
    row.appendChild(label)
    if (item.hint !== '') {
      const hint = document.createElement('kbd')
      hint.textContent = item.hint
      row.appendChild(hint)
    }
    row.addEventListener('click', () => { cmdkClose(); item.run() })
    list.appendChild(row)
  })
  const active = byId<HTMLElement>(`cmdk-opt-${cmdkState.selected}`)
  if (active !== null) {
    input.setAttribute('aria-activedescendant', active.id)
    active.scrollIntoView({ block: 'nearest' })
  }
}

function cmdkOpen(): void {
  const overlay = byId<HTMLElement>('cmdkOverlay')
  const input = byId<HTMLInputElement>('cmdkInput')
  if (overlay === null || input === null) return
  cmdkState.open = true
  cmdkState.items = cmdkItems()
  cmdkState.selected = 0
  input.value = ''
  overlay.classList.remove('hidden')
  cmdkRenderList()
  input.focus()
}
function cmdkClose(): void {
  const overlay = byId<HTMLElement>('cmdkOverlay')
  if (overlay === null) return
  cmdkState.open = false
  overlay.classList.add('hidden')
}
function cmdkMove(delta: number): void {
  if (cmdkState.filtered.length === 0) return
  cmdkState.selected = (cmdkState.selected + delta + cmdkState.filtered.length) % cmdkState.filtered.length
  cmdkRenderList()
}
function initCmdk(): void {
  const hint = byId<HTMLButtonElement>('cmdkHint')
  const overlay = byId<HTMLElement>('cmdkOverlay')
  const input = byId<HTMLInputElement>('cmdkInput')
  if (hint === null || overlay === null || input === null) return
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
  const keyHint = hint.querySelector('.cmdk-keys')
  if (keyHint !== null) keyHint.textContent = isMac ? '⌘K' : 'Ctrl K'
  hint.addEventListener('click', cmdkOpen)
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cmdkClose() })
  input.addEventListener('input', () => { cmdkState.selected = 0; cmdkRenderList() })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdkMove(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkMove(-1) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const item = cmdkState.filtered[cmdkState.selected]
      if (item !== undefined) { cmdkClose(); item.run() }
    } else if (e.key === 'Escape') { e.preventDefault(); cmdkClose() }
  })
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      if (cmdkState.open) cmdkClose()
      else cmdkOpen()
    }
  })
}

const PHASE_CAPS: Record<string, string> = {
  idle: 'the crew is at rest',
  planning: 'laya routing + leader planning',
  building: 'engineers executing claimed tasks',
  auditing: 'security department scanning diffs',
  patching: 'remediation batches applying',
  reviewing: 'review agent diff-review',
  merging: 'merge engine assembling output',
  completed: 'run signed off — output ready',
  failed: 'run failed — check the event stream',
}

function renderOverviewStats(): void {
  const phase = byId<HTMLElement>('statPhase')
  if (phase !== null) phase.textContent = deckState.phase
  const phaseCap = byId<HTMLElement>('statPhaseCap')
  if (phaseCap !== null) phaseCap.textContent = PHASE_CAPS[deckState.phase] ?? ''
  const tokens = byId<HTMLElement>('statTokens')
  if (tokens !== null) tickTo(tokens, deckState.tokenSpend)
  // scaleX (GPU-composited) instead of width — the bar animates without layout.
  const bar = byId<HTMLElement>('tokenBar')
  if (bar !== null) bar.style.transform = `scaleX(${Math.min(1, deckState.tokenSpend / 2500).toFixed(3)})`
  const tasks = byId<HTMLElement>('statTasks')
  if (tasks !== null) {
    const done = deckState.tasks.filter((t) => t.status === 'completed').length
    tasks.textContent = `${done}/${deckState.tasks.length}`
  }
  const findings = byId<HTMLElement>('statFindings')
  if (findings !== null) findings.textContent = String(deckState.findings.length)
  const runChip = byId<HTMLElement>('runIdChip')
  if (runChip !== null) runChip.textContent = deckState.runId !== '' ? deckState.runId : 'IDLE'
  const runTitle = byId<HTMLElement>('runTitle')
  if (runTitle !== null) {
    runTitle.textContent = deckRunning
      ? 'Governed run in progress'
      : deckState.phase === 'completed'
        ? 'Run completed — output ready to preview'
        : 'Awaiting a brief — nothing is running'
  }
  const elapsedChip = byId<HTMLElement>('elapsedChip')
  if (elapsedChip !== null) elapsedChip.textContent = formatDuration(liveElapsedMs())
}

function renderRoutingNotes(holderId: string, emptyId: string | null): void {
  const holder = byId<HTMLElement>(holderId)
  if (holder === null) return
  const notes = deckState.routingNotes.slice(-20)
  const key = `feed:${holderId}`
  const mode = listMode(key, notes.length, notes[0] ?? '', notes[notes.length - 1] ?? '')
  if (mode === 'noop') return
  if (mode === 'rebuild') clearChildren(holder)
  const start = mode === 'append' ? renderedMarks.get(key)?.count ?? 0 : 0
  const empty = emptyId !== null ? byId<HTMLElement>(emptyId) : null
  if (empty !== null) empty.style.display = notes.length === 0 ? '' : 'none'
  const fresh: Element[] = []
  for (const note of notes.slice(start)) {
    const row = document.createElement('div')
    row.className = mode === 'append' ? 'feedrow row-enter' : 'feedrow'
    const tag = document.createElement('span')
    const src = feedTagFor(note)
    tag.className = `tg ${src.cls}`
    tag.textContent = src.tag
    const txt = document.createElement('span')
    txt.textContent = note
    row.appendChild(tag)
    row.appendChild(txt)
    holder.appendChild(row)
    fresh.push(row)
  }
  if (mode === 'append') stagger(fresh)
  renderedMarks.set(key, { count: notes.length, first: notes[0] ?? '', last: notes[notes.length - 1] ?? '' })
}

/** Chat rendering: the journal as a coding-chat transcript. Presentation
 * only — the reducer and bridge are untouched. */
function chatLineFor(event: DeckEvent): { who: string; text: string; kind: 'human' | 'engine' | 'system' | 'alert' } {
  // `run.started.human` is a renderer-local event (the user's turn, never
  // journaled) — handled before the typed switch, which only knows real
  // journal event types.
  if ((event as { type: string }).type === 'run.started.human') {
    return { who: 'you', text: String((event.payload as Record<string, unknown>)['message'] ?? ''), kind: 'human' }
  }
  const p = event.payload as Record<string, unknown>
  switch (event.type) {
    case 'run.started': {
      // Chat framing: the human's message is replayed as their own bubble,
      // then the crew replies — a conversation, not a run log.
      const goalState = p['goalState'] as string[] | undefined
      const goals = goalState ?? []
      const parts = ['On it.', 'Crew dispatched — routing your brief now.']
      if (goals.length > 0) parts.push(`I'll verify: ${goals.join(' · ')}.`)
      return { who: 'ruic', text: parts.join(' '), kind: 'engine' }
    }
    case 'laya.routed':
      return { who: 'laya', text: `Routing it ${String(p['decision'])} — complexity ${String(p['score'])}. ${String((p['reasons'] as string[] | undefined)?.[0] ?? '')}`, kind: 'system' }
    case 'task.claimed':
      return { who: 'crew', text: `${String(p['holder']) || 'engineer'} claimed ${String(p['taskId'])} → ${String(p['file'])}`, kind: 'engine' }
    case 'task.completed':
      return { who: 'crew', text: `${String(p['taskId'])} completed ✓`, kind: 'engine' }
    case 'task.failed':
      return { who: 'crew', text: `${String(p['taskId'])} failed ✗ — a TRY BOX entry was recorded`, kind: 'alert' }
    case 'finding.raised':
      return { who: 'security', text: `${SEV_GLYPH[String(p['severity'] ?? '')] ?? '◆'} ${String(p['severity'] ?? '').toUpperCase()} finding ${String(p['findingId'])}: ${String(p['message'])} (${String(p['path'])}:${String(p['line'])})`, kind: 'alert' }
    case 'finding.resolved':
      return { who: 'security', text: `Resolved ${String(p['findingId'])} ✓`, kind: 'engine' }
    case 'zeak.fallback':
      return { who: 'zeak', text: `Over cap — fell back ${String(p['from'])} → ${String(p['to'])} (${String(p['reason'])}). Re-escalation armed.`, kind: 'system' }
    case 'zeak.predictive_stop':
      return { who: 'zeak', text: `Stopped early — this approach already failed (${String(p['signature'])}). Guide: ${String(p['guide'])}`, kind: 'system' }
    case 'zeak.early_stop':
      return { who: 'zeak', text: `Early stop — checks passed and the contract is satisfied (${String(p['chunks'])} chunks)`, kind: 'system' }
    case 'zeak.escalation':
      return { who: 'zeak', text: `Security rejection escalated task to ${String(p['to'])} (attempt ${String(p['attempt'])})`, kind: 'system' }
    case 'learning.guide_added':
      return { who: 'learn', text: `New guide (${String(p['occurrences'])}x seen): ${String(p['guide'])}`, kind: 'system' }
    case 'learning.guide_rejected':
      return { who: 'learn', text: `Pattern rejected — ${String(p['reason'])} (${String(p['signature'])})`, kind: 'system' }
    case 'learning.pattern_found':
      return { who: 'learn', text: `Scanned the TRY BOX — ${String(p['candidates'])} recurring pattern(s) found`, kind: 'system' }
    case 'collector.collected':
      return { who: 'data', text: `Collected ${String(p['count'])} item(s) via ${String(p['via'])}: ${String(p['topic'])}`, kind: 'engine' }
    case 'phase.change':
      return { who: 'engine', text: `Phase → ${String(p['phase'])}`, kind: 'system' }
    case 'run.completed':
      return { who: 'ruic', text: `Done — ${String(p['fileCount'] ?? '')} file(s) merged, output ready to preview ✓`, kind: 'engine' }
    case 'run.failed':
      return { who: 'ruic', text: `That run failed: ${String(p['error'])}. I logged the pattern — won't repeat it.`, kind: 'alert' }
    case 'compaction.done':
      return { who: 'brain', text: `Compaction done — the Brain stayed small`, kind: 'system' }
    default:
      return { who: 'engine', text: `${event.type} ${JSON.stringify(event.payload).slice(0, 160)}`, kind: 'engine' }
  }
}

function renderStream(): void {
  const list = byId<HTMLElement>('streamList')
  if (list === null) return
  // Chat-worthy events only: preview.state/token.use are plumbing, not chat.
  const visible = deckEvents
    .filter((e) => e.type !== 'preview.state' && e.type !== 'token.use')
    .slice(-120)
  const mode = listMode('stream', visible.length, visible[0]?.id ?? '', visible[visible.length - 1]?.id ?? '')
  if (mode === 'noop') return
  const chat = byId<HTMLElement>('streamChat')
  // Autoscroll only when the reader is already at the foot — never yank a
  // reader who scrolled up to re-read.
  const nearBottom = chat === null ? true : chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80
  if (mode === 'rebuild') clearChildren(list)
  const mark = renderedMarks.get('stream')
  const start = mode === 'append' ? mark?.count ?? 0 : 0
  // A large batch is a reconstruction, not a conversation — no wall of motion.
  const animate = mode === 'append' && visible.length - start <= 8
  const empty = byId<HTMLElement>('chatEmpty')
  if (empty !== null) empty.style.display = visible.length === 0 ? '' : 'none'
  const fresh: Element[] = []
  for (const event of visible.slice(start)) {
    const line = chatLineFor(event)
    const row = document.createElement('div')
    row.className = `chatmsg ${line.kind}${animate ? ' row-enter' : ''}`
    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    avatar.textContent = line.who.slice(0, 4).toUpperCase()
    const body = document.createElement('div')
    body.className = 'body'
    const meta = document.createElement('div')
    meta.className = 'meta'
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = line.who
    const time = document.createElement('time')
    time.textContent = event.at.slice(11, 19)
    meta.appendChild(who)
    meta.appendChild(time)
    const tx = document.createElement('span')
    tx.className = 'tx'
    tx.textContent = line.text
    body.appendChild(meta)
    body.appendChild(tx)
    row.appendChild(avatar)
    row.appendChild(body)
    list.appendChild(row)
    fresh.push(row)
  }
  if (animate) stagger(fresh)
  renderedMarks.set('stream', { count: visible.length, first: visible[0]?.id ?? '', last: visible[visible.length - 1]?.id ?? '' })
  if (chat !== null && nearBottom) chat.scrollTop = chat.scrollHeight
}

/* ------------------------------------------------------------------ *
 * Run / abort
 * ------------------------------------------------------------------ */

/* ── Model pool: department-agnostic user-added models (localStorage) ── */
interface PoolModel {
  id: string
  provider: 'openai-compatible' | 'anthropic'
  endpoint: string
  model: string
  contextWindowTokens: number
  paramCountB: number | null
  free: boolean
}
type Assignments = Record<'lead' | 'eng' | 'sec1' | 'sec2', string | 'auto'>

const POOL_KEY = 'ruic.modelPool'
const ASSIGN_KEY = 'ruic.assignments'

function loadPool(): PoolModel[] {
  try {
    const raw = window.localStorage.getItem(POOL_KEY)
    const parsed = raw !== null ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}
function savePool(models: PoolModel[]): void {
  try { window.localStorage.setItem(POOL_KEY, JSON.stringify(models)) } catch { /* private mode */ }
}
function loadAssignments(): Assignments {
  try {
    const raw = window.localStorage.getItem(ASSIGN_KEY)
    return raw !== null ? { lead: 'auto', eng: 'auto', sec1: 'auto', sec2: 'auto', ...JSON.parse(raw) } : { lead: 'auto', eng: 'auto', sec1: 'auto', sec2: 'auto' }
  } catch { return { lead: 'auto', eng: 'auto', sec1: 'auto', sec2: 'auto' } }
}
function saveAssignments(a: Assignments): void {
  try { window.localStorage.setItem(ASSIGN_KEY, JSON.stringify(a)) } catch { /* private mode */ }
}

function renderModelPool(): void {
  const pool = byId<HTMLElement>('modelPool')
  if (pool === null) return
  clearChildren(pool)
  const models = loadPool()
  if (models.length === 0) {
    pool.innerHTML = '<div class="crew-empty">pool is empty — add a model above (local Ollama models are free and join the failover loop)</div>'
  }
  for (const m of models) {
    const card = document.createElement('div')
    card.className = 'panel'
    const head = document.createElement('div')
    head.className = 'phead'
    const name = document.createElement('span')
    name.textContent = m.id
    head.appendChild(name)
    const rm = document.createElement('button')
    rm.className = 'btn danger'
    rm.style.height = '22px'
    rm.style.padding = '0 9px'
    rm.textContent = 'remove'
    rm.addEventListener('click', () => {
      savePool(loadPool().filter((x) => x.id !== m.id))
      renderModelPool()
      renderAssignments()
    })
    head.appendChild(rm)
    card.appendChild(head)
    const body = document.createElement('div')
    body.className = 'pbody'
    const meta = document.createElement('div')
    meta.style.cssText = 'font:10.5px var(--mono);color:var(--muted);line-height:1.9'
    const params = m.paramCountB !== null ? `${m.paramCountB}B params · ` : ''
    meta.innerHTML = `${m.model}<br>${m.endpoint}<br>ctx ${m.contextWindowTokens.toLocaleString('en-US')} · ${params}${m.free ? '<span class="chip good" style="margin-left:4px">free</span>' : '<span class="chip warn" style="margin-left:4px">paid</span>'}`
    body.appendChild(meta)
    card.appendChild(body)
    pool.appendChild(card)
  }
}

const SEATS: Array<{ key: keyof Assignments; label: string }> = [
  { key: 'lead', label: 'lead (planner)' },
  { key: 'eng', label: 'engineer' },
  { key: 'sec1', label: 'security 1' },
  { key: 'sec2', label: 'security 2' },
]

function renderAssignments(): void {
  const grid = byId<HTMLElement>('assignGrid')
  if (grid === null) return
  clearChildren(grid)
  const models = loadPool()
  const assignments = loadAssignments()
  for (const seat of SEATS) {
    const card = document.createElement('div')
    card.className = 'stat'
    const lbl = document.createElement('div')
    lbl.className = 'lbl'
    lbl.textContent = seat.label
    card.appendChild(lbl)
    const sel = document.createElement('select')
    sel.className = 'assign-select'
    sel.dataset.seat = seat.key
    const auto = document.createElement('option')
    auto.value = 'auto'
    auto.textContent = 'AUTO — chosen by lead/Laya'
    sel.appendChild(auto)
    for (const m of models) {
      const opt = document.createElement('option')
      opt.value = m.id
      opt.textContent = `${m.id} (${m.model})`
      sel.appendChild(opt)
    }
    sel.value = assignments[seat.key]
    if (sel.value !== assignments[seat.key]) sel.value = 'auto'
    sel.addEventListener('change', () => {
      const a = loadAssignments()
      a[seat.key] = sel.value
      saveAssignments(a)
    })
    card.appendChild(sel)
    grid.appendChild(card)
  }
}

function defaultCrew(): BridgeCrew {
  // Common-S v2 roster: the local executor (Qwen via Ollama, free) is the
  // default first engineer AND both security scanners (Dept 5 is free by
  // design). The frontier lead stays paid — every call passes Zeak first.
  const local = {
    provider: 'openai-compatible' as const,
    endpoint: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:1.5b',
    contextWindowTokens: 32768,
  }
  // User assignments from the Model pool: an explicit pick takes the seat;
  // AUTO keeps the shipped default (lead/Laya decides).
  const pool = loadPool()
  const assignments = loadAssignments()
  const pick = (seat: keyof Assignments): BridgeModelRef | null => {
    const want = assignments[seat]
    if (want === 'auto') return null
    const m = pool.find((x) => x.id === want)
    if (m === undefined) return null
    return {
      id: m.id,
      provider: m.provider,
      endpoint: m.endpoint,
      model: m.model,
      contextWindowTokens: m.contextWindowTokens,
      ...(m.free ? {} : {}),
    }
  }
  const leadPick = pick('lead')
  const engPick = pick('eng')
  const sec1Pick = pick('sec1')
  const sec2Pick = pick('sec2')
  return {
    lead: leadPick ?? { id: 'lead', provider: 'openai-compatible', model: 'gpt-5', contextWindowTokens: 128000, speedClass: 'heavy' },
    engineers: [
      engPick ?? { id: 'eng-1', ...local, speedClass: 'standard' as const },
    ],
    security: [
      sec1Pick ?? { id: 'sec-1', ...local, speedClass: 'fast' as const },
      sec2Pick ?? { id: 'sec-2', ...local, speedClass: 'standard' as const },
    ],
  }
}

/** Surface an invoke failure in the UI instead of failing silently. */
function reportInvokeError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`${context} failed:`, error)
  const status = byId<HTMLDivElement>('bridgeStatus')
  if (status !== null) {
    const original = status.textContent
    status.textContent = `${context} failed: ${message}`
    status.classList.add('warn')
    window.setTimeout(() => {
      status.textContent = original
      status.classList.remove('warn')
    }, 6000)
  }
}

/** Chat-first run: an optional brief override from the chat input; the
 * Command view's brief/goal fields remain the fine-grained path. */
async function handleRun(briefOverride?: string): Promise<void> {
  const bridge = deckBridge
  if (bridge === undefined) return
  // Chat Box mode: the typed message is the brief. Advanced options (when
  // opened) supply the goal state and a description that is appended as
  // context — one pipeline either way.
  const message = briefOverride ?? byId<HTMLInputElement>('chatInput')?.value.trim() ?? ''
  const description = byId<HTMLTextAreaElement>('briefInput')?.value.trim() ?? ''
  const goalText = byId<HTMLInputElement>('goalInput')?.value ?? ''
  const goalState = goalText
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const brief = [
    message !== '' ? message : description !== '' ? description : 'untitled brief',
    description !== '' && message !== '' ? `\n\n[description] ${description}` : '',
  ].join('')
  const humanText = brief // what the "you" bubble shows
  const command: DeckInvokeCommand = {
    type: 'run',
    payload: {
      memoryDir: 'COMMONS',
      outputDir: 'OUTPUT',
      brief,
      goalState: goalState.length > 0 ? goalState : ['app builds'],
      crew: defaultCrew(),
    },
  }
  // The user's turn goes up as the first bubble. It is a renderer-local
  // event (id prefixed `human-`, never journaled — the journal keeps only
  // real engine events) that rides the same stream pipeline.
  if (humanText !== '') {
    ingest([{
      id: `human-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'run.started.human',
      payload: { message: humanText },
      at: new Date().toISOString(),
    } as unknown as DeckEvent])
  }
  try {
    const result = await bridge.invoke(command)
    if (!result.ok) reportInvokeError('Run', new Error(result.error))
  } catch (error) {
    reportInvokeError('Run', error)
  }
}

async function handleAbort(): Promise<void> {
  const bridge = deckBridge
  if (bridge === undefined) return
  try {
    const result = await bridge.invoke({ type: 'abort', payload: {} })
    if (!result.ok) reportInvokeError('Abort', new Error(result.error))
  } catch (error) {
    reportInvokeError('Abort', error)
  }
}

async function handlePreviewOpen(): Promise<void> {
  const bridge = deckBridge
  if (bridge === undefined) return
  await bridge.invoke({ type: 'preview', payload: { action: 'open', runId: deckState.runId } })
}

async function handlePreviewClose(): Promise<void> {
  const bridge = deckBridge
  if (bridge === undefined) return
  await bridge.invoke({ type: 'preview', payload: { action: 'close' } })
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function setStatus(text: string, connected: boolean): void {
  const status = byId<HTMLElement>('bridgeStatus')
  if (status !== null) {
    status.textContent = text
    status.className = `chip ${connected ? 'good' : 'dim'}`
  }
}/* View switcher: presentation-only navigation between the shell views. */
function initViews(): void {
  const navItems = document.querySelectorAll<HTMLElement>('.navitem')
  for (const item of Array.from(navItems)) {
    item.addEventListener('click', () => {
      const target = item.getAttribute('data-nav')
      if (target === null) return
      for (const other of Array.from(navItems)) {
        other.classList.toggle('on', other === item)
      }
      for (const view of Array.from(document.querySelectorAll<HTMLElement>('.view'))) {
        view.classList.toggle('on', view.id === `v-${target}`)
      }
    })
  }
}

function startTimer(): void {
  if (typeof window === 'undefined' || deckTimerHandle !== null) return
  // Visibility-gated: while the window is hidden nothing re-renders — the
  // 1s loop resumes (with a fresh render) on visibilitychange.
  if (document.hidden) return
  deckTimerHandle = window.setInterval(() => render(), 1000)
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (deckTimerHandle !== null) {
        clearInterval(deckTimerHandle)
        deckTimerHandle = null
      }
    } else {
      render()
      startTimer()
    }
  })
}

async function boot(): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.__deckBridge__ : undefined
  if (bridge === undefined) {
    setStatus('● bridge unavailable', false)
    deckReady = true
    return
  }
  deckBridge = bridge
  setStatus('● bridge live', true)

  // Subscribe FIRST (the first batch carries whatever history exists), then
  // replay. Dedupe by event id makes the overlap harmless.
  bridge.events.subscribe((batch) => ingest(batch.events))
  ingest(bridge.events.replay().events)

  await refreshCrewHealth()

  deckReady = true
  startTimer()
  render()
}

function mount(): void {
  initViews()
  initCmdk()
  initSpotlight()
  const heroCta = byId<HTMLButtonElement>('heroCta')
  if (heroCta !== null) {
    heroCta.addEventListener('click', () => byId<HTMLInputElement>('chatInput')?.focus())
  }
  // Verification hook (read-only): lets the UI test suite observe the
  // visibility-gated render loop without touching behavior.
  ;(window as unknown as Record<string, unknown>).__deckRenderState = () => ({
    paused: deckTimerHandle === null,
    hidden: document.hidden,
    ticker: Array.from(tickerState.entries()).map(([el, s]) => ({ id: el.id, from: s.from, to: s.to, raf: s.raf, tid: s.tid })),
  })
  renderModelPool()
  renderAssignments()
  const addModelBtn = byId<HTMLButtonElement>('addModelBtn')
  const addModelForm = byId<HTMLFormElement>('addModelForm')
  if (addModelBtn !== null && addModelForm !== null) {
    addModelBtn.addEventListener('click', () => {
      addModelForm.style.display = addModelForm.style.display === 'none' ? '' : 'none'
    })
  }
  const nmCancel = byId<HTMLButtonElement>('nmCancel')
  if (nmCancel !== null && addModelForm !== null) {
    nmCancel.addEventListener('click', () => { addModelForm.style.display = 'none' })
  }
  if (addModelForm !== null) {
    addModelForm.addEventListener('submit', (e) => {
      e.preventDefault()
      const val = (id: string): string => byId<HTMLInputElement>(id)?.value.trim() ?? ''
      const id = val('nmId')
      const model = val('nmModel')
      const endpoint = val('nmEndpoint')
      if (id.length === 0 || model.length === 0 || endpoint.length === 0) return
      const pool = loadPool().filter((m) => m.id !== id)
      pool.push({
        id,
        provider: (byId<HTMLSelectElement>('nmProvider')?.value ?? 'openai-compatible') as PoolModel['provider'],
        endpoint,
        model,
        contextWindowTokens: Number(val('nmCtx')) || 32768,
        paramCountB: val('nmParams') !== '' ? Number(val('nmParams')) : null,
        free: byId<HTMLInputElement>('nmFree')?.checked ?? false,
      })
      savePool(pool)
      if (addModelForm !== null) addModelForm.style.display = 'none'
      renderModelPool()
      renderAssignments()
    })
  }
  const chatForm = byId<HTMLFormElement>('chatForm')
  if (chatForm !== null) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault()
      const input = byId<HTMLInputElement>('chatInput')
      const text = input?.value.trim() ?? ''
      if (text.length === 0 && byId<HTMLTextAreaElement>('briefInput')?.value.trim() === '') return
      if (deckRunning) return
      if (input !== null) input.value = ''
      void handleRun(text)
    })
  }
  const chatAbort = byId<HTMLButtonElement>('chatAbortBtn')
  if (chatAbort !== null) chatAbort.addEventListener('click', () => { void handleAbort() })
  for (const quick of Array.from(document.querySelectorAll<HTMLButtonElement>('.quick'))) {
    quick.addEventListener('click', () => {
      const text = quick.getAttribute('data-quick') ?? ''
      if (text.length > 0 && !deckRunning) {
        const input = byId<HTMLInputElement>('chatInput')
        if (input !== null && input.value.trim() === '') input.value = text
        void handleRun(text)
      }
    })
  }

  // Advanced options: flip the composer between Chat Box and the
  // Goal/Description form. The panel is inside the card; the toggle owns
  // aria-expanded and the caret rotation.
  const advToggle = byId<HTMLButtonElement>('advToggle')
  const advPanel = byId<HTMLElement>('chatAdv')
  if (advToggle !== null && advPanel !== null) {
    advToggle.addEventListener('click', () => {
      const open = advPanel.hidden
      advPanel.hidden = !open
      advToggle.setAttribute('aria-expanded', String(open))
      advToggle.classList.toggle('open', open)
      // First open ever: prefill sensible defaults into the form.
      if (open) {
        const goal = byId<HTMLInputElement>('goalInput')
        if (goal !== null && goal.value === '') goal.value = 'app builds'
        const input = byId<HTMLInputElement>('chatInput')
        const desc = byId<HTMLTextAreaElement>('briefInput')
        if (desc !== null && desc.value === '' && input !== null && input.value.trim() !== '') {
          desc.value = input.value.trim()
        }
      }
      if (open) byId<HTMLInputElement>('goalInput')?.focus()
    })
  }

  const previewOpenBtn = byId<HTMLButtonElement>('previewOpenBtn')
  if (previewOpenBtn !== null) previewOpenBtn.addEventListener('click', () => { void handlePreviewOpen() })
  const previewCloseBtn = byId<HTMLButtonElement>('previewCloseBtn')
  if (previewCloseBtn !== null) previewCloseBtn.addEventListener('click', () => { void handlePreviewClose() })

  refresh()
  void boot()
}

/* ------------------------------------------------------------------ *
 * Expose internals (test hook) and auto-mount in a browser
 * ------------------------------------------------------------------ */

const internals: DeckRendererInternals = {
  reconstructState,
  appliedEventCount: () => deckApplied,
  currentState: () => deckState,
  isReady: () => deckReady,
  healthRefreshPending: () => deckHealthPending,
  mount,
}

globalThis.__deckInternals__ = internals
globalThis.__deckState__ = deckState

if (typeof window !== 'undefined') {
  window.__deckInternals__ = internals
  window.__deckState__ = deckState
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => mount())
    } else {
      mount()
    }
  }
}

