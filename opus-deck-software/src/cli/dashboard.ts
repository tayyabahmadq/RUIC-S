/**
 * Phase 10: dashboard renderers (driven only by bus events).
 */
export interface DashboardState {
  runId: string
  phase: string
  events: Array<{ type: string; payload: unknown; at: string }>
}

export function renderDashboard(state: DashboardState): string {
  const lines: string[] = []
  lines.push(`Run: ${state.runId}`)
  lines.push(`Phase: ${state.phase}`)
  lines.push(`Events: ${state.events.length}`)
  for (const e of state.events.slice(-20)) {
    lines.push(`  [${e.type}] ${JSON.stringify(e.payload)}`)
  }
  return lines.join('\n')
}

export function replayFromDelta(events: readonly [string, unknown][], runId: string): DashboardState {
  return {
    runId,
    phase: 'plan',
    events: events.map(([type, payload], i) => ({ id: String(i), type, payload, at: new Date().toISOString() })),
  }
}
