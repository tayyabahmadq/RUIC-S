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
      default:
        break
    }
  }

  const elapsedMs =
    startedAt !== null && endedAt !== null ? Date.parse(endedAt) - Date.parse(startedAt) : 0

  return {
    runId,
    phase,
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
    phaseStrip.className = `phase-strip phase-${deckState.phase}`
  }

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

  /* ---- Preview surface (R16) ---- */
  const previewPanel = byId<HTMLElement>('previewPanel')
  const previewFileList = byId<HTMLElement>('previewFileList')
  const previewOpenBtn = byId<HTMLButtonElement>('previewOpenBtn')
  const previewCloseBtn = byId<HTMLButtonElement>('previewCloseBtn')

  if (previewPanel !== null) {
    if (deckPreviewOpen) {
      previewPanel.style.display = 'block'
      if (previewOpenBtn !== null) previewOpenBtn.disabled = true
      if (previewCloseBtn !== null) previewCloseBtn.disabled = false
    } else {
      previewPanel.style.display = 'none'
      if (previewOpenBtn !== null) previewOpenBtn.disabled = false
      if (previewCloseBtn !== null) previewCloseBtn.disabled = true
    }
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
      empty.textContent = 'connectingâ€¦'
      roster.appendChild(empty)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Run / abort
 * ------------------------------------------------------------------ */

function defaultCrew(): BridgeCrew {
  return {
    lead: { id: 'lead', provider: 'openai-compatible', model: 'gpt-5', contextWindowTokens: 128000, speedClass: 'heavy' },
    engineers: [
      { id: 'eng-1', provider: 'openai-compatible', model: 'gpt-5', contextWindowTokens: 128000, speedClass: 'standard' },
    ],
    security: [
      { id: 'sec-1', provider: 'openai-compatible', model: 'gpt-5-mini', contextWindowTokens: 128000, speedClass: 'fast' },
      { id: 'sec-2', provider: 'openai-compatible', model: 'claude-4', contextWindowTokens: 200000, speedClass: 'standard' },
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
    status.classList.add('status-error')
    window.setTimeout(() => {
      status.textContent = original
    }, 6000)
  }
}

async function handleRun(): Promise<void> {
  const bridge = deckBridge
  if (bridge === undefined) return
  const brief = byId<HTMLTextAreaElement>('briefInput')?.value.trim() ?? ''
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
    status.className = `status-indicator ${connected ? 'status-connected' : 'status-error'}`
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
  const runBtn = byId<HTMLButtonElement>('runBtn')
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

