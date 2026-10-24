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

  const phaseStrip = byId<HTMLElement>('phaseStrip')
  if (phaseStrip !== null) {
    phaseStrip.textContent = `Phase: ${deckState.phase}`
    phaseStrip.className = `chip accent`
  }
  renderOverviewStats()

  const timer = byId<HTMLElement>('elapsedTimer')
  if (timer !== null) timer.textContent = formatDuration(liveElapsedMs())

  const tokens = byId<HTMLElement>('tokenSpend')
  if (tokens !== null) tokens.textContent = `Tokens: ${deckState.tokenSpend}`

  const runBtn = byId<HTMLButtonElement>('runBtn')
  if (runBtn !== null) runBtn.disabled = deckRunning

  const abortBtn = byId<HTMLButtonElement>('abortBtn')
  if (abortBtn !== null) abortBtn.disabled = !deckRunning

  const taskBody = byId<HTMLTableSectionElement>('taskBody')
  if (taskBody !== null) {
    clearChildren(taskBody)
    for (const task of deckState.tasks) {
      const row = document.createElement('tr')
      addCell(row, task.id)
      addCell(row, task.file)
      addCell(row, task.holder)
      addCell(row, task.status, `status-${task.status}`)
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
      sev.textContent = finding.resolved ? `${finding.severity} (resolved)` : finding.severity
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
  }

  // Common-S: routing + economic-layer visibility (Laya decisions, Zeak
  // fallbacks/early-stops, Data Collection) in the overview + findings feeds.
  const strip = byId<HTMLElement>('phaseStrip')
  if (strip !== null && deckState.routingNotes.length > 0) {
    strip.title = deckState.routingNotes.join('\n')
  }
  renderRoutingNotes('overviewRouting', 'overviewRoutingEmpty')
  renderRoutingNotes('routingFeedHolder', null)

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
  const roster = byId<HTMLElement>('crewRoster')
  if (roster !== null) {
    clearChildren(roster)
    for (const member of deckState.crewHealth) {
      const card = document.createElement('div')
      card.className = `crew-member ${member.healthy ? 'healthy' : 'unhealthy'}`
      const name = document.createElement('span')
      name.className = 'crew-name'
      name.textContent = `${member.id} (${member.role})`
      const status = document.createElement('span')
      status.className = 'crew-status'
      status.textContent = member.healthy ? 'healthy' : 'unhealthy'
      card.appendChild(name)
      card.appendChild(status)
      roster.appendChild(card)
    }
    if (deckState.crewHealth.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'crew-empty'
      empty.textContent = 'connecting...'
      roster.appendChild(empty)
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
    sbBridge.textContent = bridgeStatusEl.textContent !== null && bridgeStatusEl.textContent.startsWith('Bridge: connected') ? '● bridge live' : '● bridge down'
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
    chatPhase.className = `chip ${deckRunning ? 'accent pulse' : 'dim'}`
  }
  const chatPill = byId<HTMLElement>('chatPill')
  if (chatPill !== null) chatPill.style.display = deckRunning ? '' : 'none'
  const chatSend = byId<HTMLButtonElement>('chatSendBtn')
  if (chatSend !== null) chatSend.disabled = deckRunning
  const chatAbort = byId<HTMLButtonElement>('chatAbortBtn')
  if (chatAbort !== null) {
    chatAbort.disabled = !deckRunning
    chatAbort.classList.toggle('hidden', !deckRunning)
  }
  const chatAbortHint = byId<HTMLElement>('chatAbortHint')
  if (chatAbortHint !== null) chatAbortHint.style.display = deckRunning ? '' : 'none'
}

/* ── presentation helpers (view layer only — no bridge/logic changes) ── */

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
  if (tokens !== null) tokens.textContent = deckState.tokenSpend.toLocaleString('en-US')
  const bar = byId<HTMLElement>('tokenBar')
  if (bar !== null) bar.style.width = `${Math.min(100, Math.round(deckState.tokenSpend / 2500))}%`
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
  clearChildren(holder)
  const empty = emptyId !== null ? byId<HTMLElement>(emptyId) : null
  if (empty !== null) empty.style.display = deckState.routingNotes.length === 0 ? '' : 'none'
  for (const note of deckState.routingNotes.slice(-20)) {
    const row = document.createElement('div')
    row.className = 'feedrow'
    const tag = document.createElement('span')
    tag.className = 'tg'
    tag.textContent = note.startsWith('Laya') ? 'laya' : note.startsWith('Zeak') ? 'zeak' : note.startsWith('Learning') ? 'learn' : 'collector'
    const txt = document.createElement('span')
    txt.textContent = note
    row.appendChild(tag)
    row.appendChild(txt)
    holder.appendChild(row)
  }
}

/** Chat rendering: the journal as a coding-chat transcript. Presentation
 * only — the reducer and bridge are untouched. */
function chatLineFor(event: DeckEvent): { who: string; text: string; kind: 'engine' | 'system' | 'alert' } {
  const p = event.payload as Record<string, unknown>
  switch (event.type) {
    case 'run.started':
      return { who: 'crew', text: `Run opened — brief: "${String(p['brief'])}" · goals: ${JSON.stringify(p['goalState'])}`, kind: 'system' }
    case 'laya.routed':
      return { who: 'laya', text: `Routed ${String(p['decision'])} (complexity ${String(p['score'])}) — ${String((p['reasons'] as string[] | undefined)?.[0] ?? '')}`, kind: 'system' }
    case 'task.claimed':
      return { who: 'crew', text: `${String(p['holder']) || 'engineer'} claimed ${String(p['taskId'])} → ${String(p['file'])}`, kind: 'engine' }
    case 'task.completed':
      return { who: 'crew', text: `${String(p['taskId'])} completed ✓`, kind: 'engine' }
    case 'task.failed':
      return { who: 'crew', text: `${String(p['taskId'])} failed ✗ — a TRY BOX entry was recorded`, kind: 'alert' }
    case 'finding.raised':
      return { who: 'security', text: `${String(p['severity'] ?? '').toUpperCase()} finding ${String(p['findingId'])}: ${String(p['message'])} (${String(p['path'])}:${String(p['line'])})`, kind: 'alert' }
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
      return { who: 'crew', text: `Run completed ✓ — output ready to preview`, kind: 'engine' }
    case 'run.failed':
      return { who: 'engine', text: `Run failed: ${String(p['error'])}`, kind: 'alert' }
    case 'compaction.done':
      return { who: 'brain', text: `Compaction done — the Brain stayed small`, kind: 'system' }
    default:
      return { who: 'engine', text: `${event.type} ${JSON.stringify(event.payload).slice(0, 160)}`, kind: 'engine' }
  }
}

function renderStream(): void {
  const list = byId<HTMLElement>('streamList')
  if (list === null) return
  clearChildren(list)
  // Chat-worthy events only: preview.state/token.use are plumbing, not chat.
  const visible = deckEvents.filter((e) => e.type !== 'preview.state' && e.type !== 'token.use')
  const empty = byId<HTMLElement>('chatEmpty')
  if (empty !== null) empty.style.display = visible.length === 0 ? '' : 'none'
  for (const event of visible.slice(-120)) {
    const line = chatLineFor(event)
    const row = document.createElement('div')
    row.className = `chatmsg ${line.kind}`
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
  }
  const chat = byId<HTMLElement>('streamChat')
  if (chat !== null) chat.scrollTop = chat.scrollHeight
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
  const brief = briefOverride ?? byId<HTMLTextAreaElement>('briefInput')?.value.trim() ?? ''
  const goalText = byId<HTMLTextAreaElement>('goalInput')?.value ?? ''
  const goalState = goalText
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const command: DeckInvokeCommand = {
    type: 'run',
    payload: {
      memoryDir: 'COMMONS',
      outputDir: 'OUTPUT',
      brief: brief !== '' ? brief : 'untitled brief',
      goalState: goalState.length > 0 ? goalState : ['app builds'],
      crew: defaultCrew(),
    },
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
}

/* View switcher: presentation-only navigation between the shell views. */
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
  deckTimerHandle = window.setInterval(() => render(), 1000)
}

async function boot(): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.__deckBridge__ : undefined
  if (bridge === undefined) {
    setStatus('Bridge: unavailable', false)
    deckReady = true
    return
  }
  deckBridge = bridge
  setStatus('Bridge: connected', true)

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
  const runBtn = byId<HTMLButtonElement>('runBtn')
  const chatForm = byId<HTMLFormElement>('chatForm')
  if (chatForm !== null) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault()
      const input = byId<HTMLInputElement>('chatInput')
      const text = input?.value.trim() ?? ''
      if (text.length === 0 || deckRunning) return
      if (input !== null) input.value = ''
      void handleRun(text)
    })
  }
  const chatAbort = byId<HTMLButtonElement>('chatAbortBtn')
  if (chatAbort !== null) chatAbort.addEventListener('click', () => { void handleAbort() })
  for (const quick of Array.from(document.querySelectorAll<HTMLButtonElement>('.quick'))) {
    quick.addEventListener('click', () => {
      const text = quick.getAttribute('data-quick') ?? ''
      if (text.length > 0 && !deckRunning) void handleRun(text)
    })
  }
  if (runBtn !== null) runBtn.addEventListener('click', () => { void handleRun() })
  const abortBtn = byId<HTMLButtonElement>('abortBtn')
  if (abortBtn !== null) abortBtn.addEventListener('click', () => { void handleAbort() })

  const previewOpenBtn = byId<HTMLButtonElement>('previewOpenBtn')
  if (previewOpenBtn !== null) previewOpenBtn.addEventListener('click', () => { void handlePreviewOpen() })
  const previewCloseBtn = byId<HTMLButtonElement>('previewCloseBtn')
  if (previewCloseBtn !== null) previewCloseBtn.addEventListener('click', () => { void handlePreviewClose() })

  const brief = byId<HTMLTextAreaElement>('briefInput')
  if (brief !== null && brief.value === '') brief.value = 'build a trivial app'
  const goal = byId<HTMLTextAreaElement>('goalInput')
  if (goal !== null && goal.value === '') goal.value = 'app builds'

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

